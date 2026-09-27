import type { Database } from '../db/database.ts';
import type { Track, Transition } from '../domain/enums.ts';
import type { Timeline, TimelineItem } from '../domain/types.ts';
import { timelineItemPatch } from '../domain/inputs.ts';
import { newId } from '../lib/ids.ts';
import { parseOrThrow } from '../lib/schema.ts';
import { flag, nowIso, requireRow } from './base.ts';

export interface NewTimelineItem {
  track: Track;
  position?: number;
  assetId?: string | null;
  sourceType: string;
  sourceId: string;
  label: string;
  startSec: number;
  durationSec: number;
  trimInSec?: number;
  volumeDb?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  transition?: Transition;
  loop?: boolean;
  manual?: boolean;
}

export class TimelineRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  forStory(storyId: string): Timeline | undefined {
    return this.db.get<Timeline>('SELECT * FROM timelines WHERE story_id = ?', storyId);
  }

  ensure(storyId: string, fps: number): Timeline {
    const existing = this.forStory(storyId);
    if (existing) return existing;
    const id = newId('tl');
    const now = nowIso();
    this.db.insert('timelines', { id, story_id: storyId, fps, created_at: now, updated_at: now });
    return requireRow<Timeline>(this.db, 'timelines', id);
  }

  items(timelineId: string, track?: Track): TimelineItem[] {
    return track
      ? this.db.all<TimelineItem>(
          'SELECT * FROM timeline_items WHERE timeline_id = ? AND track = ? ORDER BY start_sec, position',
          timelineId,
          track,
        )
      : this.db.all<TimelineItem>(
          'SELECT * FROM timeline_items WHERE timeline_id = ? ORDER BY track, start_sec, position',
          timelineId,
        );
  }

  getItem(id: string): TimelineItem {
    return requireRow<TimelineItem>(this.db, 'timeline_items', id, 'Timeline item');
  }

  addItem(timelineId: string, i: NewTimelineItem): TimelineItem {
    const id = newId('tli');
    const now = nowIso();
    this.db.insert('timeline_items', {
      id,
      timeline_id: timelineId,
      track: i.track,
      position: i.position ?? 0,
      asset_id: i.assetId ?? null,
      source_type: i.sourceType,
      source_id: i.sourceId,
      label: i.label,
      start_sec: round(i.startSec),
      duration_sec: round(i.durationSec),
      trim_in_sec: round(i.trimInSec ?? 0),
      volume_db: i.volumeDb ?? 0,
      fade_in_sec: i.fadeInSec ?? 0,
      fade_out_sec: i.fadeOutSec ?? 0,
      transition: i.transition ?? 'cut',
      loop: flag(i.loop),
      manual: flag(i.manual),
      created_at: now,
      updated_at: now,
    });
    return this.getItem(id);
  }

  /** Manual edit from the editor. Marks the item manual so automatic rebuilds keep it. */
  updateItem(id: string, patch: unknown): TimelineItem {
    this.getItem(id);
    const v = parseOrThrow(timelineItemPatch, patch, 'timeline item');
    const values: Record<string, string | number> = { manual: 1, updated_at: nowIso() };
    for (const [k, val] of Object.entries(v))
      if (val !== undefined) values[k] = typeof val === 'number' ? round(val) : val;
    this.db.update('timeline_items', id, values);
    return this.getItem(id);
  }

  deleteItem(id: string): void {
    this.db.run('DELETE FROM timeline_items WHERE id = ?', id);
  }

  /** Remove automatically placed items; manual items survive rebuilds. */
  clearAutomatic(timelineId: string): void {
    this.db.run('DELETE FROM timeline_items WHERE timeline_id = ? AND manual = 0', timelineId);
  }

  touch(timelineId: string): void {
    this.db.run('UPDATE timelines SET updated_at = ? WHERE id = ?', nowIso(), timelineId);
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

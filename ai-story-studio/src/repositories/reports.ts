import type { Database } from '../db/database.ts';
import type { ExportFormat, QualityReportKind } from '../domain/enums.ts';
import { REVIEW_CHECKLIST } from '../domain/enums.ts';
import type {
  ExportRecord,
  Finding,
  QualityReport,
  ReviewChecklistItem,
  SimilarityReport,
  StoryPackageImport,
} from '../domain/types.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { flag, nowIso, requireRow } from './base.ts';

export function statusFromFindings(findings: Finding[]): 'pass' | 'warn' | 'fail' {
  if (findings.some((f) => f.severity === 'fail')) return 'fail';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  return 'pass';
}

export class ReportRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // --- Quality reports ------------------------------------------------------------

  saveQuality(
    storyId: string,
    kind: QualityReportKind,
    findings: Finding[],
    exportId: string | null = null,
  ): QualityReport {
    const id = newId('qr');
    this.db.insert('quality_reports', {
      id,
      story_id: storyId,
      export_id: exportId,
      kind,
      status: statusFromFindings(findings),
      findings_json: JSON.stringify(findings),
      created_at: nowIso(),
    });
    return requireRow<QualityReport>(this.db, 'quality_reports', id);
  }

  latestQuality(storyId: string): QualityReport[] {
    return this.db.all<QualityReport>(
      `SELECT q.* FROM quality_reports q
       WHERE q.story_id = ? AND q.rowid = (SELECT q2.rowid FROM quality_reports q2 WHERE q2.story_id = q.story_id AND q2.kind = q.kind ORDER BY q2.created_at DESC, q2.rowid DESC LIMIT 1)
       ORDER BY q.kind`,
      storyId,
    );
  }

  qualityForExport(exportId: string): QualityReport[] {
    return this.db.all<QualityReport>(
      'SELECT * FROM quality_reports WHERE export_id = ? ORDER BY kind',
      exportId,
    );
  }

  // --- Similarity reports -----------------------------------------------------------

  replaceSimilarity(
    storyId: string,
    rows: Array<Omit<SimilarityReport, 'id' | 'story_id' | 'created_at'>>,
  ): SimilarityReport[] {
    this.db.transaction(() => {
      this.db.run('DELETE FROM similarity_reports WHERE story_id = ?', storyId);
      for (const r of rows)
        this.db.insert('similarity_reports', {
          id: newId('sim'),
          story_id: storyId,
          ...r,
          created_at: nowIso(),
        });
    });
    return this.similarity(storyId);
  }

  similarity(storyId: string): SimilarityReport[] {
    return this.db.all<SimilarityReport>(
      'SELECT * FROM similarity_reports WHERE story_id = ? ORDER BY story_similarity + dialogue_similarity + narration_similarity DESC',
      storyId,
    );
  }

  // --- Human review checklist -------------------------------------------------------

  checklist(storyId: string): Array<ReviewChecklistItem & { label: string }> {
    const rows = new Map(
      this.db
        .all<ReviewChecklistItem>('SELECT * FROM review_checklist_items WHERE story_id = ?', storyId)
        .map((r) => [r.item_key, r]),
    );
    return REVIEW_CHECKLIST.map((item) => {
      const row = rows.get(item.key);
      return {
        id: row?.id ?? '',
        story_id: storyId,
        item_key: item.key,
        checked: row?.checked ?? 0,
        note: row?.note ?? '',
        checked_at: row?.checked_at ?? null,
        label: item.label,
      };
    });
  }

  setChecklistItem(storyId: string, key: string, checked: boolean, note = ''): void {
    if (!REVIEW_CHECKLIST.some((i) => i.key === key))
      throw new AppError('VALIDATION_FAILED', `Unknown checklist item ${key}`);
    this.db.run(
      `INSERT INTO review_checklist_items (id, story_id, item_key, checked, note, checked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(story_id, item_key) DO UPDATE SET checked = excluded.checked, note = excluded.note, checked_at = excluded.checked_at`,
      newId('rci'),
      storyId,
      key,
      flag(checked),
      note.slice(0, 1000),
      checked ? nowIso() : null,
    );
  }

  checklistComplete(storyId: string): boolean {
    return this.checklist(storyId).every((i) => i.checked === 1);
  }

  // --- Exports ------------------------------------------------------------------------

  createExport(
    storyId: string,
    format: ExportFormat,
    width: number,
    height: number,
    fps: number,
    isMock: boolean,
  ): ExportRecord {
    const id = newId('exp');
    this.db.insert('exports', {
      id,
      story_id: storyId,
      format,
      width,
      height,
      fps,
      status: 'building',
      is_mock: flag(isMock),
      created_at: nowIso(),
    });
    return this.getExport(id);
  }

  getExport(id: string): ExportRecord {
    return requireRow<ExportRecord>(this.db, 'exports', id, 'Export');
  }

  updateExport(id: string, values: Partial<Omit<ExportRecord, 'id'>>): void {
    this.db.update('exports', id, values);
  }

  exports(storyId?: string): ExportRecord[] {
    return storyId
      ? this.db.all<ExportRecord>(
          'SELECT * FROM exports WHERE story_id = ? ORDER BY created_at DESC',
          storyId,
        )
      : this.db.all<ExportRecord>('SELECT * FROM exports ORDER BY created_at DESC LIMIT 100');
  }

  // --- Story package imports ---------------------------------------------------------

  recordImport(values: Omit<StoryPackageImport, 'id' | 'created_at'>): StoryPackageImport {
    const id = newId('imp');
    this.db.insert('story_package_imports', { id, ...values, created_at: nowIso() });
    return requireRow<StoryPackageImport>(this.db, 'story_package_imports', id);
  }

  imports(limit = 50): StoryPackageImport[] {
    return this.db.all<StoryPackageImport>(
      'SELECT * FROM story_package_imports ORDER BY created_at DESC LIMIT ?',
      limit,
    );
  }
}

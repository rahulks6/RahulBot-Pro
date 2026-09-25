import type { Studio } from '../app/studio.ts';
import { AppError } from '../lib/errors.ts';
import { REVIEW_CHECKLIST } from '../domain/enums.ts';
import { importStoryPackage } from '../services/story-package.ts';
import { suggestShotSfx } from '../services/sfx-suggest.ts';
import { DEMO_EPISODE_1, DEMO_EPISODE_2 } from './demo-packages.ts';

export interface DemoResult {
  projectId: string;
  episode1: string;
  episode2: string;
  exportId: string;
  exportStatus: string;
  batches: number;
  simulatedCostInr: number;
}

/**
 * Build the Phase 1 demo entirely in mock mode (₹0): imports two Story
 * Packages, generates and reviews mock references, images and clips
 * (including a rejected image, a failed-then-retried clip and a regenerate),
 * generates mock voices / music / SFX / ambience, builds the timeline, runs
 * BUILD FINAL and the quality + similarity checks.
 */
export async function seedDemo(
  studio: Studio,
  log: (msg: string) => void = () => undefined,
): Promise<DemoResult> {
  if (!studio.env.mockGeneration)
    throw new AppError('MOCK_MODE_REQUIRED', 'The demo only runs with MOCK_GENERATION=true');
  let batches = 0;
  let cost = 0;
  const run = async (label: string): Promise<void> => {
    const r = await studio.generation.processQueue();
    batches++;
    cost += r.simulatedCostInr;
    log(
      `${label}: ${r.completed} complete, ${r.failed} failed, ${r.gpuSessions} GPU session(s) on ${studio.gpu.currentProvider.id}, ₹${r.simulatedCostInr} simulated`,
    );
  };

  const ep1 = importStoryPackage(studio, DEMO_EPISODE_1);
  const projectId = ep1.projectId;
  log(`Imported episode 1 into project ${projectId}`);

  // Character references → approve → Character Lock (Pip) ------------------
  const pip = studio.characters.findByName(projectId, 'Pip')!;
  const luma = studio.characters.findByName(projectId, 'Luma')!;
  for (const c of [pip, luma]) {
    for (const [slot_type, slot] of [
      ['view', 'front'],
      ['view', 'three_quarter'],
      ['view', 'face_closeup'],
      ['expression', 'happy'],
      ['pose', 'walking'],
    ] as const) {
      studio.generation.queueReference(
        { type: 'character', id: c.id },
        { slot_type, slot },
        { mode: 'fast_preview' },
      );
    }
  }
  const raincoat = studio.characters.listVariants(pip.id)[0]!;
  studio.generation.queueReference(
    { type: 'character', id: pip.id },
    { slot_type: 'view', slot: 'full_body', variant_id: raincoat.id },
    { mode: 'fast_preview' },
  );
  const grove = studio.characters.listLocations(projectId)[0]!;
  studio.generation.queueReference(
    { type: 'location', id: grove.id },
    { slot_type: 'view', slot: 'wide' },
    { mode: 'fast_preview' },
  );
  await run('References');
  for (const c of [pip, luma]) {
    for (const ref of studio.characters.listReferences(c.id)) {
      if (ref.slot !== 'walking') studio.characters.setReferenceApproval(ref.id, true);
    }
  }
  for (const ref of studio.assets.listReferences('location', grove.id))
    studio.assets.setReferenceApproved(ref.id, true);
  studio.characters.lock(pip.id);
  studio.characters.lockVoice(pip.voice_profile_id!);
  studio.characters.lockVoice(luma.voice_profile_id!);
  studio.characters.lockLocation(grove.id);
  const narratorId = studio.projects.get(projectId).narrator_voice_id!;
  studio.characters.lockVoice(narratorId);
  log('Approved references; locked Pip, Whispering Willow Grove and all voices');

  // Suggested SFX (need review) ------------------------------------------------
  const shots = studio.stories.listStoryShots(ep1.storyId);
  for (const shot of shots) {
    const scene = studio.stories.getScene(shot.scene_id);
    const existing = studio.stories.listShotSfx(shot.id).map((c) => c.tag);
    for (const tag of suggestShotSfx(shot, scene, grove, existing))
      studio.stories.addShotSfx(shot.id, tag, { source: 'suggested' });
  }
  const suggestions = shots.flatMap((s) =>
    studio.stories.listShotSfx(s.id).filter((c) => c.source === 'suggested'),
  );
  suggestions.forEach((c, i) => studio.stories.setShotSfxApproval(c.id, i % 2 === 0)); // approve some, leave others for review

  // Images (image-first) -------------------------------------------------------
  for (const shot of shots) studio.generation.queueImage(shot.id);
  await run('Images');
  const firstImage = (id: string) =>
    studio.jobs.attemptsForShot(id, 'image').find((a) => a.status === 'succeeded')!;
  // Reject shot 2's first image and regenerate it with a new seed.
  const shot2 = shots[1]!;
  studio.generation.rejectAttempt(firstImage(shot2.id).id);
  studio.generation.regenerate(shot2.id, 'image', { seed: 'new' });
  await run('Regenerate rejected image');
  for (const shot of shots) {
    const candidate = studio.jobs
      .attemptsForShot(shot.id, 'image')
      .find((a) => a.status === 'succeeded' && a.approval === 'pending');
    if (candidate) studio.generation.approveAttempt(candidate.id);
  }
  log('Reviewed images (1 rejected + regenerated)');

  // Clips: one clip fails on its first attempt and succeeds on retry ----------
  shots.forEach((shot, i) =>
    studio.generation.queueVideo(shot.id, i === 2 ? { params: { mockFailAttempts: 1 } } : {}),
  );
  await run('Clips');
  for (const shot of shots) {
    const ok = studio.jobs
      .attemptsForShot(shot.id, 'video')
      .find((a) => a.status === 'succeeded' && a.approval === 'pending');
    if (ok) studio.generation.approveAttempt(ok.id);
  }
  log('Approved clips');

  // Mark the establishing shot reusable as a series asset.
  const est = studio.stories.getShot(shots[0]!.id);
  if (est.approved_video_asset_id)
    studio.assets.setLibraryFlags(est.approved_video_asset_id, {
      reusable: true,
      continuityTag: 'establishing',
      tags: 'grove establishing',
    });

  // BUILD FINAL (generates missing audio, lip sync, timeline, mix, validation)
  const exp = await studio.exports.buildFinal(ep1.storyId, 'landscape');
  log(`BUILD FINAL: ${exp.status}${exp.error_message ? ` — ${exp.error_message}` : ''}`);

  // Human review checklist: partially complete, to show the gate.
  REVIEW_CHECKLIST.slice(0, 6).forEach((item) =>
    studio.reports.setChecklistItem(ep1.storyId, item.key, true),
  );

  // Episode 2 (drafted, not produced) + quality and similarity reports ---------
  const ep2 = importStoryPackage(studio, DEMO_EPISODE_2, { projectId });
  await studio.quality.runAll(ep1.storyId);
  await studio.quality.runAll(ep2.storyId);
  log('Imported episode 2; ran quality and similarity checks');

  return {
    projectId,
    episode1: ep1.storyId,
    episode2: ep2.storyId,
    exportId: exp.id,
    exportStatus: exp.status,
    batches,
    simulatedCostInr: Math.round(cost * 100) / 100,
  };
}

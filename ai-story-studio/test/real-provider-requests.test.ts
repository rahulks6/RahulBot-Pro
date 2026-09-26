import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { encodePng } from '../src/media/png.ts';
import type { WorkerClient, WorkerJob, WorkerModel } from '../src/providers/worker/client.ts';
import { WorkerImageModel, WorkerVideoModel } from '../src/providers/worker/providers.ts';
import { seedSmall, testStudio } from './helpers.ts';

/**
 * What the app sends to a REAL model (local GPU or cloud worker), checked at the request level:
 * approved character references (identity), the GPU memory policy from Settings, the quality
 * preset, camera movement — and that the worker's decisions are stored on the attempt.
 */
const model = (kind: WorkerModel['kind'], id: string): WorkerModel => ({
  id,
  kind,
  display_name: id,
  version: 'main',
  license: 'test',
  min_vram_gb: 8,
  device: 'cuda',
  mock: false,
  loaded: false,
  default: true,
});

function stubClient(sent: Array<{ path: string; body: Record<string, unknown> }>): WorkerClient {
  return {
    run: async (path: string, body: Record<string, unknown>) => {
      sent.push({ path, body });
      const video = path.includes('video');
      const job: WorkerJob = {
        id: `job_${sent.length}`,
        kind: video ? 'image-to-video' : 'image',
        status: 'complete',
        progress: 1,
        message: '',
        model: { id: String(body['model']), version: 'main', mock: false },
        outputs: [],
        metrics: { run_seconds: 12, peak_vram_mb: 7321, estimated_vram_gb: 7.5 },
        error: null,
        logs: [],
        details: {
          memory: { offload: 'sequential', adjustments: ['CPU offload: sequential'] },
          reference: { mode: 'ip_adapter', images: 2 },
        },
      };
      const data = video
        ? Buffer.from('000000186674797069736f6d0000000069736f6d', 'hex')
        : encodePng(64, 36, () => [10, 20, 30]);
      return {
        job,
        files: [
          {
            meta: {
              name: video ? 'clip.mp4' : 'image.png',
              mime: video ? 'video/mp4' : 'image/png',
              size: data.length,
              sha256: '',
              width: 1344,
              height: 768,
              duration_sec: video ? 4 : null,
              fps: video ? 30 : null,
              native_resolution: false,
              mock: false,
            },
            data,
          },
        ],
      };
    },
  } as unknown as WorkerClient;
}

describe('requests to real models', () => {
  const s = testStudio({ env: { mockGeneration: false } });
  after(() => s.cleanup());
  // Providers are injected directly below: no execution router (no RunPod, no local worker).
  s.settings.set('execution', { ...s.settings.get('execution'), mode: 'mock' });
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  s.providers.image = new WorkerImageModel(stubClient(sent), model('image', 'sdxl-base'));
  s.providers.video = new WorkerVideoModel(stubClient(sent), model('video', 'wan2.2-ti2v-5b'));
  const { ari, shots } = seedSmall(s);
  const shot = shots[0]!;

  it('sends the approved character references (face / front first), the memory policy and the preset', async () => {
    // Approved references of Ari, in an order that is NOT identity-first.
    const slots: Array<[string, string]> = [
      ['pose', 'running'],
      ['view', 'side'],
      ['view', 'face_closeup'],
      ['view', 'front'],
    ];
    for (const [i, [slot_type, slot]] of slots.entries()) {
      const ref = await s.assets.createReference(
        ari.project_id,
        'character',
        ari.id,
        encodePng(8 + i, 8, () => [i, i, i]),
        'png',
        'image/png',
        `${slot_type}:${slot}`,
        false,
      );
      const cref = s.characters.addReference(ari.id, ref, { slot_type, slot });
      s.characters.setReferenceApproval(cref.id, true);
    }
    s.settings.set('execution', {
      ...s.settings.get('execution'),
      cpuOffload: 'sequential',
      maxVramPercent: 70,
      allowQualityReduction: true,
    });
    s.generation.queueImage(shot.id, { mode: 'fast_preview' });
    const r = await s.generation.processQueue();
    assert.equal(r.completed, 1, r.messages.join(' '));

    const body = sent[0]!.body;
    assert.equal(sent[0]!.path, '/generate/image');
    assert.equal(body['quality'], 'fast_preview', 'quality preset reaches the model');
    const refs = body['reference_images'] as string[];
    assert.equal(refs.length, 3, 'at most 3 references');
    const widthOf = (b64: string) => Buffer.from(b64, 'base64').readUInt32BE(16);
    assert.deepEqual(
      refs.map(widthOf).sort((a, b) => a - b),
      [9, 10, 11],
      'face and front views (and the side view), not the running pose',
    );
    assert.ok(
      typeof body['init_image'] === 'string',
      'image-to-image fallback for models without IP-Adapter',
    );
    assert.deepEqual((body['settings'] as Record<string, unknown>)['memory'], {
      max_vram_percent: 70,
      cpu_offload: 'sequential',
      vae_tiling: 'auto',
      attention: 'auto',
      auto_unload: true,
      allow_quality_reduction: true,
    });

    const attempt = s.jobs.attemptsForShot(shot.id, 'image')[0]!;
    assert.equal(attempt.is_mock, 0);
    assert.equal(attempt.model, 'sdxl-base');
    const settings = JSON.parse(attempt.settings_json) as Record<string, unknown>;
    assert.equal(settings['peakVramMb'], 7321, 'measured VRAM kept on the attempt');
    assert.deepEqual((settings['worker'] as Record<string, unknown>)['reference'], {
      mode: 'ip_adapter',
      images: 2,
    });
    assert.ok(JSON.parse(attempt.references_json).length >= 3, 'references recorded for consistency review');
    const asset = s.assets.get(attempt.output_asset_id!);
    assert.equal(asset.is_mock, 0);
    assert.equal(asset.is_native_resolution, 0, 'lower-resolution output is marked as not native');
  });

  it('video: animates the approved image with the camera movement and motion strength', async () => {
    s.stories.updateShot(shot.id, { camera_movement: 'slow push-in' });
    const attempt = s.jobs.attemptsForShot(shot.id, 'image')[0]!;
    s.generation.approveAttempt(attempt.id);
    s.settings.set('generation', { ...s.settings.get('generation'), upscaleOptimizedOutput: false });
    s.generation.queueVideo(shot.id);
    const r = await s.generation.processQueue();
    assert.equal(r.completed, 1, r.messages.join(' '));
    const body = sent.find((x) => x.path === '/generate/image-to-video')!.body;
    assert.equal(body['camera_movement'], 'slow push-in');
    assert.equal(body['motion_strength'], 0.5);
    assert.ok(
      typeof body['image'] === 'string' && (body['image'] as string).length > 20,
      'the approved still',
    );
  });
});

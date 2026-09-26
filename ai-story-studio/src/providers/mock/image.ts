import { encodePng, decodeSimplePng } from '../../media/png.ts';
import { prng, seedFrom } from '../../lib/hash.ts';
import type { QualityMode } from '../../domain/enums.ts';
import type {
  ImageModel,
  ImageRequest,
  ModelResult,
  RunContext,
  Upscaler,
  UpscaleRequest,
  VideoModel,
  VideoRequest,
} from '../types.ts';
import { ProviderError } from '../types.ts';
import { MOCK_VIDEO_MIME, maybeFail, mockInfo, simulatedSeconds, type MockOptions } from './common.ts';

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Resolution the mock model "natively" generates at for each quality mode. */
export function mockNativeSize(
  width: number,
  height: number,
  quality: QualityMode,
): { w: number; h: number } {
  const scale = quality === 'fast_preview' ? 0.25 : quality === 'optimized' ? 0.5 : 1;
  return { w: Math.max(16, Math.round(width * scale)), h: Math.max(16, Math.round(height * scale)) };
}

/**
 * MockImageModel — paints a deterministic placeholder still (sky gradient,
 * ground, one blob per referenced character). Clearly not a real render.
 */
export class MockImageModel implements ImageModel {
  readonly info = mockInfo('mock-image', 'Mock image model', 'cloud_gpu', 12);
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  async generate(req: ImageRequest, ctx: RunContext): Promise<ModelResult> {
    maybeFail(ctx, req.settings, this.opts.failureRate, 'IMAGE_GENERATION_FAILED');
    const { w, h } = mockNativeSize(req.width, req.height, req.quality);
    const rand = prng(seedFrom(`${req.prompt}|${req.seed}`));
    const hue = rand() * 360;
    const sky1 = hsl(hue, 0.55, 0.72);
    const sky2 = hsl((hue + 40) % 360, 0.5, 0.45);
    const ground = hsl((hue + 120) % 360, 0.35, 0.35);
    const characters = req.references.filter((r) => r.role === 'character');
    const blobs = (characters.length ? characters : [{ label: 'subject' }]).map((c, i, arr) => ({
      cx: ((i + 1) / (arr.length + 1)) * w,
      cy: h * (0.62 + rand() * 0.08),
      r: Math.min(w, h) * (0.1 + rand() * 0.05),
      color: hsl(seedFrom(c.label) % 360, 0.65, 0.55),
    }));
    const horizon = h * (0.6 + rand() * 0.1);
    const png = encodePng(w, h, (x, y) => {
      for (const b of blobs) {
        const dx = x - b.cx;
        const dy = y - b.cy;
        if (dx * dx + dy * dy < b.r * b.r) return b.color;
      }
      if (y > horizon) return ground;
      const t = y / horizon;
      return [
        Math.round(sky1[0] * (1 - t) + sky2[0] * t),
        Math.round(sky1[1] * (1 - t) + sky2[1] * t),
        Math.round(sky1[2] * (1 - t) + sky2[2] * t),
      ];
    });
    const base = req.quality === 'fast_preview' ? 4 : req.quality === 'optimized' ? 9 : 22;
    return {
      file: { data: png, mime: 'image/png', ext: 'png', width: w, height: h },
      model: this.info.id,
      modelVersion: this.info.modelVersion,
      generationSeconds: simulatedSeconds(base, ctx.attemptKey),
      isNativeResolution: w === req.width && h === req.height,
      settings: {
        mode: req.mode,
        quality: req.quality,
        requested: `${req.width}x${req.height}`,
        generated: `${w}x${h}`,
      },
      logs: [`mock image ${w}x${h} seed=${req.seed} refs=${req.references.length}`],
    };
  }
}

export interface MockVideoManifest {
  format: 'ai-story-studio/mock-video';
  version: 1;
  note: string;
  sourceImageKey: string;
  motionPrompt: string;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  frames: number;
  seed: number;
  upscaledFrom?: string;
  lipSync?: { audioChecksum: string; originalVideoKey?: string };
}

/**
 * MockVideoModel — "animates" an approved image by writing a JSON manifest
 * describing the clip (source still, motion, duration, fps). No real video is
 * encoded in Phase 1; the UI renders the source still with a simulated pan.
 */
export class MockVideoModel implements VideoModel {
  readonly info = mockInfo('mock-video', 'Mock image-to-video model', 'cloud_gpu', 24);
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  async animate(req: VideoRequest, ctx: RunContext): Promise<ModelResult> {
    maybeFail(ctx, req.settings, this.opts.failureRate, 'VIDEO_GENERATION_FAILED');
    const { w, h } = mockNativeSize(req.width, req.height, req.quality);
    const manifest: MockVideoManifest = {
      format: 'ai-story-studio/mock-video',
      version: 1,
      note: 'MOCK CLIP — placeholder manifest, no video frames were generated',
      sourceImageKey: req.imageStorageKey,
      motionPrompt: req.motionPrompt,
      durationSec: req.durationSec,
      fps: req.fps,
      width: w,
      height: h,
      frames: Math.round(req.durationSec * req.fps),
      seed: req.seed,
    };
    const perSecond = req.quality === 'fast_preview' ? 6 : req.quality === 'optimized' ? 14 : 40;
    return {
      file: {
        data: Buffer.from(JSON.stringify(manifest, null, 2)),
        mime: MOCK_VIDEO_MIME,
        ext: 'json',
        width: w,
        height: h,
        durationSec: req.durationSec,
        fps: req.fps,
      },
      model: this.info.id,
      modelVersion: this.info.modelVersion,
      generationSeconds: simulatedSeconds(perSecond * req.durationSec, ctx.attemptKey),
      isNativeResolution: w === req.width && h === req.height,
      settings: { quality: req.quality, generated: `${w}x${h}`, fps: req.fps },
      logs: [`mock i2v ${req.durationSec}s @${req.fps}fps ${w}x${h}`],
    };
  }
}

/**
 * MockUpscaler — nearest-neighbour resize for mock stills and a manifest
 * update for mock clips. Output is always flagged as NOT native resolution,
 * and the source asset is kept untouched.
 */
export class MockUpscaler implements Upscaler {
  readonly info = mockInfo('mock-upscaler', 'Mock upscaler', 'cloud_gpu', 8);
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  async upscale(req: UpscaleRequest, ctx: RunContext): Promise<ModelResult> {
    maybeFail(ctx, undefined, this.opts.failureRate, 'UPSCALE_FAILED');
    if (req.kind === 'image') {
      const src = decodeSimplePng(req.source);
      const png = encodePng(req.targetWidth, req.targetHeight, (x, y) => {
        const sx = Math.min(src.width - 1, Math.floor((x * src.width) / req.targetWidth));
        const sy = Math.min(src.height - 1, Math.floor((y * src.height) / req.targetHeight));
        const o = (sy * src.width + sx) * 3;
        return [src.rgb[o] ?? 0, src.rgb[o + 1] ?? 0, src.rgb[o + 2] ?? 0];
      });
      return {
        file: { data: png, mime: 'image/png', ext: 'png', width: req.targetWidth, height: req.targetHeight },
        model: this.info.id,
        modelVersion: this.info.modelVersion,
        generationSeconds: simulatedSeconds(6, ctx.attemptKey),
        isNativeResolution: false,
        settings: {
          from: `${req.sourceWidth}x${req.sourceHeight}`,
          to: `${req.targetWidth}x${req.targetHeight}`,
        },
        logs: ['mock nearest-neighbour upscale'],
      };
    }
    if (req.sourceMime !== MOCK_VIDEO_MIME)
      throw new ProviderError('UPSCALE_FAILED', 'Unsupported video format');
    const manifest = JSON.parse(Buffer.from(req.source).toString('utf8')) as MockVideoManifest;
    const upscaled: MockVideoManifest = {
      ...manifest,
      width: req.targetWidth,
      height: req.targetHeight,
      upscaledFrom: `${req.sourceWidth}x${req.sourceHeight}`,
    };
    return {
      file: {
        data: Buffer.from(JSON.stringify(upscaled, null, 2)),
        mime: MOCK_VIDEO_MIME,
        ext: 'json',
        width: req.targetWidth,
        height: req.targetHeight,
        durationSec: manifest.durationSec,
        fps: manifest.fps,
      },
      model: this.info.id,
      modelVersion: this.info.modelVersion,
      generationSeconds: simulatedSeconds(3 * manifest.durationSec, ctx.attemptKey),
      isNativeResolution: false,
      settings: {
        from: `${req.sourceWidth}x${req.sourceHeight}`,
        to: `${req.targetWidth}x${req.targetHeight}`,
      },
      logs: ['mock video upscale (manifest only)'],
    };
  }
}

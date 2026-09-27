import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { findFfmpeg, runTool, type FfmpegTools } from '../src/media/ffmpeg.ts';
import { encodeWav } from '../src/media/wav.ts';
import { FfprobeMediaProbe } from '../src/providers/ffprobe.ts';
import { EpisodeAssembler, parseLoudnormJson, type AssemblySegment } from '../src/services/assembler.ts';
import { DEFAULT_SETTINGS } from '../src/services/settings.ts';
import { produceShots, seedSmall, testStudio } from './helpers.ts';

// Real-FFmpeg tests run only where FFmpeg is installed (or FFMPEG_PATH / FFPROBE_PATH are set).
const tools = findFfmpeg(process.env, false);
const skip = tools ? false : 'FFmpeg not installed';

async function probeJson(t: FfmpegTools, path: string) {
  const { stdout } = await runTool(t.ffprobe, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    path,
  ]);
  return JSON.parse(stdout) as {
    streams: Array<{
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      sample_rate?: string;
      channels?: number;
    }>;
    format: { duration: string };
  };
}

async function integratedLufs(t: FfmpegTools, path: string): Promise<number> {
  const { stderr } = await runTool(t.ffmpeg, [
    '-hide_banner',
    '-nostats',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-af',
    'ebur128',
    '-f',
    'null',
    '-',
  ]);
  const m = /I:\s+(-?[\d.]+) LUFS/.exec(stderr.slice(stderr.lastIndexOf('Summary:')));
  return Number(m?.[1]);
}

describe('assembler helpers', () => {
  it('parses the loudnorm JSON block from FFmpeg stderr', () => {
    const stderr =
      'noise\n[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-23.51",\n\t"input_tp" : "-4.20"\n}\n';
    assert.deepEqual(parseLoudnormJson(stderr), { input_i: '-23.51', input_tp: '-4.20' });
    assert.equal(parseLoudnormJson('no json here'), undefined);
  });
});

describe('EpisodeAssembler (real FFmpeg)', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ais-asm-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const enc = { ...DEFAULT_SETTINGS.encoding, preset: 'ultrafast' as const };

  async function fixtures() {
    const t = tools!;
    const ff = (args: string[]) => runTool(t.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args]);
    await ff(['-f', 'lavfi', '-i', 'color=c=red:s=640x360', '-frames:v', '1', join(dir, 'red.png')]);
    await ff(['-f', 'lavfi', '-i', 'color=c=blue:s=360x640', '-frames:v', '1', join(dir, 'blue.png')]);
    // 1.5 s clip at 30 fps: exercises fps conversion, trim and last-frame hold.
    await ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1280x720:r=30:d=1.5',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      join(dir, 'clip.mp4'),
    ]);
    const sr = 48000;
    const samples = new Float32Array(sr * 6);
    for (let i = 0; i < samples.length; i++) samples[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / sr);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'mix.wav'), encodeWav({ sampleRate: sr, samples }));
  }

  it('joins stills and footage with cuts, crossfades and fades without changing the length', async () => {
    await fixtures();
    const segments: AssemblySegment[] = [
      { kind: 'still', path: join(dir, 'red.png'), durationSec: 2, trimInSec: 0, transition: 'cut' },
      {
        kind: 'video',
        path: join(dir, 'clip.mp4'),
        durationSec: 2,
        trimInSec: 0.25,
        transition: 'crossfade',
      },
      { kind: 'still', path: join(dir, 'blue.png'), durationSec: 2, trimInSec: 0, transition: 'fade_black' },
    ];
    const out = await new EpisodeAssembler(
      tools!,
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    ).assemble({
      segments,
      titles: [{ text: 'Ari\'s "sky" boats: 100% [test]', startSec: 0.2, durationSec: 1.5 }],
      mixWavPath: join(dir, 'mix.wav'),
      width: 640,
      height: 360,
      fps: 24,
      workDir: join(dir, 'work'),
      encoding: enc,
    });
    assert.equal(out.durationSec, 6);
    assert.deepEqual(out.transitions, { crossfades: 1, fades: 1 });
    const info = await probeJson(tools!, out.masterPath);
    const v = info.streams.find((s) => s.codec_type === 'video')!;
    const a = info.streams.find((s) => s.codec_type === 'audio')!;
    assert.equal(v.codec_name, 'h264');
    assert.deepEqual([v.width, v.height, v.avg_frame_rate], [640, 360, '24/1']);
    assert.equal(a.codec_name, 'aac');
    assert.equal(a.sample_rate, '48000');
    assert.equal(a.channels, 2);
    assert.ok(Math.abs(Number(info.format.duration) - 6) < 0.1, `duration ${info.format.duration}`);
    assert.equal(out.loudness.normalised, true);
    assert.ok(Math.abs(out.loudness.outputLufs! - enc.targetLufs) < 1, `loudness ${out.loudness.outputLufs}`);
    assert.ok(out.loudness.outputTruePeakDb! <= enc.truePeakDb + 0.3);
  });

  it('skips loudness normalisation for a silent mix and says so', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(dir, 'silent.wav'),
      encodeWav({ sampleRate: 48000, samples: new Float32Array(48000) }),
    );
    const out = await new EpisodeAssembler(tools!).assemble({
      segments: [
        { kind: 'still', path: join(dir, 'red.png'), durationSec: 1, trimInSec: 0, transition: 'cut' },
      ],
      titles: [{ text: 'no font', startSec: 0, durationSec: 1 }],
      mixWavPath: join(dir, 'silent.wav'),
      width: 320,
      height: 180,
      fps: 24,
      workDir: join(dir, 'work-silent'),
      encoding: enc,
    });
    assert.equal(out.loudness.normalised, false);
    assert.equal(out.titlesDrawn, 0);
    assert.equal(out.warnings.length, 2);
  });
});

describe('BUILD FINAL with FFmpeg', { skip }, () => {
  it('encodes a validated 1080p H.264/AAC MP4 at the target loudness', async () => {
    const s = testStudio({ env: { assemblyMode: 'ffmpeg' } });
    try {
      s.settings.set('encoding', { ...s.settings.get('encoding'), preset: 'ultrafast' });
      const { story } = seedSmall(s);
      await produceShots(s, story.id);
      s.timeline.build(story.id);
      s.timeline.addTitle(story.id, 'Sky Boats', 0, 2);
      const exp = await s.exports.buildFinal(story.id);
      assert.equal(exp.status, 'complete', exp.error_message ?? '');
      const master = s.assets.get(exp.master_asset_id!);
      assert.equal(master.mime, 'video/mp4');
      assert.equal(master.is_mock, 1, 'mock clips → labelled mock visuals');
      assert.match(master.label, /mock visuals/);
      const probe = await new FfprobeMediaProbe(s.storage, tools!.ffprobe, tools!.ffmpeg).probe(
        master.storage_key,
      );
      assert.equal(probe.isMock, false);
      assert.deepEqual(
        [probe.video?.codec, probe.video?.width, probe.video?.height, probe.video?.fps],
        ['h264', 1920, 1080, 24],
      );
      assert.deepEqual(
        [probe.audio?.codec, probe.audio?.sampleRate, probe.audio?.channels],
        ['aac', 48000, 2],
      );
      assert.ok(Math.abs(probe.durationSec - exp.duration_sec!) < 0.1);
      const lufs = await integratedLufs(tools!, s.storage.localPath(master.storage_key));
      assert.ok(Math.abs(lufs - -14) < 1.5, `integrated loudness ${lufs}`);
      const steps = JSON.parse(exp.steps_json) as Array<{ step: string; detail: string }>;
      const encode = steps.find((x) => x.step === 'encode')!;
      assert.match(encode.detail, /FFmpeg 1920×1080 @24fps H\.264/);
      assert.match(encode.detail, /1 title card/);
      const findings = JSON.parse(exp.validation_json!) as Array<{ code: string }>;
      assert.ok(findings.some((f) => f.code === 'mock_visuals'));
      assert.ok(!findings.some((f) => f.code === 'mock_output'));
    } finally {
      s.cleanup();
    }
  });

  it('reframes to a vertical 1080×1920 Short', async () => {
    const s = testStudio({ env: { assemblyMode: 'auto' } });
    try {
      s.settings.set('encoding', { ...s.settings.get('encoding'), preset: 'ultrafast' });
      const { story } = seedSmall(s);
      await produceShots(s, story.id);
      const exp = await s.exports.buildFinal(story.id, 'vertical');
      assert.equal(exp.status, 'complete', exp.error_message ?? '');
      const info = await probeJson(
        tools!,
        s.storage.localPath(s.assets.get(exp.master_asset_id!).storage_key),
      );
      const v = info.streams.find((x) => x.codec_type === 'video')!;
      assert.deepEqual([v.width, v.height], [1080, 1920]);
    } finally {
      s.cleanup();
    }
  });
});

describe('BUILD FINAL assembly modes', () => {
  it('fails clearly when ASSEMBLY_MODE=ffmpeg and FFmpeg is missing', async () => {
    const s = testStudio({ env: { assemblyMode: 'ffmpeg' }, ffmpeg: null });
    try {
      const { story } = seedSmall(s);
      await produceShots(s, story.id);
      const exp = await s.exports.buildFinal(story.id);
      assert.equal(exp.status, 'failed');
      assert.match(exp.error_message ?? '', /FFmpeg was not found/);
    } finally {
      s.cleanup();
    }
  });

  it('falls back to the mock master when FFmpeg is unavailable in auto mode', async () => {
    const s = testStudio({ env: { assemblyMode: 'auto' }, ffmpeg: null });
    try {
      const { story } = seedSmall(s);
      await produceShots(s, story.id);
      const exp = await s.exports.buildFinal(story.id);
      assert.equal(exp.status, 'complete', exp.error_message ?? '');
      assert.notEqual(s.assets.get(exp.master_asset_id!).mime, 'video/mp4');
    } finally {
      s.cleanup();
    }
  });
});

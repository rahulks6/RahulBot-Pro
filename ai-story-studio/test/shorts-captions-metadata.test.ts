import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { blocks, toSrt, toVtt } from '../src/services/captions.ts';
import { episodeMetadata, shortMetadata, tagsFrom, validChapters } from '../src/services/metadata.ts';
import { createShortStory, planShorts, SHORT_MAX_SEC } from '../src/services/shorts.ts';
import { filterPath, wrapTitle } from '../src/services/thumbnails.ts';
import { seedSmall, testStudio } from './helpers.ts';

describe('captions', () => {
  it('wraps at 42 characters, two lines per caption', () => {
    const b = blocks(
      'Milo ran through the forest looking for his friend Nia, who was hiding behind the big old oak tree near the river.',
    );
    assert.ok(b.length >= 2);
    for (const block of b) {
      const lines = block.split('\n');
      assert.ok(lines.length <= 2);
      assert.ok(
        lines.every((l) => l.length <= 42),
        JSON.stringify(lines),
      );
    }
  });

  it('writes valid SRT and WebVTT timestamps', () => {
    const cues = [
      { start: 0.3, end: 2.96, text: 'Hello Milo!' },
      { start: 3661.5, end: 3662.25, text: 'Line two\nsecond line' },
    ];
    assert.equal(
      toSrt(cues),
      '1\n00:00:00,300 --> 00:00:02,960\nHello Milo!\n\n2\n01:01:01,500 --> 01:01:02,250\nLine two\nsecond line\n',
    );
    assert.match(toVtt(cues), /^WEBVTT\n\n00:00:00\.300 --> 00:00:02\.960\nHello Milo!\n/);
  });
});

describe('Shorts planning', () => {
  const s = testStudio();
  after(() => s.cleanup());
  const { story } = seedSmall(s);

  it('picks coherent runs of consecutive shots within the Shorts length, without overlap', () => {
    const tree = s.stories.tree(story.id);
    const plans = planShorts(tree, 2);
    assert.ok(plans.length >= 1);
    const order = tree.scenes.flatMap((sc) => sc.shots.map((x) => x.shot.id));
    const used = new Set<string>();
    for (const p of plans) {
      assert.ok(p.seconds <= SHORT_MAX_SEC);
      const idx = p.shotIds.map((id) => order.indexOf(id));
      for (let i = 1; i < idx.length; i++)
        assert.equal(idx[i], idx[i - 1]! + 1, 'consecutive shots in story order');
      for (const id of p.shotIds) {
        assert.ok(!used.has(id), 'no shot in two Shorts');
        used.add(id);
      }
      assert.ok(p.hook.length > 0);
    }
  });

  it('copies the chosen shots into a vertical story with the same cast and lines', () => {
    const tree = s.stories.tree(story.id);
    const plan = planShorts(tree, 1)[0]!;
    const id = createShortStory(s, story.id, plan, 'Short 1');
    const copy = s.stories.tree(id);
    assert.equal(copy.story.format, 'vertical');
    const shots = copy.scenes.flatMap((sc) => sc.shots);
    assert.equal(shots.length, plan.shotIds.length);
    const src = tree.scenes.flatMap((sc) => sc.shots).filter((x) => plan.shotIds.includes(x.shot.id));
    shots.forEach((sh, i) => {
      assert.deepEqual(
        sh.characters.map((c) => c.character_id),
        src[i]!.characters.map((c) => c.character_id),
      );
      assert.deepEqual(
        sh.dialogue.map((d) => d.text),
        src[i]!.dialogue.map((d) => d.text),
      );
      assert.equal(sh.shot.approved_image_asset_id, null, 'drawn again, not copied');
    });
  });
});

describe('YouTube metadata drafts', () => {
  it('chapters only when YouTube accepts them', () => {
    const ok = [
      { startSec: 0, title: 'A' },
      { startSec: 20, title: 'B' },
      { startSec: 45, title: 'C' },
    ];
    assert.equal(validChapters(ok, 70).length, 3);
    assert.equal(validChapters(ok.slice(0, 2), 70).length, 0, 'needs three');
    assert.equal(
      validChapters([{ startSec: 2, title: 'A' }, ...ok.slice(1)], 70).length,
      0,
      'must start at 0:00',
    );
    assert.equal(validChapters(ok, 50).length, 0, 'each at least 10 s');
  });

  it('never decides the audience silently; always discloses AI; respects limits', () => {
    const m = episodeMetadata({
      title: 'x'.repeat(150),
      logline: 'A fox helps a turtle.',
      moral: 'Kindness.',
      characters: ['Milo', 'Tiko'],
      style: '3D Kids Animation',
      language: 'hi-Latn',
      chapters: [
        { startSec: 0, title: 'Lost' },
        { startSec: 30, title: 'Search' },
        { startSec: 70, title: 'Home' },
      ],
      totalSec: 100,
    });
    assert.equal(m.madeForKids, null);
    assert.equal(m.containsSyntheticMedia, true);
    assert.ok(m.title.length <= 100);
    assert.match(m.description, /0:00 Lost\n0:30 Search\n1:10 Home/);
    assert.match(m.description, /AI-generated \(synthetic\)/);
    assert.equal(m.defaultLanguage, 'hi');
    const sh = shortMetadata({
      episodeTitle: 'Milo and Tiko',
      hook: 'Where is the river?',
      characters: ['Milo'],
      language: 'en',
      index: 0,
      count: 2,
    });
    assert.match(sh.title, /#Shorts$/);
    assert.equal(sh.madeForKids, null);
    assert.ok(tagsFrom(Array.from({ length: 200 }, (_, i) => `tag number ${i}`)).join(',').length <= 500);
  });
});

describe('thumbnail helpers', () => {
  it('wraps the title and escapes font paths for FFmpeg filters', () => {
    assert.equal(
      wrapTitle('Milo and the Lost Little Turtle Goes Home Again Tonight', 18).split('\n').length,
      3,
    );
    assert.equal(filterPath('C:\\Windows\\Fonts\\arial.ttf'), 'C\\:/Windows/Fonts/arial.ttf');
  });
});

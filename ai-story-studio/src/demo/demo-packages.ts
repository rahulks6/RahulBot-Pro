/**
 * Demo Story Packages for an ORIGINAL example series ("Lantern Grove").
 * Used by `npm run seed` and the tests; the same JSON shape is documented in
 * docs/STORY_PACKAGE.md. Nothing here is hard-coded into the application.
 */
export const DEMO_EPISODE_1 = {
  format: 'ai-story-studio/story-package',
  version: 1,
  project: {
    name: 'Lantern Grove (demo)',
    series: 'Lantern Grove',
    description:
      'Gentle adventures of a young hedgehog inventor and a firefly friend. Demo project for Phase 1 mock mode.',
    genre: 'Animal adventure',
    targetAudience: 'Children 3–7',
    aspectRatio: '16:9',
    fps: 24,
    defaultQuality: 'optimized',
    defaultStyle: 'Premium 3D children’s animation',
    productionNotes: 'Warm, cosy look. Keep Pip’s scarf colour consistent.',
  },
  narrator: {
    name: 'Warm storyteller',
    voiceModel: 'mock-tts',
    voiceIdentity: 'narrator-warm-01',
    language: 'en',
    presentation: 'female',
    pitch: -1,
    speed: 0.95,
    narrationStyle: 'warm storyteller',
    defaultEmotion: 'calm',
  },
  characters: [
    {
      key: 'pip',
      name: 'Pip',
      species: 'hedgehog',
      age: '6 (child)',
      role: 'curious young inventor',
      personality: 'curious, brave, a little impatient, kind',
      appearance: 'small round hedgehog with soft chestnut spines',
      face: 'round face, button nose, freckles on cheeks',
      hair: 'chestnut spines with cream tips',
      eyes: 'large hazel eyes',
      body: 'small, round, stubby legs',
      proportions: 'head one third of body height',
      clothing: 'mustard-yellow knitted scarf, tiny brown satchel',
      accessories: 'brass goggles on forehead',
      colors: 'chestnut, cream, mustard yellow, brass',
      prompt:
        'Pip the hedgehog, small round hedgehog inventor with chestnut spines, mustard scarf and brass goggles',
      negativePrompt: 'realistic hedgehog, sharp scary spines, extra limbs',
      preferredSeeds: [1207],
      voice: {
        name: 'Pip voice',
        voiceIdentity: 'pip-bright-01',
        presentation: 'neutral',
        pitch: 4,
        speed: 1.05,
        speakingStyle: 'bright, curious child',
      },
      variants: [
        {
          key: 'raincoat',
          name: 'Rain coat',
          description: 'Rainy-day outfit',
          clothingOverride: 'shiny red raincoat and mustard scarf',
          promptAdditions: 'wearing a shiny red raincoat',
        },
      ],
    },
    {
      key: 'luma',
      name: 'Luma',
      species: 'firefly',
      age: 'young adult',
      role: 'wise, playful friend',
      personality: 'gentle, playful, encouraging',
      appearance: 'tiny firefly with a warm golden glowing tail',
      face: 'friendly round face, small smile',
      eyes: 'big dark eyes with highlights',
      body: 'tiny body, translucent wings',
      colors: 'warm gold, soft green',
      prompt: 'Luma the firefly, tiny friendly firefly with a warm golden glow and translucent wings',
      negativePrompt: 'insect horror, realistic bug, harsh light',
      voice: {
        name: 'Luma voice',
        voiceIdentity: 'luma-soft-01',
        presentation: 'female',
        pitch: 2,
        speed: 1,
        speakingStyle: 'soft and encouraging',
      },
    },
  ],
  locations: [
    {
      key: 'grove',
      name: 'Whispering Willow Grove',
      description: 'A mossy clearing under an ancient willow tree beside a small stream',
      environment: 'forest clearing, stream, mushrooms, fireflies',
      architecture: 'Pip’s acorn-shaped workshop built into the willow roots',
      importantObjects: 'workbench of twigs, lantern hooks, round wooden door',
      colors: 'deep greens, warm amber lights',
      lighting: 'soft dappled evening light',
      weather: 'clear',
      timeOfDay: 'evening',
      prompt: 'mossy forest clearing under an ancient willow with a tiny acorn-shaped workshop in the roots',
      negativePrompt: 'city, cars, modern buildings',
    },
  ],
  props: [
    {
      key: 'lantern',
      name: 'Brass lantern',
      description: 'Pip’s small brass lantern with a round glass window',
      scale: 'fits in Pip’s paws',
      colors: 'brass, warm glass',
      prompt: 'small brass lantern with round glass window',
      characters: ['pip'],
    },
  ],
  story: {
    title: 'The Lantern That Forgot to Glow',
    episodeNumber: 1,
    synopsis:
      'Pip’s brass lantern will not light before the evening walk. With Luma’s help, Pip learns that fixing things takes patience and that friends can share their light.',
    storyText:
      'Every evening Pip lights the brass lantern for the walk home. Tonight the lantern stays dark. Pip tries to fix it quickly and gets frustrated. Luma arrives and suggests slowing down. Together they find a tiny leaf stuck in the wick. Luma shares a little glow, the lantern shines again, and the two friends walk home under the stars.',
    moral: 'Patience and friendship help us solve problems.',
    language: 'en',
    targetDurationSec: 35,
  },
  scenes: [
    {
      key: 's1',
      title: 'A dark lantern',
      summary: 'Evening falls in the grove. Pip wants to light the lantern but it will not glow.',
      location: 'grove',
      timeOfDay: 'evening',
      music: { mood: 'gentle curiosity', genre: 'soft orchestral', energy: 'low' },
      ambience: 'forest evening',
      narration: [
        {
          text: 'As the sun slipped behind the willow, Pip reached for the little brass lantern.',
          emotion: 'calm',
        },
      ],
      shots: [
        {
          key: 's1a',
          title: 'Establishing grove',
          action: 'wide view of the willow grove at dusk, Pip’s workshop door glowing',
          camera: { framing: 'wide shot', angle: 'eye level', movement: 'slow push in' },
          durationSec: 5,
          sfx: [{ tag: 'birds', offsetSec: 0.5 }],
        },
        {
          key: 's1b',
          title: 'Pip tries the lantern',
          action: 'Pip turns the lantern key but nothing happens',
          emotion: 'puzzled',
          characters: [{ character: 'pip' }],
          props: ['lantern'],
          camera: { framing: 'medium shot', angle: 'eye level', movement: 'static' },
          durationSec: 5,
          mouthVisible: true,
          dialogue: [
            { character: 'pip', text: 'Come on, little lantern. Why won’t you glow?', emotion: 'nervous' },
          ],
        },
      ],
    },
    {
      key: 's2',
      title: 'Too fast',
      summary: 'Pip tries to fix the lantern quickly and gets frustrated. Luma arrives.',
      location: 'grove',
      music: { mood: 'gentle suspense', genre: 'soft orchestral', energy: 'medium' },
      ambience: 'forest evening',
      shots: [
        {
          key: 's2a',
          title: 'Hurried fixing',
          action: 'Pip shakes and taps the lantern, tools scattering on the workbench',
          emotion: 'frustrated',
          characters: [{ character: 'pip' }],
          props: ['lantern'],
          camera: { framing: 'close-up', angle: 'high angle', movement: 'handheld' },
          durationSec: 4,
          sfx: [{ tag: 'door knock', offsetSec: 1, required: true }],
          narration: [{ text: 'Pip tapped and shook and twisted, faster and faster.', emotion: 'excited' }],
        },
        {
          key: 's2b',
          title: 'Luma arrives',
          action: 'Luma floats down beside Pip, glowing softly',
          emotion: 'gentle',
          characters: [{ character: 'pip' }, { character: 'luma' }],
          camera: { framing: 'two shot', angle: 'eye level', movement: 'slow pan' },
          durationSec: 5,
          mouthVisible: true,
          dialogue: [
            { character: 'luma', text: 'Slow down, Pip. Let us look together.', emotion: 'calm' },
            { character: 'pip', text: 'Okay. Together.', emotion: 'tired' },
          ],
          sfx: [{ tag: 'magic sparkle', offsetSec: 0.2 }],
        },
      ],
    },
    {
      key: 's3',
      title: 'Shining again',
      summary: 'They find a leaf stuck in the wick, Luma shares her glow, and the friends walk home.',
      location: 'grove',
      music: { mood: 'magical discovery', genre: 'soft orchestral', energy: 'medium' },
      ambience: 'night insects',
      shots: [
        {
          key: 's3a',
          title: 'The tiny leaf',
          action: 'Pip carefully pulls a tiny leaf out of the lantern wick',
          emotion: 'surprised',
          characters: [{ character: 'pip', variant: 'raincoat' }],
          props: ['lantern'],
          camera: { framing: 'extreme close-up', angle: 'eye level', movement: 'static' },
          durationSec: 4,
          narration: [{ text: 'There, hiding in the wick, was one tiny willow leaf.', emotion: 'surprised' }],
        },
        {
          key: 's3b',
          title: 'Walking home',
          action: 'Pip and Luma walk home along the stream, the lantern glowing warmly',
          emotion: 'happy',
          characters: [{ character: 'pip' }, { character: 'luma' }],
          props: ['lantern'],
          camera: { framing: 'wide shot', angle: 'low angle', movement: 'tracking' },
          durationSec: 6,
          sfx: [{ tag: 'footsteps', offsetSec: 0 }],
          narration: [
            { text: 'And under the stars, two friends walked home, sharing their light.', emotion: 'calm' },
          ],
        },
      ],
    },
  ],
};

/**
 * Episode 2 — a different plot with the same recurring characters. One
 * narration line is deliberately re-used from Episode 1 so the similarity
 * report has something to explain.
 */
export const DEMO_EPISODE_2 = {
  format: 'ai-story-studio/story-package',
  version: 1,
  // Recurring entities already in the project: key + name is enough; they are reused unchanged.
  characters: [
    { key: 'pip', name: 'Pip', variants: [{ key: 'raincoat', name: 'Rain coat' }] },
    { key: 'luma', name: 'Luma' },
  ],
  locations: [{ key: 'grove', name: 'Whispering Willow Grove' }],
  story: {
    title: 'The Puddle Parade',
    episodeNumber: 2,
    synopsis:
      'A rainy morning turns the grove into puddles. Pip builds tiny boats so the ants can cross the stream.',
    storyText:
      'Rain has filled the grove with puddles and the ant family cannot reach the berry bushes. Pip wants to help and designs leaf boats. The first boat sinks, but Pip tries again with Luma lighting the way, and soon a parade of boats carries everyone across.',
    moral: 'Trying again is part of inventing.',
    language: 'en',
    targetDurationSec: 20,
  },
  scenes: [
    {
      key: 'r1',
      title: 'Rainy morning',
      summary: 'Rain falls on the grove and the ants are stuck behind a big puddle.',
      location: 'grove',
      music: { mood: 'playful rain', genre: 'pizzicato strings', energy: 'medium' },
      ambience: 'rain',
      narration: [
        {
          text: 'As the sun slipped behind the willow, Pip reached for the little brass lantern.',
          emotion: 'calm',
        },
      ],
      shots: [
        {
          key: 'r1a',
          title: 'Puddles everywhere',
          action: 'rain drips from willow leaves into wide puddles',
          camera: { framing: 'wide shot', angle: 'high angle', movement: 'crane down' },
          durationSec: 5,
          sfx: [{ tag: 'rain' }],
        },
        {
          key: 'r1b',
          title: 'Pip has an idea',
          action: 'Pip in a raincoat holds up a big leaf, eyes bright with an idea',
          emotion: 'excited',
          characters: [{ character: 'pip', variant: 'raincoat' }],
          camera: { framing: 'medium close-up', angle: 'low angle', movement: 'static' },
          durationSec: 4,
          mouthVisible: true,
          dialogue: [{ character: 'pip', text: 'Leaf boats! We can build leaf boats!', emotion: 'excited' }],
        },
      ],
    },
    {
      key: 'r2',
      title: 'The parade',
      summary: 'After one boat sinks, Pip tries again and a parade of leaf boats crosses the stream.',
      location: 'grove',
      music: { mood: 'celebration', genre: 'pizzicato strings', energy: 'high' },
      ambience: 'water',
      shots: [
        {
          key: 'r2a',
          title: 'Boats across the stream',
          action: 'a line of leaf boats carrying ants floats across the stream while Luma lights the way',
          emotion: 'joyful',
          characters: [{ character: 'luma' }],
          camera: { framing: 'wide shot', angle: 'eye level', movement: 'tracking' },
          durationSec: 6,
          sfx: [{ tag: 'water' }],
          narration: [
            { text: 'One by one, the little boats sailed across, and the ants cheered.', emotion: 'happy' },
          ],
        },
      ],
    },
  ],
};

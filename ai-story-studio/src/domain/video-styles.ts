/**
 * Visual styles offered on the Create page (Simple Mode). Plain names only: which model draws
 * them is decided automatically. The prompt text is added to every image of the video.
 */
export interface VideoStyle {
  id: string;
  label: string;
  description: string;
  prompt: string;
  negative: string;
}

export const VIDEO_STYLES: readonly VideoStyle[] = [
  {
    id: '3d_kids',
    label: '3D Kids Animation',
    description: 'Bright, rounded, friendly 3D characters, like a family animated film.',
    prompt:
      '3D animated children’s film style, soft global illumination, rounded friendly character design, vibrant colours, expressive faces, high detail',
    negative: 'photorealistic, gore, horror, text, watermark, extra limbs, deformed hands',
  },
  {
    id: '2d_cartoon',
    label: '2D Cartoon',
    description: 'Clean outlines and flat colours, like a TV cartoon.',
    prompt: '2D cartoon style, clean bold outlines, flat vibrant colours, simple shading, TV animation look',
    negative: 'photorealistic, 3D render, text, watermark, extra limbs',
  },
  {
    id: 'anime',
    label: 'Anime',
    description: 'Japanese animation look with painted backgrounds.',
    prompt: 'anime style, cel shading, detailed painted background, expressive eyes, cinematic lighting',
    negative: 'photorealistic, 3D render, text, watermark, extra limbs',
  },
  {
    id: 'storybook',
    label: 'Storybook Illustration',
    description: 'Soft, hand-painted picture-book pages.',
    prompt: 'children’s storybook illustration, soft gouache and watercolour textures, warm gentle light',
    negative: 'photorealistic, 3D render, harsh shadows, text, watermark',
  },
  {
    id: 'claymation',
    label: 'Clay Animation',
    description: 'Handmade clay figures and miniature sets.',
    prompt: 'claymation stop-motion style, handmade plasticine characters, miniature set, soft studio light',
    negative: 'photorealistic humans, text, watermark, extra limbs',
  },
  {
    id: 'cinematic',
    label: 'Cinematic Realistic',
    description: 'Film-like realism for older audiences.',
    prompt: 'cinematic realistic style, shallow depth of field, film lighting, rich colour grading, 35mm',
    negative: 'cartoon, text, watermark, deformed, extra limbs',
  },
];

export const DEFAULT_STYLE_ID = '3d_kids';

export function videoStyle(id: string): VideoStyle {
  return VIDEO_STYLES.find((s) => s.id === id) ?? VIDEO_STYLES[0]!;
}

/** Target lengths on the Create page (seconds). CUSTOM uses the minutes the user types. */
export const VIDEO_LENGTHS = {
  short: { label: 'SHORT', hint: 'about 1 minute', seconds: 60 },
  standard: { label: 'STANDARD', hint: '3–5 minutes', seconds: 240 },
  full: { label: 'FULL EPISODE', hint: '8–10 minutes', seconds: 540 },
  custom: { label: 'CUSTOM', hint: 'you choose', seconds: 0 },
} as const;
export type VideoLength = keyof typeof VIDEO_LENGTHS;

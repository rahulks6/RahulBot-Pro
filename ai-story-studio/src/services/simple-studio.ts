import type { Studio } from '../app/studio.ts';
import type { Project } from '../domain/types.ts';
import { AppError } from '../lib/errors.ts';

/**
 * Simple Mode keeps every video in one project, so characters (Milo…) are a reusable library:
 * a character created once — with its approved reference pictures and voice — is used again by
 * every later video that mentions it. Advanced Mode still sees it as an ordinary project.
 */
const KEY = 'simple.projectId';

export function studioProject(s: Pick<Studio, 'db' | 'projects' | 'settings'>): Project {
  const row = s.db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', KEY);
  const existing = row ? s.projects.find(row.value) : undefined;
  if (existing) return existing;
  const fps = Number(s.settings.get('execution').fps) === 24 ? 24 : 30;
  const project = s.projects.create({
    name: 'My Videos',
    description: 'Videos made in Simple Mode. Characters here are reused by every video.',
    genre: 'Animated stories',
    target_audience: 'Families',
    aspect_ratio: '16:9',
    fps,
    default_quality: 'optimized',
  });
  s.db.run(
    'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    KEY,
    project.id,
  );
  return project;
}

/** Validates an uploaded image (data URL from the browser) and returns its bytes. */
export function decodeImageUpload(dataUrl: string): { data: Buffer; ext: string; mime: string } {
  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new AppError('VALIDATION_FAILED', 'Choose a PNG, JPEG or WebP picture');
  const data = Buffer.from(m[3]!, 'base64');
  if (data.length > 10 * 1024 * 1024)
    throw new AppError('VALIDATION_FAILED', 'The picture is larger than 10 MB');
  const ok =
    (m[2] === 'png' && data.subarray(0, 4).toString('hex') === '89504e47') ||
    (m[2] === 'jpeg' && data.subarray(0, 2).toString('hex') === 'ffd8') ||
    (m[2] === 'webp' && data.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!ok) throw new AppError('VALIDATION_FAILED', 'The file is not the picture type it claims to be');
  return { data, ext: m[2] === 'jpeg' ? 'jpg' : m[2]!, mime: m[1]! };
}

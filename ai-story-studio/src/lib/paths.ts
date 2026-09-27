import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | undefined;

/**
 * Absolute path of the ai-story-studio application directory. Works both when
 * running TypeScript sources directly and when running the compiled `dist/`.
 */
export function appRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string };
      if (parsed.name === 'ai-story-studio') {
        cachedRoot = dir;
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Unable to locate ai-story-studio package root');
    dir = parent;
  }
}

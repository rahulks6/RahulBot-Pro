import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Change NAME=value lines in the app's .env (adding missing ones). A copy of the previous file is
 * kept next to it (`.env.backup-<time>`); returns that path, or null when there was no .env yet.
 */
export function setEnvValues(envFile: string, values: Record<string, string>, now: Date): string | null {
  let backup: string | null = null;
  let text = '';
  if (existsSync(envFile)) {
    text = readFileSync(envFile, 'utf8');
    backup = `${envFile}.backup-${now.toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(envFile, backup);
  }
  for (const [name, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`${name}: a .env value cannot contain a line break`);
    const re = new RegExp(`^\\s*${name}\\s*=.*$`, 'm');
    text = re.test(text)
      ? text.replace(re, () => `${name}=${value}`)
      : `${text.replace(/\n?$/, '\n')}${name}=${value}\n`;
  }
  writeFileSync(envFile, text);
  return backup;
}

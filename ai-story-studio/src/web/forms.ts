/**
 * Convert a submitted form into a patch object: drops the CSRF field and
 * turns empty id references ("…_id") into null so "none" selections clear
 * the reference instead of failing id validation.
 */
export function formPatch(form: Record<string, string>, only?: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(form)) {
    if (k === '_csrf' || k.startsWith('_')) continue;
    if (only && !only.includes(k)) continue;
    out[k] = k.endsWith('_id') && v === '' ? null : v;
  }
  return out;
}

export function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

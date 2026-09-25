/**
 * Explainable text/sequence similarity measures used by the originality and
 * repetition checks (spec §55, §59). All scores are 0..1.
 */

export function tokenize(text: string, ignore: ReadonlySet<string> = new Set()): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length > 0 && !ignore.has(w));
}

export function shingles(tokens: string[], size = 3): Set<string> {
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < size) {
    out.add(tokens.join(' '));
    return out;
  }
  for (let i = 0; i + size <= tokens.length; i++) out.add(tokens.slice(i, i + size).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Fraction of A's shingles that also occur in B ("A shares X% of its text with B"). */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / a.size;
}

export function textContainment(
  a: string,
  b: string,
  ignore: ReadonlySet<string> = new Set(),
  size = 3,
): number {
  return containment(shingles(tokenize(a, ignore), size), shingles(tokenize(b, ignore), size));
}

/** Longest-common-subsequence ratio of two sequences (shot plans, scene structures). */
export function sequenceSimilarity<T>(
  a: readonly T[],
  b: readonly T[],
  eq: (x: T, y: T) => boolean = (x, y) => x === y,
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const dp: number[] = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j] ?? 0;
      dp[j] = eq(a[i - 1] as T, b[j - 1] as T) ? prev + 1 : Math.max(dp[j] ?? 0, dp[j - 1] ?? 0);
      prev = tmp;
    }
  }
  return (dp[b.length] ?? 0) / Math.max(a.length, b.length);
}

export function normalizeTitle(title: string): string {
  return tokenize(title).join(' ');
}

export function pct(x: number): number {
  return Math.round(x * 100);
}

/**
 * Name comparison for "M-Pesa payer name" vs "Tally party ledger name".
 * Deliberately crude: it only ever *raises* confidence on a match that already
 * passed an amount/date test, and never selects between candidates on its own.
 */

const NOISE = new Set([
  'ltd',
  'limited',
  'co',
  'company',
  'enterprises',
  'enterprise',
  'services',
  'service',
  'and',
  'the',
  'mr',
  'mrs',
  'ms',
  'dr',
]);

export function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !NOISE.has(t));
}

/** Jaccard overlap of the significant tokens, 0..1. */
export function nameSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;

  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

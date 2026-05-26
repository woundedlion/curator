import { normalizeForMatching } from "../metadata/normalizers";

const MIN_LENGTH_FOR_BIGRAMS = 2;

function strip(value: string | undefined): string {
  if (!value) return "";
  return normalizeForMatching(value).replace(/\s+/g, "");
}

function bigramsOf(value: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < value.length - 1; i++) {
    set.add(value.slice(i, i + 2));
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function titleSimilarity(
  userTitle: string | undefined,
  candidateTitle: string | undefined,
): number {
  const a = strip(userTitle);
  const b = strip(candidateTitle);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < MIN_LENGTH_FOR_BIGRAMS || b.length < MIN_LENGTH_FOR_BIGRAMS) {
    return a === b ? 1 : 0;
  }
  if (a.includes(b)) return b.length / a.length;
  if (b.includes(a)) return a.length / b.length;
  return jaccard(bigramsOf(a), bigramsOf(b));
}

export const MIN_AUTO_MATCH_TITLE_SIMILARITY = 0.4;

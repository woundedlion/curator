import { normalizeForMatching } from "../metadata/normalizers";

const MIN_LENGTH_FOR_BIGRAMS = 2;

// Containment precision gate. A short string that happens to be embedded
// in a longer one (e.g. "Live" inside "Alive") used to score
// shorter.length / longer.length = 0.8 — a false high-similarity for two
// genuinely different titles. We now only honour containment when the
// shorter side is BOTH a meaningful absolute length AND a meaningful
// fraction of the longer side. Anything shorter falls through to the
// blended bigram/word signal, which scores such coincidences low.
//   - "Live"/"Alive": shorter is 4 chars (< MIN) → falls through → ~0.375.
//   - "stargazer"/"stargazers": shorter is 9 chars, 0.9 of longer → 0.9.
//   - "lovesponge"/"love sponge extended": shorter is 10 chars, 0.556 of
//     longer → 0.556 (a legitimate one-sided subset stays high).
const MIN_CONTAINMENT_SHORTER_LENGTH = 5;
const MIN_CONTAINMENT_LENGTH_RATIO = 0.5;

// Blend weights for the fallback signal. The character-bigram Jaccard
// captures fuzzy spelling overlap but is BLIND to word order (it scores
// "Karma Police"/"Police Karma" ~0.69 because the within-word bigrams are
// identical). We blend it 50/50 with an order-sensitive word signal so
// reorderings and near-anagrams are pushed below the auto-match threshold
// while true matches (identical word sequences) stay at 1.
const CHAR_BIGRAM_WEIGHT = 0.5;
const WORD_SIGNAL_WEIGHT = 0.5;

/**
 * Normalizes for matching but PRESERVES single spaces between words.
 * Word boundaries are load-bearing for the order-sensitive word signal
 * below — stripping all whitespace (the previous behaviour) discarded
 * word order, so "Karma Police" and "Police Karma" collapsed to anagrams
 * that scored as near-identical.
 */
function normalize(value: string | undefined): string {
  if (!value) return "";
  return normalizeForMatching(value);
}

function tokensOf(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function charBigramsOf(value: string): Set<string> {
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

/**
 * Order-sensitive word signal. For multi-word titles we compare the set
 * of consecutive word *pairs* (word-bigrams): identical word order shares
 * all pairs (Jaccard 1) while a reordering shares none (Jaccard 0). For
 * single-word titles there are no pairs, so we fall back to comparing the
 * lone words directly. O(n) in the number of tokens.
 */
function wordSignal(aTokens: string[], bTokens: string[]): number {
  const wordBigrams = (tokens: string[]): Set<string> => {
    const set = new Set<string>();
    if (tokens.length <= 1) {
      // length === 1 guarantees tokens[0] is defined (noUncheckedIndexedAccess
      // widens the element type to `string | undefined` regardless).
      if (tokens.length === 1) set.add(tokens[0]!);
      return set;
    }
    for (let i = 0; i < tokens.length - 1; i++) {
      set.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
    return set;
  };
  return jaccard(wordBigrams(aTokens), wordBigrams(bTokens));
}

/**
 * Approximate title similarity in [0, 1], 1 == identical after
 * normalization. Used to gate auto-matching of enrichment candidates.
 *
 * Pipeline (precision-tuned — see the constant docs above for rationale):
 *   1. Empty/short guards.
 *   2. Exact (normalized) equality → 1. This is what carries the true
 *      "subset" positives: normalizeForMatching strips featuring clauses
 *      and parenthetical suffixes BEFORE we compare, so "Yeah! feat. Lil
 *      Jon"/"Yeah!" and "Karma Police (Remastered 2017)"/"Karma Police"
 *      normalize to identical strings and return 1 here.
 *   3. Gated substring containment → ratio, but ONLY when the shorter
 *      side is a meaningful chunk of the longer (length + fraction gates).
 *      This kills the "Live" ⊂ "Alive" style false positive.
 *   4. Otherwise blend a character-bigram Jaccard (fuzzy spelling) with an
 *      order-sensitive word signal so word reorderings score low.
 */
export function titleSimilarity(
  userTitle: string | undefined,
  candidateTitle: string | undefined,
): number {
  const a = normalize(userTitle);
  const b = normalize(candidateTitle);
  if (!a || !b) return 0;
  if (a === b) return 1;

  // Whitespace-free forms for the containment test only — containment is a
  // span check ("is X a contiguous piece of Y"), and a legitimate
  // one-sided subset can differ purely in spacing ("Lovesponge" vs
  // "Love Sponge Extended"). The order-sensitive scoring above keeps
  // whitespace, so collapsing it here is safe.
  const aStripped = a.replace(/\s+/g, "");
  const bStripped = b.replace(/\s+/g, "");
  if (
    aStripped.length < MIN_LENGTH_FOR_BIGRAMS ||
    bStripped.length < MIN_LENGTH_FOR_BIGRAMS
  ) {
    return aStripped === bStripped ? 1 : 0;
  }

  const [shorter, longer] =
    aStripped.length <= bStripped.length
      ? [aStripped, bStripped]
      : [bStripped, aStripped];
  if (
    longer.includes(shorter) &&
    shorter.length >= MIN_CONTAINMENT_SHORTER_LENGTH &&
    shorter.length / longer.length >= MIN_CONTAINMENT_LENGTH_RATIO
  ) {
    return shorter.length / longer.length;
  }

  const charScore = jaccard(charBigramsOf(a), charBigramsOf(b));
  const wordScore = wordSignal(tokensOf(a), tokensOf(b));
  return CHAR_BIGRAM_WEIGHT * charScore + WORD_SIGNAL_WEIGHT * wordScore;
}

export const MIN_AUTO_MATCH_TITLE_SIMILARITY = 0.4;

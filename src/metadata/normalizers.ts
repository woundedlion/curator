const PARENTHETICAL_SUFFIX = /\s*[([][^()[\]]*[)\]]\s*$/;
const FEATURING_CLAUSE = /\s+(?:feat\.?|featuring|ft\.?)\s.+$/i;
const MULTIPLE_WHITESPACE = /\s+/g;
// Combining diacritic marks (post-NFKD decomposition). Stripping them
// makes "café"/"cafe", "Beyoncé"/"Beyonce", and "Mötley"/"Motley"
// compare equal — essential for dedupe + Fuse scoring.
const COMBINING_DIACRITICS = /[̀-ͯ]/g;
// Zero-width characters routinely leak from copy-paste off streaming
// services / certain ID3 rippers. They invisibly break exact-string
// matches. Range covers ZWSP/ZWNJ/ZWJ (U+200B..U+200D) plus BOM (U+FEFF).
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
// Unicode bidi marks. Same problem class as zero-width: invisible,
// occasionally leak into pasted titles, and break exact equality.
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;
// Smart/curly quotes — Word, Notes.app, web copy. Fold to straight ASCII
// so a single user-typed straight quote can match an ID3-tag curly one.
const SMART_QUOTE_MAP: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "′": "'",
  "″": '"',
};

function stripParentheticalSuffixes(value: string): string {
  let current = value;
  let previous = "";
  while (current !== previous) {
    previous = current;
    current = current.replace(PARENTHETICAL_SUFFIX, "");
  }
  return current;
}

function stripFeaturingClause(value: string): string {
  return value.replace(FEATURING_CLAUSE, "");
}

function normalizeWhitespaceChars(value: string): string {
  // NBSP and other non-breaking spaces have to become plain spaces before
  // collapseWhitespace runs, otherwise "Pink<NBSP>Floyd" doesn't match
  // "Pink Floyd".
  return value.replace(
    /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g,
    " ",
  );
}

function foldSmartQuotes(value: string): string {
  return value.replace(/[‘-‟′″]/g, (ch) => SMART_QUOTE_MAP[ch] ?? ch);
}

function stripInvisibles(value: string): string {
  return value.replace(ZERO_WIDTH, "").replace(BIDI_MARKS, "");
}

function normalizeUnicode(value: string): string {
  // NFKD decomposes diacritics into combining marks, which we then strip.
  // Result is the closest ASCII-ish skeleton: "café" → "cafe", etc.
  // Caveats — NFKD does not fully ASCII-fold a few cases: "ß" stays "ß"
  // (no → "ss"), and "½" decomposes to "1⁄2" leaving the U+2044 fraction
  // slash rather than a plain "/". These are rare in track metadata and
  // fold identically on both sides of a match, so they don't break scoring.
  return value
    .normalize("NFKD")
    .replace(COMBINING_DIACRITICS, "")
    .toLowerCase();
}

function expandAmpersand(value: string): string {
  return value.replace(/&/g, " and ");
}

function collapseWhitespace(value: string): string {
  return value.replace(MULTIPLE_WHITESPACE, " ").trim();
}

function preCleanText(value: string): string {
  return foldSmartQuotes(stripInvisibles(normalizeWhitespaceChars(value)));
}

export function normalizeForMatching(value: string | undefined): string {
  if (!value) return "";
  return collapseWhitespace(
    expandAmpersand(
      normalizeUnicode(
        stripFeaturingClause(
          stripParentheticalSuffixes(preCleanText(value)),
        ),
      ),
    ),
  );
}

export function normalizeForLuceneLiteral(value: string | undefined): string {
  if (!value) return "";
  const cleaned = stripFeaturingClause(
    stripParentheticalSuffixes(preCleanText(value)),
  );
  // Escape the two characters with special meaning inside a Lucene
  // quoted phrase (`"` and `\`). All other Lucene specials are tolerated
  // inside the phrase delimiter.
  return cleaned.replace(/["\\]/g, "\\$&").trim();
}

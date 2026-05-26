const PARENTHETICAL_SUFFIX = /\s*[\(\[][^()\[\]]*[\)\]]\s*$/g;
const FEATURING_CLAUSE = /\s+(?:feat\.?|featuring|ft\.?)\s.+$/i;
const MULTIPLE_WHITESPACE = /\s+/g;

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

function normalizeUnicode(value: string): string {
  return value.normalize("NFKD").toLowerCase();
}

function expandAmpersand(value: string): string {
  return value.replace(/&/g, " and ");
}

function collapseWhitespace(value: string): string {
  return value.replace(MULTIPLE_WHITESPACE, " ").trim();
}

export function normalizeForMatching(value: string | undefined): string {
  if (!value) return "";
  return collapseWhitespace(
    expandAmpersand(
      normalizeUnicode(stripFeaturingClause(stripParentheticalSuffixes(value))),
    ),
  );
}

export function normalizeForLuceneLiteral(value: string | undefined): string {
  if (!value) return "";
  const cleaned = stripFeaturingClause(stripParentheticalSuffixes(value));
  return cleaned.replace(/["\\]/g, "\\$&").trim();
}

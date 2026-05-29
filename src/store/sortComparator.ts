import type { SortDirection, SortField, Track } from "../types";

type Comparable = string | number | undefined;

// Locale-aware string comparison. ASCII `<`/`>` puts "É" after "Z" and
// case-folds nothing; `Intl.Collator` with `sensitivity: "base"` matches
// musical-library expectations: "Beyoncé" sorts next to "Beyonce", "É"
// sorts where "E" does. `numeric: true` makes "Track 2" precede
// "Track 10" — desirable on title sorts of numbered tracks. Constructed
// once at module load (collator construction is the expensive part;
// .compare itself is cheap).
const stringCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

function getFieldValue(track: Track, field: SortField): Comparable {
  switch (field) {
    case "artist":
      return track.artist;
    case "year":
      return track.year;
    case "originalYear":
      return track.originalYear;
    case "album":
      return track.album;
    case "trackNo":
      return track.trackNo;
    case "title":
      return track.title;
    case "index":
      return undefined;
  }
}

function isMissing(value: Comparable): boolean {
  return value === undefined || value === null || value === "";
}

function compareDefined(a: Comparable, b: Comparable, dir: SortDirection): number {
  if (typeof a === "number" && typeof b === "number") {
    return dir === "asc" ? a - b : b - a;
  }
  const cmp = stringCollator.compare(String(a ?? ""), String(b ?? ""));
  return dir === "asc" ? cmp : -cmp;
}

export function sortTrackIds(
  trackIds: string[],
  tracksById: Map<string, Track>,
  field: SortField,
  dir: SortDirection,
): string[] {
  const indexed = trackIds.map((id, index) => ({ id, index }));
  indexed.sort((a, b) => {
    const trackA = tracksById.get(a.id)!;
    const trackB = tracksById.get(b.id)!;
    const valueA = getFieldValue(trackA, field);
    const valueB = getFieldValue(trackB, field);
    const missingA = isMissing(valueA);
    const missingB = isMissing(valueB);
    if (missingA && missingB) return a.index - b.index;
    if (missingA) return 1;
    if (missingB) return -1;
    const cmp = compareDefined(valueA, valueB, dir);
    return cmp !== 0 ? cmp : a.index - b.index;
  });
  return indexed.map((entry) => entry.id);
}

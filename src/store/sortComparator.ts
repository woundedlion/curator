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
  // `a`/`b` are guaranteed non-missing here — sortTrackIds only calls
  // compareDefined after both pass !isMissing — so the prior `?? ""`
  // defensive fallback was unreachable and is dropped.
  const cmp = stringCollator.compare(String(a), String(b));
  return dir === "asc" ? cmp : -cmp;
}

// Minimal read interface over the track map. A `Map<string, Track>`
// satisfies it directly (tests pass one), and the store passes a thin
// adapter over its plain-object `tracksById` — so neither caller has to
// materialize a full Map copy just to sort.
type TrackLookup = { get(id: string): Track | undefined };

export function sortTrackIds(
  trackIds: string[],
  tracksById: TrackLookup,
  field: SortField,
  dir: SortDirection,
): string[] {
  const indexed = trackIds.map((id, index) => ({ id, index }));
  indexed.sort((a, b) => {
    // Tolerate orphan trackIds (ids in `trackIds` with no payload in
    // `tracksById`). The store treats orphans as a transient state that
    // hydration repairs, but a sort can run before that repair. A missing
    // track is treated as a row with all-missing fields, so it sorts to
    // the bottom stably — never throws (a `!` here aborted the entire
    // Array.sort and froze the table on a single stray id).
    const trackA = tracksById.get(a.id);
    const trackB = tracksById.get(b.id);
    const valueA = trackA ? getFieldValue(trackA, field) : undefined;
    const valueB = trackB ? getFieldValue(trackB, field) : undefined;
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

import { describe, expect, it } from "vitest";
import { sortTrackIds } from "./sortComparator";
import type { Track } from "../types";

function buildTrack(id: string, fields: Partial<Track>): Track {
  return {
    id,
    source: { kind: "text", rawLine: id },
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
    ...fields,
  };
}

describe("sortTrackIds", () => {
  const tracks: Track[] = [
    buildTrack("a", { artist: "Radiohead", year: 1997 }),
    buildTrack("b", { artist: "Aphex Twin", year: 1996 }),
    buildTrack("c", { artist: undefined, year: 2003 }),
    buildTrack("d", { artist: "Boards of Canada", year: 1998 }),
  ];
  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  const ids = tracks.map((track) => track.id);

  it("sorts strings ascending", () => {
    expect(sortTrackIds(ids, tracksById, "artist", "asc")).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  it("sorts numbers descending", () => {
    expect(sortTrackIds(ids, tracksById, "year", "desc")).toEqual([
      "c",
      "d",
      "a",
      "b",
    ]);
  });

  it("sorts empty values to the bottom regardless of direction", () => {
    expect(sortTrackIds(ids, tracksById, "artist", "desc").at(-1)).toBe("c");
  });

  it("is stable for tied values", () => {
    const tied = [
      buildTrack("x", { artist: "Same", year: 2000 }),
      buildTrack("y", { artist: "Same", year: 2000 }),
    ];
    const map = new Map(tied.map((t) => [t.id, t]));
    expect(
      sortTrackIds(["x", "y"], map, "artist", "asc"),
    ).toEqual(["x", "y"]);
  });

  // ─── Locale-aware string ordering via Intl.Collator ─────────────────
  //
  // Plain ASCII `<`/`>` on lowercased strings puts "É" after "Z" and
  // case-folds nothing past the toLowerCase() pass. The Collator with
  // `sensitivity: "base"` matches what users expect from a music
  // library — accented letters sort next to their base, mixed case
  // ignored — and `numeric: true` makes "Track 2" precede "Track 10"
  // on a title sort of numbered tracks. These tests pin all three
  // behaviors so a regression to ASCII ordering trips the suite
  // instead of producing baffling user-visible ordering on imports
  // with non-English text.

  it("sorts accented letters adjacent to their base letter (Beyoncé next to Beyonce)", () => {
    const acc = [
      buildTrack("be", { artist: "Beyonce" }),
      buildTrack("zz", { artist: "Zappa" }),
      buildTrack("ba", { artist: "Beyoncé" }),
    ];
    const map = new Map(acc.map((t) => [t.id, t]));
    // ASCII order would put "Beyonc" tail < "Beyoncé" because "é"
    // (U+00E9) > "z" (U+007A); collator instead treats é as a base-e
    // variant and places it next to the unaccented "Beyonce".
    const result = sortTrackIds(["be", "zz", "ba"], map, "artist", "asc");
    expect(result.slice(0, 2).sort()).toEqual(["ba", "be"]);
    expect(result[2]).toBe("zz");
  });

  it("sorts mixed case insensitively (alpha precedes APHEX precedes Boards)", () => {
    const tracks = [
      buildTrack("u", { artist: "APHEX TWIN" }),
      buildTrack("l", { artist: "alpha" }),
      buildTrack("b", { artist: "Boards of Canada" }),
    ];
    const map = new Map(tracks.map((t) => [t.id, t]));
    // sensitivity: "base" — case folded. alpha < APHEX (a vs A but
    // then l < P at position 1) < Boards.
    expect(sortTrackIds(["u", "l", "b"], map, "artist", "asc")).toEqual([
      "l",
      "u",
      "b",
    ]);
  });

  it("orders numbered titles numerically (Track 2 before Track 10)", () => {
    const tracks = [
      buildTrack("t10", { title: "Track 10" }),
      buildTrack("t2", { title: "Track 2" }),
      buildTrack("t1", { title: "Track 1" }),
    ];
    const map = new Map(tracks.map((t) => [t.id, t]));
    // numeric: true — embedded digit runs compare as numbers, not
    // codepoint-by-codepoint, so "Track 2" < "Track 10" the way a
    // human would expect.
    expect(sortTrackIds(["t10", "t2", "t1"], map, "title", "asc")).toEqual([
      "t1",
      "t2",
      "t10",
    ]);
  });

  // ─── trackNo and originalYear coverage ──────────────────────────────
  //
  // The comparator handles five fields. The existing suite covers
  // artist (string) and year (number). The remaining ones (trackNo,
  // originalYear) exercise the same code path but past tests at
  // type-erasure boundaries surfaced "this field accidentally went
  // through the string branch" bugs — pin both as ints.

  it("sorts trackNo as numbers, not lexicographically", () => {
    const tracks = [
      buildTrack("a", { trackNo: 11 }),
      buildTrack("b", { trackNo: 2 }),
      buildTrack("c", { trackNo: 9 }),
    ];
    const map = new Map(tracks.map((t) => [t.id, t]));
    expect(sortTrackIds(["a", "b", "c"], map, "trackNo", "asc")).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("sorts originalYear with the same numeric branch as year", () => {
    const tracks = [
      buildTrack("c", { originalYear: 2010 }),
      buildTrack("a", { originalYear: 1969 }),
      buildTrack("b", { originalYear: 1995 }),
    ];
    const map = new Map(tracks.map((t) => [t.id, t]));
    expect(
      sortTrackIds(["c", "a", "b"], map, "originalYear", "asc"),
    ).toEqual(["a", "b", "c"]);
  });

  // ─── Mixed present/missing numerics ─────────────────────────────────
  //
  // The existing single-direction "missing to bottom" check doesn't
  // exercise the "what if half the rows have no numeric value" path,
  // which is realistic for `year` (often blank on filename-only rows).

  it("mixed present/missing numerics: present in order, missing trailing in original order", () => {
    const tracks = [
      buildTrack("a", { year: 1997 }),
      buildTrack("missing1", { year: undefined }),
      buildTrack("b", { year: 2003 }),
      buildTrack("missing2", { year: undefined }),
      buildTrack("c", { year: 1985 }),
    ];
    const map = new Map(tracks.map((t) => [t.id, t]));
    const result = sortTrackIds(
      ["a", "missing1", "b", "missing2", "c"],
      map,
      "year",
      "asc",
    );
    // Present in ascending order, then missing entries preserving
    // their original (input) order — the documented "missing to
    // bottom regardless of direction" contract for both directions:
    expect(result).toEqual(["c", "a", "b", "missing1", "missing2"]);

    const desc = sortTrackIds(
      ["a", "missing1", "b", "missing2", "c"],
      map,
      "year",
      "desc",
    );
    expect(desc).toEqual(["b", "a", "c", "missing1", "missing2"]);
  });

  it("descending sort still places missing rows at the bottom (NOT the top)", () => {
    const tracks = [
      buildTrack("blank", { year: undefined }),
      buildTrack("old", { year: 1969 }),
      buildTrack("new", { year: 2020 }),
    ];
    const map = new Map(tracks.map((t) => [t.id, t]));
    // Documented invariant — missing-to-bottom is direction-independent
    // so a user's "ascending → descending" toggle never shuffles the
    // unknown pile around the top of the table.
    expect(sortTrackIds(["blank", "old", "new"], map, "year", "desc")).toEqual([
      "new",
      "old",
      "blank",
    ]);
  });
});

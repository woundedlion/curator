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
});

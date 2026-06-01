import { describe, expect, it } from "vitest";
import {
  classifySegments,
  deriveHintsFromFileName,
} from "./filenameHeuristic";

describe("deriveHintsFromFileName", () => {
  it("parses Artist - Title", () => {
    expect(deriveHintsFromFileName("Radiohead - Karma Police.mp3")).toEqual({
      artist: "Radiohead",
      title: "Karma Police",
    });
  });

  it("parses track-numbered Artist - Title", () => {
    expect(deriveHintsFromFileName("03 - Radiohead - Karma Police.mp3")).toEqual(
      { trackNo: 3, artist: "Radiohead", title: "Karma Police" },
    );
  });

  it("parses Artist - Album - Title (three segments)", () => {
    expect(
      deriveHintsFromFileName("Radiohead - OK Computer - Karma Police.mp3"),
    ).toEqual({
      artist: "Radiohead",
      album: "OK Computer",
      title: "Karma Police",
    });
  });

  it("parses Album - Track# - Artist - Title (four segments)", () => {
    expect(
      deriveHintsFromFileName("Dancehall 1 - 15 - Buju Banton - Love Sponge.mp3"),
    ).toEqual({
      trackNo: 15,
      album: "Dancehall 1",
      artist: "Buju Banton",
      title: "Love Sponge",
    });
  });

  it("falls back to title-only when single segment", () => {
    expect(deriveHintsFromFileName("Stargazer.flac")).toEqual({
      title: "Stargazer",
    });
  });

  it("parses leading track number on a single segment (e.g. '03 Stargazer.flac')", () => {
    expect(deriveHintsFromFileName("03 Stargazer.flac")).toEqual({
      trackNo: 3,
      title: "Stargazer",
    });
  });

  it("treats a leading zero-padded track number as its numeric value", () => {
    expect(deriveHintsFromFileName("007 - Radiohead - Karma Police.mp3")).toEqual({
      trackNo: 7,
      artist: "Radiohead",
      title: "Karma Police",
    });
  });

  it("treats a pure-digit filename as title (not as a stray track number)", () => {
    expect(deriveHintsFromFileName("03.mp3")).toEqual({ title: "03" });
  });

  it("parses a leading track number with a dot separator ('03.Title')", () => {
    // A dot counts as a separator just like dash/space, so "03.Stargazer"
    // splits into track 3 + title.
    expect(deriveHintsFromFileName("03.Stargazer.flac")).toEqual({
      trackNo: 3,
      title: "Stargazer",
    });
  });

  it("does NOT split leading digits with no separator ('03Title')", () => {
    // A separator between the digits and the rest is required: "03Stargazer"
    // has none, so the whole segment is kept as the title rather than
    // guessing track 3 (the digits are too ambiguous, cf. "2pac"/"1975").
    expect(deriveHintsFromFileName("03Stargazer.flac")).toEqual({
      title: "03Stargazer",
    });
  });

  it("strips only the final extension segment", () => {
    // The "extension" is everything after the last dot, not the first —
    // titles can legitimately contain periods.
    expect(deriveHintsFromFileName("Mr. Brightside.mp3")).toEqual({
      title: "Mr. Brightside",
    });
  });

  it("parses Artist - Album - TrackNo - Title (4 segments, track at -2)", () => {
    // The dominant convention from rippers (foobar2000, EAC, iTunes
    // export, etc.) — track number sits between album and title.
    expect(
      deriveHintsFromFileName("Radiohead - In Rainbows - 03 - Nude.mp3"),
    ).toEqual({
      trackNo: 3,
      artist: "Radiohead",
      album: "In Rainbows",
      title: "Nude",
    });
  });

  it("parses 5+ segments (track at -2) with one artist and a joined album", () => {
    // "Various Artists - Greatest Hits - Disc 2 - 03 - Title.mp3". The
    // first segment is the artist; the middle segments before the track
    // number join into the album (symmetric with the Pattern B album-join)
    // rather than folding the extra leading segment into the artist.
    expect(
      deriveHintsFromFileName(
        "Various Artists - Greatest Hits - Disc 2 - 03 - Closer.mp3",
      ),
    ).toEqual({
      trackNo: 3,
      artist: "Various Artists",
      album: "Greatest Hits - Disc 2",
      title: "Closer",
    });
  });

  it("does NOT treat 4-digit years as track numbers", () => {
    // "1999 - Prince - 1999.mp3". The leading "1999" is 4 digits, so the
    // segment regex (`\d{1,3}`) rejects it before the value check even
    // runs — no track number is extracted.
    const result = deriveHintsFromFileName("1999 - Prince - 1999.mp3");
    expect(result.trackNo).toBeUndefined();
  });

  it("rejects 4-digit numbers (years) as track numbers", () => {
    // "2017 - Some Title.mp3" — "2017" is 4 digits, so it fails the
    // `\d{1,3}` segment regex and is never considered a track number.
    const result = deriveHintsFromFileName("2017 - Some Title.mp3");
    expect(result.trackNo).toBeUndefined();
  });

  it("accepts a 3-digit number <= 199 as a track number", () => {
    // The guard is the VALUE (<= 199), not the digit count: "150" is
    // three digits but a perfectly plausible position on a boxed set, so
    // it's accepted. This pins the actual behavior the comment describes.
    const result = deriveHintsFromFileName("150 - Some Title.mp3");
    expect(result.trackNo).toBe(150);
  });

  it("rejects out-of-range track numbers (200+)", () => {
    // "456 - Track.mp3" — 3 digits but well above MAX_TRACK_NUMBER (199).
    // The value guard (not the digit count) rejects it. Better to treat
    // as a leading numeric title than to claim it's track 456.
    const result = deriveHintsFromFileName("456 - Track.mp3");
    expect(result.trackNo).toBeUndefined();
  });
});

describe("classifySegments (shared with text-list parser, FIX 2)", () => {
  it("detects an embedded track number in a 4-segment string", () => {
    // The text parser (textParser.ts) routes through this same helper, so
    // pinning it here pins both parsers' behavior for the aligned case.
    expect(
      classifySegments(["Radiohead", "In Rainbows", "03", "Nude"]),
    ).toEqual({
      trackNo: 3,
      artist: "Radiohead",
      album: "In Rainbows",
      title: "Nude",
    });
  });

  it("matches deriveHintsFromFileName for the same separated string", () => {
    const fromName = deriveHintsFromFileName(
      "Radiohead - In Rainbows - 03 - Nude.mp3",
    );
    const fromSegments = classifySegments([
      "Radiohead",
      "In Rainbows",
      "03",
      "Nude",
    ]);
    expect(fromSegments).toEqual(fromName);
  });
});

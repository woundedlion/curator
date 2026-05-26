import { describe, expect, it } from "vitest";
import { deriveHintsFromFileName } from "./filenameHeuristic";

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
});

// @vitest-environment happy-dom
//
// Tests for createPlaybackSource / hasInAppSource — the source-selection
// policy that decides what a play click actually plays. The behavior that
// matters most here (and is easy to regress) is the priority ORDER:
//
//   - A *resolved* Spotify match (status === "matched") prefers full-track
//     Spotify over the local file — but ONLY when the SDK is connected
//     (`sdkReady`). We never trade working local/preview audio for an SDK
//     source that isn't ready.
//   - A 30s preview (immediate, no Premium) out-prioritizes an un-connected
//     SDK, and the local file out-prioritizes the preview.
//   - The SDK takes the LAST-RESORT slot for a Spotify-only, preview-less
//     row, where `sdkInitable` lets the first play kick off lazy init.
//   - Unmatched / ambiguous rows keep the local-file-first order.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlaybackSource,
  hasInAppSource,
  resolveSdkAvailability,
} from "./playbackSource";
import type { SpotifyCandidate, SpotifyMatch, Track } from "../types";

function makeFile(): File {
  return new File(["bytes"], "song.mp3", { type: "audio/mpeg" });
}

function candidate(): SpotifyCandidate {
  return {
    uri: "spotify:track:xyz",
    id: "xyz",
    title: "T",
    artist: "A",
    score: 0.9,
  };
}

function track(spotify: SpotifyMatch, withFile: boolean): Track {
  return {
    id: "t1",
    source: { kind: "file", fileName: "song.mp3" },
    localFile: withFile ? makeFile() : undefined,
    enrichment: { status: "idle" },
    spotify,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const matchedWith = (previewUrl?: string): SpotifyMatch => ({
  status: "matched",
  uri: "spotify:track:xyz",
  candidates: [candidate()],
  score: 0.9,
  previewUrl,
});

describe("createPlaybackSource — matched rows prefer Spotify when the SDK is connected", () => {
  it("plays full-track Spotify over the local file when matched and the SDK is READY", () => {
    // sdkReady=true → the matched jump-ahead beats the local file.
    const source = createPlaybackSource(track(matchedWith(), true), true, true);
    expect(source.kind).toBe("spotify-sdk");
    if (source.kind === "spotify-sdk") {
      expect(source.uri).toBe("spotify:track:xyz");
    }
  });

  it("plays the local file when matched but the SDK is only INITABLE (not yet connected)", () => {
    // sdkReady=false → never trade a working local file for an un-connected
    // SDK source, even though the user opted in (sdkInitable=true).
    const source = createPlaybackSource(track(matchedWith(), true), false, true);
    expect(source.kind).toBe("local");
  });

  it("plays the local file (not a 30s preview) when matched and the SDK is unavailable", () => {
    const source = createPlaybackSource(
      track(matchedWith("https://example.test/p.mp3"), true),
      false,
      false,
    );
    expect(source.kind).toBe("local");
  });

  it("plays the local file first for an UNMATCHED row even with the SDK ready", () => {
    const source = createPlaybackSource(track({ status: "idle" }, true), true, true);
    expect(source.kind).toBe("local");
  });

  it("prefers the 30s preview over an un-connected SDK for a Spotify-only matched row", () => {
    // No local file, has preview, SDK initable-but-not-ready → preview
    // wins so a non-Premium user still hears audio immediately.
    const source = createPlaybackSource(
      track(matchedWith("https://example.test/p.mp3"), false),
      false,
      true,
    );
    expect(source.kind).toBe("spotify-preview");
  });

  it("uses the SDK as a last resort for a preview-less Spotify-only row (kicks off lazy init)", () => {
    // No local file, no preview, SDK initable → emit the SDK source so the
    // first play lazily initializes the SDK (issue 3).
    const source = createPlaybackSource(track(matchedWith(), false), false, true);
    expect(source.kind).toBe("spotify-sdk");
  });

  it("plays full-track Spotify for an ambiguous round-tripped URI when the SDK is ready", () => {
    const ambiguous: SpotifyMatch = {
      status: "ambiguous",
      uri: "spotify:track:xyz",
      candidates: [candidate()],
      score: 0.5,
    };
    const source = createPlaybackSource(track(ambiguous, false), true, true);
    expect(source.kind).toBe("spotify-sdk");
  });

  it("returns none for a sourceless row (no file, no preview, SDK unavailable)", () => {
    const source = createPlaybackSource(
      track({ status: "missing" }, false),
      false,
      false,
    );
    expect(source.kind).toBe("none");
  });
});

describe("resolveSdkAvailability — single source of SDK-priority truth", () => {
  it("'ready' yields sdkReady AND sdkInitable regardless of opt-in", () => {
    expect(resolveSdkAvailability("ready", false)).toEqual({
      sdkReady: true,
      sdkInitable: true,
    });
  });

  it("opted-in but not yet connected ('off'/'loading') is initable but not ready", () => {
    expect(resolveSdkAvailability("off", true)).toEqual({
      sdkReady: false,
      sdkInitable: true,
    });
    expect(resolveSdkAvailability("loading", true)).toEqual({
      sdkReady: false,
      sdkInitable: true,
    });
  });

  it("not opted-in is neither ready nor initable", () => {
    expect(resolveSdkAvailability("off", false)).toEqual({
      sdkReady: false,
      sdkInitable: false,
    });
  });

  it("'unavailable' closes the SDK for the session even when opted-in", () => {
    expect(resolveSdkAvailability("unavailable", true)).toEqual({
      sdkReady: false,
      sdkInitable: false,
    });
  });
});

describe("hasInAppSource", () => {
  it("is true for a local file regardless of SDK", () => {
    expect(hasInAppSource(track({ status: "idle" }, true), false)).toBe(true);
  });

  it("is false for a Spotify-only row when the user hasn't opted into the SDK and there's no preview", () => {
    const matched: SpotifyMatch = {
      status: "matched",
      uri: "spotify:track:xyz",
      candidates: [candidate()],
      score: 0.9,
    };
    expect(hasInAppSource(track(matched, false), false)).toBe(false);
  });

  it("is true for a Spotify-only row when the user has opted into the SDK", () => {
    const matched: SpotifyMatch = {
      status: "matched",
      uri: "spotify:track:xyz",
      candidates: [candidate()],
      score: 0.9,
    };
    expect(hasInAppSource(track(matched, false), true)).toBe(true);
  });
});

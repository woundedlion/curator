import { describe, expect, it } from "vitest";
import type { SpotifyCandidate } from "../types";
import {
  TRACK_DRAG_MIME,
  dragHasTrack,
  getTrackCandidateFromDrag,
  setTrackDragPayload,
} from "./dragData";

// Minimal DataTransfer fake — happy-dom's DataTransfer doesn't round-trip
// custom MIME types reliably, so we model just the surface dragData uses.
function fakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
    get types() {
      return Array.from(store.keys());
    },
    effectAllowed: "none",
  } as unknown as DataTransfer;
}

const candidate: SpotifyCandidate = {
  uri: "spotify:track:abc",
  id: "abc",
  title: "No Surprises",
  artist: "Radiohead",
  score: 0.9,
};

describe("track drag payload (§4.7.3)", () => {
  it("round-trips a candidate through the track MIME", () => {
    const dt = fakeDataTransfer();
    setTrackDragPayload(dt, candidate);
    expect(dragHasTrack(dt)).toBe(true);
    expect(dt.types).toContain(TRACK_DRAG_MIME);
    expect(getTrackCandidateFromDrag(dt)).toEqual(candidate);
  });

  it("reports no track payload on an empty DataTransfer", () => {
    const dt = fakeDataTransfer();
    expect(dragHasTrack(dt)).toBe(false);
    expect(getTrackCandidateFromDrag(dt)).toBeNull();
  });

  it("returns null on malformed JSON rather than throwing", () => {
    const dt = fakeDataTransfer();
    dt.setData(TRACK_DRAG_MIME, "{not json");
    expect(getTrackCandidateFromDrag(dt)).toBeNull();
  });

  it("returns null when the payload lacks a uri", () => {
    const dt = fakeDataTransfer();
    dt.setData(TRACK_DRAG_MIME, JSON.stringify({ id: "x" }));
    expect(getTrackCandidateFromDrag(dt)).toBeNull();
  });

  it("tolerates a null DataTransfer", () => {
    expect(dragHasTrack(null)).toBe(false);
    expect(getTrackCandidateFromDrag(null)).toBeNull();
  });
});

import type { SpotifyCandidate } from "../types";

export const PLAYLIST_DRAG_MIME = "application/x-curator-playlist";
// A single Spotify track dragged out of an expanded sidebar playlist
// (DESIGN §4.7.3). Distinct MIME from the whole-playlist drag so the
// playlist table can route it to a positional insert while the window-level
// DropZone (which only reacts to files / the playlist MIME) ignores it.
export const TRACK_DRAG_MIME = "application/x-curator-track";

export function getPlaylistIdFromDrag(dt: DataTransfer | null): string | null {
  if (!dt) return null;
  const id = dt.getData(PLAYLIST_DRAG_MIME);
  return id ? id : null;
}

// True when the drag carries a single-track payload. Uses `types` (not
// getData) so it works during `dragover`, where the spec hides payload data
// from script until `drop`.
export function dragHasTrack(dt: DataTransfer | null): boolean {
  return dt?.types.includes(TRACK_DRAG_MIME) ?? false;
}

export function setTrackDragPayload(
  dt: DataTransfer | null,
  candidate: SpotifyCandidate,
): void {
  if (!dt) return;
  dt.setData(TRACK_DRAG_MIME, JSON.stringify(candidate));
  dt.effectAllowed = "copy";
}

// Parse the dragged track candidate at drop time. Returns null on a missing
// or malformed payload (corrupt clipboard, a foreign drag that happens to
// share the MIME) so callers can bail without throwing.
export function getTrackCandidateFromDrag(
  dt: DataTransfer | null,
): SpotifyCandidate | null {
  if (!dt) return null;
  const raw = dt.getData(TRACK_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SpotifyCandidate;
    if (!parsed || typeof parsed.uri !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setPlaylistDragPayload(
  dt: DataTransfer | null,
  playlistId: string,
  // This sets `effectAllowed`, whose value set differs from `dropEffect`
  // (it includes the combined forms like "copyMove"); type it accordingly
  // so callers can't pass a value that's only valid for `dropEffect`.
  effectAllowed: DataTransfer["effectAllowed"] = "copy",
): void {
  if (!dt) return;
  dt.setData(PLAYLIST_DRAG_MIME, playlistId);
  dt.effectAllowed = effectAllowed;
}

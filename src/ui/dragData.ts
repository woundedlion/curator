export const PLAYLIST_DRAG_MIME = "application/x-curator-playlist";

export function getPlaylistIdFromDrag(dt: DataTransfer | null): string | null {
  if (!dt) return null;
  const id = dt.getData(PLAYLIST_DRAG_MIME);
  return id ? id : null;
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

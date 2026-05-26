export const PLAYLIST_DRAG_MIME = "application/x-curator-playlist";

export function getPlaylistIdFromDrag(dt: DataTransfer | null): string | null {
  if (!dt) return null;
  const id = dt.getData(PLAYLIST_DRAG_MIME);
  return id ? id : null;
}

export function setPlaylistDragPayload(
  dt: DataTransfer | null,
  playlistId: string,
  effect: DataTransfer["dropEffect"] = "copy",
): void {
  if (!dt) return;
  dt.setData(PLAYLIST_DRAG_MIME, playlistId);
  dt.effectAllowed = effect;
}

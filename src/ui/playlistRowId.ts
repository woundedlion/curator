// Stable DOM id for a track's row in the playlist grid.
//
// Lives in its own module (not PlaylistTable.tsx) so PlaylistTable can
// stay a component-only export — the react-refresh lint rule flags a
// non-component export from a file that also exports components, and we
// keep the lint surface at exactly the one tolerated TanStack warning.
//
// The rows are VIRTUALIZED — the row holding the keyboard cursor can
// unmount when scrolled out of view — so DOM focus can't live on the
// row itself (it would be lost on unmount). Instead the focusable grid
// container carries aria-activedescendant pointing at this id, which
// screen readers resolve to the rendered row when present. The id is
// derived purely from the track id so it's identical between the
// container's activedescendant and the row's own id attribute.
export function rowDomId(trackId: string): string {
  return `playlist-row-${trackId}`;
}

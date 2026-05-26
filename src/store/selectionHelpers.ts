// Pure helpers for selection / multi-move logic. Kept separate from
// playlistStore so they're trivially unit-testable.

export function rangeBetween(
  visibleIds: string[],
  anchorId: string | null,
  targetId: string,
): string[] {
  if (anchorId === null) return [targetId];
  const a = visibleIds.indexOf(anchorId);
  const b = visibleIds.indexOf(targetId);
  if (a === -1 || b === -1) return [targetId];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return visibleIds.slice(lo, hi + 1);
}

// Reorder `allIds` so that every id in `selectedIds` becomes a single
// contiguous block inserted just before `targetId` (in the surviving order).
// Non-contiguous selections collapse: gaps between selected rows close.
//
// Rules:
// - If `targetId` is itself in `selectedIds`, no move (returns input).
// - The block preserves the relative order from `allIds`, not the order
//   the selection was built up in.
// - Returns the same reference if nothing changes.
export function moveSelectionBlock(
  allIds: string[],
  selectedIds: ReadonlyArray<string> | ReadonlySet<string>,
  targetId: string,
): string[] {
  const selectedSet =
    selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  if (selectedSet.size === 0) return allIds;
  if (selectedSet.has(targetId)) return allIds;

  const block: string[] = [];
  const rest: string[] = [];
  for (const id of allIds) {
    if (selectedSet.has(id)) block.push(id);
    else rest.push(id);
  }
  if (block.length === 0) return allIds;

  const insertAt = rest.indexOf(targetId);
  if (insertAt === -1) return allIds;

  const next = [
    ...rest.slice(0, insertAt),
    ...block,
    ...rest.slice(insertAt),
  ];

  // Fast no-op check.
  let changed = next.length !== allIds.length;
  if (!changed) {
    for (let i = 0; i < next.length; i++) {
      if (next[i] !== allIds[i]) {
        changed = true;
        break;
      }
    }
  }
  return changed ? next : allIds;
}

// Move the selection block to the very end of `allIds` (used when the user
// drops past the last row).
export function moveSelectionBlockToEnd(
  allIds: string[],
  selectedIds: ReadonlyArray<string> | ReadonlySet<string>,
): string[] {
  const selectedSet =
    selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  if (selectedSet.size === 0) return allIds;

  const block: string[] = [];
  const rest: string[] = [];
  for (const id of allIds) {
    if (selectedSet.has(id)) block.push(id);
    else rest.push(id);
  }
  if (block.length === 0) return allIds;

  const next = [...rest, ...block];
  let changed = next.length !== allIds.length;
  if (!changed) {
    for (let i = 0; i < next.length; i++) {
      if (next[i] !== allIds[i]) {
        changed = true;
        break;
      }
    }
  }
  return changed ? next : allIds;
}

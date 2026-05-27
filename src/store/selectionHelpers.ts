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

// Move a multi-row selection while preserving its *shape* (the gaps between
// selected rows) as much as the array's bounds allow. This is the drop
// semantics used by the table's group-drag (§4.2): selected items keep
// their relative offsets from the actively-dragged row whenever possible;
// only when an offset would push a row off the end of the list do the gaps
// shrink (from the far end first). Unselected items keep their original
// relative order and fill the slots the selection didn't claim.
//
// Worked examples for `[A, B, C, D]`, selection `{A, C}`:
//   - drag A "below B" (over = B, target index 1)
//       → A lands at 1, C wants 1+2=3 (fits), unselected [B,D] fill [0,2]
//       → [B, A, D, C]
//   - drag A "below D" (over = D, target index 3)
//       → A is clamped to 2 (needs room for C after it), C clamps to 3,
//         gap collapses because there's nothing left between them
//       → [B, D, A, C]
//
// `activeId` must be one of the selected ids — it's the row the user
// physically grabbed, and its target position drives the placement of the
// rest of the block. `overId` is the unselected drop target (a row in
// `selectedIds` returns the input unchanged, matching the "drop on self"
// guard in the existing `moveSelectionBlock`).
//
// Returns the same reference when nothing changes.
export function moveSelectionMaintainingShape(
  visibleIds: string[],
  selectedIds: ReadonlySet<string>,
  activeId: string,
  overId: string,
): string[] {
  if (selectedIds.size === 0) return visibleIds;
  if (!selectedIds.has(activeId)) return visibleIds;
  if (selectedIds.has(overId)) return visibleIds;

  const len = visibleIds.length;

  // Partition into selected (carrying original index for offset math) and
  // unselected (used to fill the remaining slots in original order).
  const selected: { id: string; origIndex: number }[] = [];
  const unselected: string[] = [];
  for (let i = 0; i < len; i++) {
    const id = visibleIds[i];
    if (selectedIds.has(id)) selected.push({ id, origIndex: i });
    else unselected.push(id);
  }
  if (selected.length === 0) return visibleIds;

  const activeIdx = selected.findIndex((s) => s.id === activeId);
  if (activeIdx === -1) return visibleIds;
  const activeOrigIndex = selected[activeIdx].origIndex;

  const targetOrigIndex = visibleIds.indexOf(overId);
  if (targetOrigIndex === -1) return visibleIds;

  // The actively-dragged row's new position is wherever the over-row sits
  // (dnd-kit convention with verticalListSortingStrategy: the dragged item
  // takes the over-item's slot). Clamp to leave room for the other selected
  // items on either side — without this clamp we'd compute placements that
  // can't fit and the secondary passes would push items past array bounds.
  const beforeCount = activeIdx;
  const afterCount = selected.length - 1 - activeIdx;
  const activeMin = beforeCount;
  const activeMax = len - 1 - afterCount;
  const activeTarget = Math.max(
    activeMin,
    Math.min(targetOrigIndex, activeMax),
  );

  const positions = new Array<number>(selected.length);
  positions[activeIdx] = activeTarget;

  // Items after the active row: try to keep their original offset from the
  // active row; clamp from the right so they don't run off the end, and
  // bump forward so they don't overlap the previous selected item.
  for (let i = activeIdx + 1; i < selected.length; i++) {
    const offset = selected[i].origIndex - activeOrigIndex;
    const desired = activeTarget + offset;
    const earliest = positions[i - 1] + 1;
    const remainingAfter = selected.length - 1 - i;
    const latest = len - 1 - remainingAfter;
    positions[i] = Math.max(earliest, Math.min(desired, latest));
  }

  // Items before the active row: mirror the forward pass. The offset here
  // is negative (origIndex < activeOrigIndex).
  for (let i = activeIdx - 1; i >= 0; i--) {
    const offset = selected[i].origIndex - activeOrigIndex;
    const desired = activeTarget + offset;
    const latest = positions[i + 1] - 1;
    const earliest = i;
    positions[i] = Math.min(latest, Math.max(desired, earliest));
  }

  const result = new Array<string | null>(len).fill(null);
  for (let i = 0; i < selected.length; i++) {
    result[positions[i]] = selected[i].id;
  }
  let u = 0;
  for (let i = 0; i < len; i++) {
    if (result[i] === null) result[i] = unselected[u++];
  }

  // Fast no-op check: if every slot already matches the input, return the
  // original reference so callers can shallow-compare for change detection.
  let changed = false;
  for (let i = 0; i < len; i++) {
    if (result[i] !== visibleIds[i]) {
      changed = true;
      break;
    }
  }
  return changed ? (result as string[]) : visibleIds;
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

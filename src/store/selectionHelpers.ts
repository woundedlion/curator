// Pure helpers for selection / multi-move logic. Kept separate from
// playlistStore so they're trivially unit-testable.

export function rangeBetween(
  visibleIds: readonly string[],
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

// Move a multi-row selection while preserving its *shape* — the gaps
// between selected rows stay constant as the selection moves, and the
// unselected rows flow one at a time through those gaps. Gaps collapse
// ONLY when the selection is pushed against an array boundary (a selected
// row would otherwise land off the end). This is the drop semantics used
// by the table's group-drag (§4.2).
//
// Each selected row keeps its original offset from the grabbed (active)
// row. The subtlety that makes the motion feel right is how the active
// row's landing slot (`activeTarget`) is derived: it counts only the
// UNSELECTED rows the cursor has crossed, so dragging past one row moves
// the selection by exactly one slot — even when selected rows sit between
// the active row and the cursor. (Deriving it from the raw over-index
// instead, as a naive version would, makes the block jump in
// selection-sized steps — e.g. a 2-row selection lurching 2 slots at a
// time, which reads as "it won't move one-by-one".)
//
// Worked examples for `[A, B, C, D]`, selection `{A, C}`:
//   - grab A, drag down over B → A→1, C keeps its +2 offset → [B, A, D, C]
//     (D flows into the gap; B moves above).
//   - grab A, drag down over D → C would want index 4 (off the end), so the
//     gap collapses at the boundary → [B, D, A, C].
//
// `activeId` must be a selected id (the row physically grabbed). `overId`
// is the unselected drop target; a selected `overId` returns the input
// unchanged (the "drop on self" guard). Returns the same reference when
// nothing changes.
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
    const id = visibleIds[i]!;
    if (selectedIds.has(id)) selected.push({ id, origIndex: i });
    else unselected.push(id);
  }
  if (selected.length === 0) return visibleIds;

  const activeIdx = selected.findIndex((s) => s.id === activeId);
  if (activeIdx === -1) return visibleIds;
  const activeOrigIndex = selected[activeIdx]!.origIndex;

  const overOrigIndex = visibleIds.indexOf(overId);
  if (overOrigIndex === -1) return visibleIds;

  // Smooth target for the active row: count only the UNSELECTED rows that
  // sit before the drop point, so crossing one row shifts the selection by
  // exactly one slot. Dragging DOWN (over below active) lands the active
  // row just AFTER the over-row; dragging UP lands it just BEFORE. Selected
  // rows that precede the active one still occupy slots, so add them back.
  const overInUnselected = unselected.indexOf(overId);
  const draggingDown = overOrigIndex > activeOrigIndex;
  const insertAmongUnselected = draggingDown
    ? overInUnselected + 1
    : overInUnselected;
  const selectedBeforeActive = activeIdx; // selected[] is in original order
  let activeTarget = insertAmongUnselected + selectedBeforeActive;

  // Clamp so the whole block fits — this is the only place gaps collapse,
  // and only because a selected row would otherwise fall off an end.
  const beforeCount = activeIdx;
  const afterCount = selected.length - 1 - activeIdx;
  const activeMin = beforeCount;
  const activeMax = len - 1 - afterCount;
  activeTarget = Math.max(activeMin, Math.min(activeTarget, activeMax));

  const positions = new Array<number>(selected.length);
  positions[activeIdx] = activeTarget;

  // Items after the active row: keep their original offset from the active
  // row; clamp from the right so they don't run off the end, and bump
  // forward so they don't overlap the previous selected item (this is where
  // a trailing gap collapses at the bottom boundary).
  for (let i = activeIdx + 1; i < selected.length; i++) {
    const offset = selected[i]!.origIndex - activeOrigIndex;
    const desired = activeTarget + offset;
    const earliest = positions[i - 1]! + 1;
    const remainingAfter = selected.length - 1 - i;
    const latest = len - 1 - remainingAfter;
    positions[i] = Math.max(earliest, Math.min(desired, latest));
  }

  // Items before the active row: mirror the forward pass (negative offset).
  for (let i = activeIdx - 1; i >= 0; i--) {
    const offset = selected[i]!.origIndex - activeOrigIndex;
    const desired = activeTarget + offset;
    const latest = positions[i + 1]! - 1;
    const earliest = i;
    positions[i] = Math.min(latest, Math.max(desired, earliest));
  }

  const result = new Array<string | null>(len).fill(null);
  for (let i = 0; i < selected.length; i++) {
    result[positions[i]!] = selected[i]!.id;
  }
  let u = 0;
  for (let i = 0; i < len; i++) {
    if (result[i] === null) result[i] = unselected[u++] ?? null;
  }

  // Fast no-op check: return the original reference when nothing moved so
  // callers can shallow-compare for change detection.
  for (let i = 0; i < len; i++) {
    if (result[i] !== visibleIds[i]) return result as string[];
  }
  return visibleIds;
}

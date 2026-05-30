// Pure keyboard-navigation helper for the playlist table. Computes the
// next cursor / anchor / selection from a key press; the React hook
// (useTableKeyboardNav) is the only caller and is responsible for the
// side effects (store writes, scroll-to-index).
//
// Separated from the hook so the state-machine semantics are trivially
// unit-testable in node env without React or DOM.

import { rangeBetween } from "../store/selectionHelpers";

const NAV_KEYS = [
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const;

export type NavKey = (typeof NAV_KEYS)[number];

export function isNavKey(key: string): key is NavKey {
  return (NAV_KEYS as readonly string[]).includes(key);
}

export type KeyboardNavInput = {
  key: NavKey;
  shift: boolean;
  visibleIds: readonly string[];
  /**
   * Last id the keyboard nav landed on (or the last clicked id when no
   * arrow has been pressed yet). null means "no cursor yet" — the first
   * arrow press will land on the first visible row.
   */
  cursor: string | null;
  /**
   * Pivot for shift-extend ranges. Matches the store's selectionAnchorId.
   * When invalid (null or no longer visible), the helper falls back to the
   * target row as effective anchor, so Shift+Arrow on an empty/filtered
   * state degrades to a single-select rather than producing a stale range.
   */
  anchor: string | null;
  /**
   * Rows per viewport for PageUp/PageDown. Always at least 1 in practice;
   * we clamp to 1 defensively so a zero-height container can't no-op the
   * page step.
   */
  pageSize: number;
};

export type KeyboardNavStep = {
  selection: string[];
  anchor: string | null;
  cursor: string;
  cursorIndex: number;
};

/**
 * Derive the "moving end" of a shift-extend range — the id furthest from
 * `anchor` in `selection`, measured by visible-list index. This is what
 * Shift+Arrow advances from, so that:
 *
 *   - After Click 5, Shift+Click 7: anchor=5, selection={5,6,7}, end=7.
 *     Shift+ArrowDown then moves to 8 (not 6).
 *   - After Click 5, Cmd+Click 8: anchor=8, selection={5,8}. Plain
 *     ArrowDown uses anchor → 9. Shift+ArrowDown uses derived end → the
 *     id farthest from 8 (which is 5) and shifts toward anchor.
 *
 * Returns null only when the selection is empty.
 */
export function deriveExtendEnd(
  selection: ReadonlySet<string>,
  anchor: string | null,
  visibleIds: readonly string[],
): string | null {
  if (selection.size === 0) return null;
  const anchorIdx =
    anchor !== null ? visibleIds.indexOf(anchor) : -1;
  if (anchorIdx === -1) {
    // No valid anchor — pick the first selected id in visible order so
    // shift-extend has something coherent to grow from.
    for (const id of visibleIds) if (selection.has(id)) return id;
    return null;
  }
  let bestId: string = anchor!;
  let bestDist = 0;
  for (let i = 0; i < visibleIds.length; i++) {
    const id = visibleIds[i]!;
    if (!selection.has(id)) continue;
    const dist = Math.abs(i - anchorIdx);
    if (dist > bestDist) {
      bestDist = dist;
      bestId = id;
    }
  }
  return bestId;
}

export function computeKeyboardNavStep(
  input: KeyboardNavInput,
): KeyboardNavStep | null {
  const { key, shift, visibleIds, cursor, anchor, pageSize } = input;
  if (visibleIds.length === 0) return null;
  const cursorIdx = cursor ? visibleIds.indexOf(cursor) : -1;
  const last = visibleIds.length - 1;
  const step = Math.max(1, pageSize);
  let nextIdx: number;
  switch (key) {
    case "ArrowDown":
      nextIdx = cursorIdx < 0 ? 0 : Math.min(last, cursorIdx + 1);
      break;
    case "ArrowUp":
      // No-cursor ArrowUp lands on row 0 (same as ArrowDown) so the user
      // gets an entry point either way; "above nothing" has no sensible
      // alternative.
      nextIdx = cursorIdx < 0 ? 0 : Math.max(0, cursorIdx - 1);
      break;
    case "PageDown":
      nextIdx = cursorIdx < 0 ? 0 : Math.min(last, cursorIdx + step);
      break;
    case "PageUp":
      nextIdx = cursorIdx < 0 ? 0 : Math.max(0, cursorIdx - step);
      break;
    case "Home":
      nextIdx = 0;
      break;
    case "End":
      nextIdx = last;
      break;
    default: {
      // Exhaustiveness guard: `key` is the closed NavKey union, so this
      // branch is statically unreachable. Adding a 7th NavKey without a
      // matching case makes `_exhaustive` fail to be assignable from
      // `never` here — a compile error rather than a silent fall-through
      // that would leave `nextIdx` unassigned.
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
  // nextIdx is always clamped to [0, last], so visibleIds[nextIdx] is
  // defined as long as visibleIds is non-empty (guarded above).
  const nextCursor = visibleIds[nextIdx]!;
  if (!shift) {
    return {
      selection: [nextCursor],
      anchor: nextCursor,
      cursor: nextCursor,
      cursorIndex: nextIdx,
    };
  }
  const effectiveAnchor =
    anchor !== null && visibleIds.includes(anchor) ? anchor : nextCursor;
  const selection = rangeBetween(visibleIds, effectiveAnchor, nextCursor);
  return {
    selection,
    anchor: effectiveAnchor,
    cursor: nextCursor,
    cursorIndex: nextIdx,
  };
}

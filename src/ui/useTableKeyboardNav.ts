import { useEffect, useRef, type RefObject } from "react";
import { usePlaylistStore } from "../store/playlistStore";
import {
  computeKeyboardNavStep,
  deriveExtendEnd,
  isNavKey,
} from "./keyboardNav";

export type TableKeyboardNavOptions = {
  /** Live visible-row id list (after hide-unmatched filter). */
  visibleTrackIds: readonly string[];
  /**
   * Returns the current page size (rows per viewport) at call time —
   * recomputed per keystroke so a resized window or sidebar toggle
   * doesn't paginate against stale dimensions.
   */
  getPageSize: () => number;
  /**
   * Scroll the virtualizer so the row at `index` is in view. Called
   * after every arrow / Home / End / Page step; safe to no-op when the
   * row is already visible.
   */
  scrollToIndex: (index: number) => void;
  /**
   * Invoked when the user presses Delete / Backspace with a non-empty
   * selection. The owner is responsible for the confirm dialog (the
   * keyboard hook deliberately stays out of UI policy decisions).
   */
  onDeleteSelection: () => void;
  /**
   * Ref to the grid container. The window-level handler only acts on
   * table-nav keys when keyboard focus is within the grid (or nothing
   * outside it holds focus), so arrows / Delete aren't hijacked when the
   * user is interacting with an unrelated focusable elsewhere on the page.
   */
  gridRef?: RefObject<HTMLElement | null>;
};

function targetIsTypingSurface(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, button, a, [contenteditable="true"]',
    ),
  );
}

/**
 * Window-level keyboard handlers for the playlist table:
 *
 *   Esc                  clear selection (no-op when empty)
 *   Delete / Backspace   call onDeleteSelection (which owns confirm UI)
 *   ArrowUp / ArrowDown  move cursor by 1 row, single-select
 *   Home / End           jump to first/last visible row, single-select
 *   PageUp / PageDown    jump by one viewport, single-select
 *   Shift + any nav key  extend selection from anchor through new cursor
 *
 * Empty-state behavior: with no current selection, ArrowDown (or any nav
 * key) lands on the first visible row, giving a keyboard entry point
 * symmetric to the mouse rubber-band.
 *
 * The handler bails when focus is on a typing surface (input/textarea/
 * select/button/anchor/contenteditable) so the per-row icon buttons keep
 * their own Enter/Space/Delete semantics and inline forms aren't hijacked.
 */
export function useTableKeyboardNav(options: TableKeyboardNavOptions): void {
  const { visibleTrackIds, getPageSize, scrollToIndex, onDeleteSelection, gridRef } =
    options;

  // Mirror the live arguments into refs synced via a commit-phase
  // effect. The window keydown effect attaches ONCE (empty deps) and
  // reads via the refs; without this, every change to visibleTrackIds
  // (firing on every status flip when hideUnmatched is on) would
  // re-attach the window listener and rerun the cleanup. Keyboard
  // events fire after commit, so the brief render→commit window where
  // the ref still points at the prior value is unobservable in
  // practice.
  const visibleIdsRef = useRef(visibleTrackIds);
  const getPageSizeRef = useRef(getPageSize);
  const scrollToIndexRef = useRef(scrollToIndex);
  const onDeleteSelectionRef = useRef(onDeleteSelection);
  const gridRefRef = useRef(gridRef);
  useEffect(() => {
    visibleIdsRef.current = visibleTrackIds;
    getPageSizeRef.current = getPageSize;
    scrollToIndexRef.current = scrollToIndex;
    onDeleteSelectionRef.current = onDeleteSelection;
    gridRefRef.current = gridRef;
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (targetIsTypingSurface(e.target)) return;

      // Scope to the grid: if some focusable element OUTSIDE the grid
      // currently holds focus, let it own the keystroke rather than
      // hijacking arrows / Delete into table navigation. We deliberately
      // do NOT bail when focus is on <body> (nothing focused) so the table
      // still responds as the page's primary content; targetIsTypingSurface
      // above already excludes inputs/buttons/anchors.
      const gridEl = gridRefRef.current?.current ?? null;
      const active = document.activeElement;
      if (
        gridEl &&
        active &&
        active !== document.body &&
        !gridEl.contains(active)
      ) {
        return;
      }

      const store = usePlaylistStore.getState();
      const selection = store.selectedTrackIds;
      const visibleIds = visibleIdsRef.current;

      if (e.key === "Escape") {
        if (selection.size === 0) return;
        store.clearSelection();
        e.preventDefault();
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selection.size === 0) return;
        onDeleteSelectionRef.current();
        e.preventDefault();
        return;
      }

      if (!isNavKey(e.key)) return;

      // No current selection AND no shift: defer to browser scroll
      // behavior unless the user clearly wants to navigate into the
      // table (any nav key with selection, or arrow with anchor). The
      // empty-selection ArrowDown case is the one explicit entry-point
      // we provide; see jumpInFromEmpty below.
      const anchor = store.selectionAnchorId;
      const jumpInFromEmpty = selection.size === 0 && anchor === null;
      if (jumpInFromEmpty && visibleIds.length === 0) return;

      // For plain (non-shift) nav, resume from anchor. For shift-extend,
      // resume from the moving end of the current range, which after a
      // shift-click or Cmd-click can differ from anchor.
      const cursor = e.shiftKey
        ? deriveExtendEnd(selection, anchor, visibleIds)
        : anchor;

      const step = computeKeyboardNavStep({
        key: e.key,
        shift: e.shiftKey,
        visibleIds,
        cursor,
        anchor,
        pageSize: getPageSizeRef.current(),
      });
      if (!step) return;

      e.preventDefault();
      if (e.shiftKey) {
        store.setSelection(step.selection, step.anchor);
      } else {
        store.selectOnly(step.cursor);
      }
      scrollToIndexRef.current(step.cursorIndex);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

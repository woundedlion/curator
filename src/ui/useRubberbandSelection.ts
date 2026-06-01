import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { ROW_HEIGHT_PX } from "../constants";
import { usePlaylistStore } from "../store/playlistStore";

// Distance the pointer must travel before a press becomes a rubber-band
// drag (rather than a click). Matches dnd-kit's activation distance so
// the two interaction models feel symmetric.
const RUBBERBAND_THRESHOLD_PX = 6;

// Edge auto-scroll: while a marquee drag is active and the pointer sits
// within this many pixels of the scroll viewport's top/bottom edge, the
// container scrolls so the user can extend the selection past the
// visible rows in a single gesture. Scroll speed ramps with edge
// proximity (0 at the band boundary → AUTO_SCROLL_MAX_PX_PER_FRAME at
// the very edge) for a smooth, controllable pull.
const AUTO_SCROLL_EDGE_PX = 48;
const AUTO_SCROLL_MAX_PX_PER_FRAME = 18;

export type RubberbandRect = {
  // Viewport-relative pixel coordinates for the visible rectangle.
  left: number;
  top: number;
  width: number;
  height: number;
};

type PendingPointerState = {
  startClientX: number;
  startClientY: number;
  startContainerY: number;
  // Whether shift/meta/ctrl was held at press-down — additive vs replace.
  additive: boolean;
  // Selection ids before the rubber-band started (used for additive merge).
  baselineSelection: ReadonlySet<string>;
  // Selection anchor before the rubber-band started. Preserved through the
  // drag so a following Shift+Click / Shift+Arrow still extends from the
  // same origin — a marquee should not destroy the shift-extend pivot.
  baselineAnchorId: string | null;
  // Once movement exceeds the threshold we flip to true and start rendering.
  active: boolean;
  pointerId: number;
};

// Value-equality for two id sets (order-independent). Used to skip
// redundant store writes when a pointermove / auto-scroll frame computes
// the exact same selection as the last one we committed — mirrors the
// `sameOrder` short-circuit in usePlaylistDragAndDrop.
function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // Anything inside an actionable control or marked as no-rubberband bails.
  return Boolean(
    target.closest(
      'button, a, input, select, textarea, [role="button"], [data-no-rubberband="true"]',
    ),
  );
}

export type RubberbandHandlers = {
  onContainerPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  rubberbandRect: RubberbandRect | null;
  /**
   * Set true for one tick after a rubber-band drag ends. The row-click
   * handler reads this to swallow the synthetic click the browser will
   * fire on the press-down target so the drag doesn't also act as a
   * selection click; the click handler resets it to false after
   * consuming, hence the mutable ref shape.
   */
  suppressClickRef: MutableRefObject<boolean>;
};

/**
 * Rubber-band (marquee) selection: press on empty table space, drag a
 * rectangle, release. Selection updates live as the rect grows; ids
 * are computed against a snapshot of `visibleTrackIds` taken at
 * press-down, so a concurrent sort or filter change can't shift indices
 * mid-drag.
 *
 * shift/meta/ctrl at press-down → additive (merge with prior selection).
 */
export function useRubberbandSelection(
  parentRef: RefObject<HTMLElement | null>,
  visibleTrackIds: readonly string[],
): RubberbandHandlers {
  const selectedTrackIds = usePlaylistStore((state) => state.selectedTrackIds);
  const setSelection = usePlaylistStore((state) => state.setSelection);

  const pendingRef = useRef<PendingPointerState | null>(null);
  const suppressClickRef = useRef(false);
  const [rubberbandRect, setRubberbandRect] = useState<RubberbandRect | null>(
    null,
  );

  // Snapshot of the visible-id list at press-down; rubber-band selection
  // is computed against this, so a sort or filter change mid-drag can't
  // corrupt the index math.
  const visibleAtPressRef = useRef<readonly string[]>([]);
  // Most recently visible ids — used by the live pointermove handler
  // without taking a fresh closure each render.
  const visibleIdsRef = useRef<readonly string[]>(visibleTrackIds);
  useEffect(() => {
    visibleIdsRef.current = visibleTrackIds;
  }, [visibleTrackIds]);

  // Last pointer viewport coords seen during an active drag. The edge
  // auto-scroll rAF loop replays selection from these as the container
  // scrolls under a stationary pointer, so rows scrolling into view get
  // selected without further pointer movement.
  const lastPointerRef = useRef<{ clientX: number; clientY: number } | null>(
    null,
  );
  // Handle for the edge auto-scroll animation frame; null when idle.
  const autoScrollRafRef = useRef<number | null>(null);

  // Last selection set committed to the store during the active drag.
  // Every pointermove / auto-scroll frame recomputes the marquee set, but
  // most frames land on the same rows — we skip the store write (and the
  // store-wide re-render it triggers) when the computed set is unchanged.
  // Reset to null at press-down so the first frame of a new drag always
  // writes.
  const lastWrittenSelectionRef = useRef<ReadonlySet<string> | null>(null);
  // Fallback timer that clears suppressClickRef if no synthetic click
  // arrives to consume it (see pointerUp). Tracked so we can cancel it
  // when a click DOES consume the flag, and so unmount can clear it.
  const suppressClearTimerRef = useRef<number | null>(null);

  const onContainerPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Only respond to primary mouse button / touch / pen.
      if (e.button !== 0) return;
      if (isInteractiveTarget(e.target)) return;
      const container = parentRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      pendingRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startContainerY: e.clientY - rect.top + container.scrollTop,
        additive,
        baselineSelection: new Set(selectedTrackIds),
        baselineAnchorId: usePlaylistStore.getState().selectionAnchorId,
        active: false,
        pointerId: e.pointerId,
      };
      visibleAtPressRef.current = visibleIdsRef.current.slice();
      // New gesture: forget the prior drag's last-written set so the first
      // frame of this drag always commits (the dedup is per-drag).
      lastWrittenSelectionRef.current = null;
      // Don't preventDefault — we still want the row's onClick to fire if
      // the user releases without moving.
    },
    [parentRef, selectedTrackIds],
  );

  useEffect(() => {
    // Recompute the selection rect + selection for a given pointer
    // position. Factored out so both the live pointermove handler AND the
    // edge auto-scroll rAF loop (which keeps the pointer fixed but moves
    // the container under it) can drive it. Reads container.scrollTop
    // fresh each call, so a mid-gesture scroll is reflected immediately.
    function applySelectionForPointer(clientX: number, clientY: number): void {
      const pending = pendingRef.current;
      if (!pending || !pending.active) return;
      const container = parentRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const currContainerY = clientY - rect.top + container.scrollTop;
      const minY = Math.min(pending.startContainerY, currContainerY);
      const maxY = Math.max(pending.startContainerY, currContainerY);
      const totalRows = visibleAtPressRef.current.length;
      if (totalRows === 0) return;

      const firstIdx = Math.max(0, Math.floor(minY / ROW_HEIGHT_PX));
      const lastIdx = Math.min(
        totalRows - 1,
        Math.floor((maxY - 0.01) / ROW_HEIGHT_PX),
      );

      const ids = new Set<string>();
      if (pending.additive) {
        for (const id of pending.baselineSelection) ids.add(id);
      }
      if (firstIdx <= lastIdx) {
        for (let i = firstIdx; i <= lastIdx; i++) {
          const id = visibleAtPressRef.current[i];
          if (id) ids.add(id);
        }
      }
      // Skip the store write when this frame's set matches the last one we
      // committed — pointermove fires per frame and auto-scroll replays the
      // same pointer, so most frames recompute an identical selection;
      // writing it again would re-render the whole table for no change.
      const prev = lastWrittenSelectionRef.current;
      if (!prev || !sameSelection(prev, ids)) {
        // Apply selection, preserving the pre-drag anchor. Passing it through
        // explicitly is required: `setSelection(ids)` would default the anchor
        // to null, silently destroying the shift-extend pivot.
        setSelection(ids, pending.baselineAnchorId);
        lastWrittenSelectionRef.current = ids;
      }

      // Render rectangle in viewport coords (fixed-positioned overlay).
      const left = Math.min(pending.startClientX, clientX);
      const top = Math.min(pending.startClientY, clientY);
      const width = Math.abs(clientX - pending.startClientX);
      const height = Math.abs(clientY - pending.startClientY);
      setRubberbandRect({ left, top, width, height });
    }

    // Per-frame edge auto-scroll: while a drag is active and the pointer
    // is within AUTO_SCROLL_EDGE_PX of the viewport's top/bottom, nudge
    // the container's scrollTop (proportional to edge proximity) and
    // re-run the selection from the last pointer position so rows
    // scrolling into the band get selected. Re-schedules itself until the
    // drag ends or the pointer leaves the edge zone.
    function autoScrollStep(): void {
      autoScrollRafRef.current = null;
      const pending = pendingRef.current;
      const container = parentRef.current;
      const pointer = lastPointerRef.current;
      if (!pending || !pending.active || !container || !pointer) return;

      const rect = container.getBoundingClientRect();
      let delta = 0;
      const distFromTop = pointer.clientY - rect.top;
      const distFromBottom = rect.bottom - pointer.clientY;
      if (distFromTop < AUTO_SCROLL_EDGE_PX) {
        // Proximity ∈ (0,1]: stronger pull closer to the edge.
        const proximity = Math.min(1, (AUTO_SCROLL_EDGE_PX - distFromTop) / AUTO_SCROLL_EDGE_PX);
        delta = -Math.ceil(proximity * AUTO_SCROLL_MAX_PX_PER_FRAME);
      } else if (distFromBottom < AUTO_SCROLL_EDGE_PX) {
        const proximity = Math.min(1, (AUTO_SCROLL_EDGE_PX - distFromBottom) / AUTO_SCROLL_EDGE_PX);
        delta = Math.ceil(proximity * AUTO_SCROLL_MAX_PX_PER_FRAME);
      }

      if (delta !== 0) {
        const before = container.scrollTop;
        const maxScroll = container.scrollHeight - container.clientHeight;
        const next = Math.max(0, Math.min(maxScroll, before + delta));
        if (next !== before) {
          container.scrollTop = next;
          // Re-run selection so the rows now under the (fixed) pointer
          // band are picked up as the content scrolled.
          applySelectionForPointer(pointer.clientX, pointer.clientY);
        }
        // Keep looping while still in the edge zone (even if clamped at a
        // boundary, so we resume immediately if scrollHeight grows).
        autoScrollRafRef.current = requestAnimationFrame(autoScrollStep);
      }
      // Out of the edge zone → loop stops; pointermove restarts it.
    }

    function ensureAutoScroll(): void {
      if (autoScrollRafRef.current === null) {
        autoScrollRafRef.current = requestAnimationFrame(autoScrollStep);
      }
    }

    function stopAutoScroll(): void {
      if (autoScrollRafRef.current !== null) {
        cancelAnimationFrame(autoScrollRafRef.current);
        autoScrollRafRef.current = null;
      }
      lastPointerRef.current = null;
    }

    function pointerMove(e: PointerEvent) {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== e.pointerId) return;
      // The originating pointerup can be missed if the button was released
      // off-window. A subsequent move whose primary button is no longer held
      // means the press is already over — finalize as a release (so an
      // active marquee suppresses its trailing click) rather than letting a
      // dead press resurrect a selection drag.
      if ((e.buttons & 1) === 0) {
        pointerUp(e);
        return;
      }
      const container = parentRef.current;
      if (!container) return;
      const dx = e.clientX - pending.startClientX;
      const dy = e.clientY - pending.startClientY;
      if (
        !pending.active &&
        Math.hypot(dx, dy) < RUBBERBAND_THRESHOLD_PX
      ) {
        return;
      }
      pending.active = true;

      // Record the live pointer so the auto-scroll loop can replay
      // selection from it while the container scrolls under it.
      lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
      applySelectionForPointer(e.clientX, e.clientY);
      // Kick the edge auto-scroll loop; autoScrollStep self-cancels when
      // the pointer isn't near an edge, so this is a cheap no-op away from
      // the edges.
      ensureAutoScroll();
    }

    function pointerUp(e: PointerEvent) {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== e.pointerId) return;
      const wasActive = pending.active;
      pendingRef.current = null;
      // Always stop the auto-scroll loop on release — a drag must not keep
      // scrolling after the pointer is up.
      stopAutoScroll();
      if (wasActive) {
        // We treated this as a drag; suppress the synthetic click that
        // the browser is about to fire on the press-down target.
        suppressClickRef.current = true;
        // Primary clear path: the next real click consumes the flag (see
        // the window click-capture listener below). The 0ms timer is only
        // a FALLBACK in case no click ever fires (e.g. the press-down
        // target was unmounted mid-drag) so the flag can't get stuck on.
        // We intentionally don't rely on the timer alone: if the synthetic
        // click is dispatched a macrotask late, a bare setTimeout(0) would
        // clear suppression first and the drag-end click would leak through
        // as a selection.
        if (suppressClearTimerRef.current !== null) {
          window.clearTimeout(suppressClearTimerRef.current);
        }
        suppressClearTimerRef.current = window.setTimeout(() => {
          suppressClearTimerRef.current = null;
          suppressClickRef.current = false;
        }, 0);
      }
      setRubberbandRect(null);
    }

    function pointerCancel(e: PointerEvent) {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== e.pointerId) return;
      pendingRef.current = null;
      stopAutoScroll();
      setRubberbandRect(null);
    }

    // Clear the suppression flag once the drag-end synthetic click has been
    // dispatched and (in the bubble phase) the row's onClick has already
    // had its chance to read it. Registered on the BUBBLE phase so we run
    // AFTER the row handler — we must not pre-empt the consumer that reads
    // the flag to swallow the click. This is the robust primary clear path:
    // it fires whenever the click actually lands, no matter how many
    // macrotasks late, so a delayed synthetic click can't leak through as a
    // selection. The setTimeout in pointerUp is now only a safety net for
    // the no-click case (press-down target unmounted mid-drag); cancelling
    // it here avoids a redundant late clear. No-op when the flag is unset,
    // so unrelated clicks are untouched.
    function clickClear() {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      if (suppressClearTimerRef.current !== null) {
        window.clearTimeout(suppressClearTimerRef.current);
        suppressClearTimerRef.current = null;
      }
    }

    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("click", clickClear);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("click", clickClear);
      // Cancel any in-flight auto-scroll frame on unmount so we don't
      // touch a detached container a frame later.
      stopAutoScroll();
      // Clear the suppression fallback timer too, so it can't fire against
      // a stale ref after unmount.
      if (suppressClearTimerRef.current !== null) {
        window.clearTimeout(suppressClearTimerRef.current);
        suppressClearTimerRef.current = null;
      }
    };
  }, [parentRef, setSelection]);

  return { onContainerPointerDown, rubberbandRect, suppressClickRef };
}

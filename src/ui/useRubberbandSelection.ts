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
  startScrollTop: number;
  // Whether shift/meta/ctrl was held at press-down — additive vs replace.
  additive: boolean;
  // Selection ids before the rubber-band started (used for additive merge).
  baselineSelection: ReadonlySet<string>;
  // Once movement exceeds the threshold we flip to true and start rendering.
  active: boolean;
  pointerId: number;
};

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
        startScrollTop: container.scrollTop,
        additive,
        baselineSelection: new Set(selectedTrackIds),
        active: false,
        pointerId: e.pointerId,
      };
      visibleAtPressRef.current = visibleIdsRef.current.slice();
      // Don't preventDefault — we still want the row's onClick to fire if
      // the user releases without moving.
    },
    [parentRef, selectedTrackIds],
  );

  useEffect(() => {
    function pointerMove(e: PointerEvent) {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== e.pointerId) return;
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

      const rect = container.getBoundingClientRect();
      const currContainerY = e.clientY - rect.top + container.scrollTop;
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
      // Apply selection; we don't move the anchor while rubber-banding.
      setSelection(ids);

      // Render rectangle in viewport coords (fixed-positioned overlay).
      const left = Math.min(pending.startClientX, e.clientX);
      const top = Math.min(pending.startClientY, e.clientY);
      const width = Math.abs(e.clientX - pending.startClientX);
      const height = Math.abs(e.clientY - pending.startClientY);
      setRubberbandRect({ left, top, width, height });
    }

    function pointerUp(e: PointerEvent) {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== e.pointerId) return;
      const wasActive = pending.active;
      pendingRef.current = null;
      if (wasActive) {
        // We treated this as a drag; suppress the synthetic click that
        // the browser is about to fire on the press-down target.
        suppressClickRef.current = true;
        // Reset suppression on the next macrotask in case no click fires.
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      setRubberbandRect(null);
    }

    function pointerCancel(e: PointerEvent) {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== e.pointerId) return;
      pendingRef.current = null;
      setRubberbandRect(null);
    }

    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
    };
  }, [parentRef, setSelection]);

  return { onContainerPointerDown, rubberbandRect, suppressClickRef };
}

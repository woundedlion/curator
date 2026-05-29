import { useEffect, type RefObject } from "react";
import { PLAYLIST_SCROLL_KEY } from "../constants";

// One-shot guard: scroll is restored exactly once per page load. We use
// the persisted value itself as the marker — consuming (deleting) it on
// first read means subsequent mounts (e.g. Clear → re-add) start at the
// top, matching the user's expectation. The throttled scroll listener
// writes a fresh value as soon as the user scrolls again, so the next
// reload still restores. Module-scope state would survive HMR and leak
// across tests; sessionStorage is naturally scoped to the page load.

function readSavedScrollTop(): number | null {
  try {
    const raw = sessionStorage.getItem(PLAYLIST_SCROLL_KEY);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function clearSavedScrollTop(): void {
  try {
    sessionStorage.removeItem(PLAYLIST_SCROLL_KEY);
  } catch {
    // best-effort
  }
}

function writeSavedScrollTop(value: number): void {
  try {
    sessionStorage.setItem(PLAYLIST_SCROLL_KEY, String(Math.max(0, value)));
  } catch {
    // sessionStorage write can fail in private-mode or when quota is hit;
    // scroll restoration is a nice-to-have, not worth surfacing.
  }
}

/**
 * Restore the saved scroll position once after hydration, then save the
 * current scrollTop throttled while the user scrolls.
 *
 * Restoration waits until the virtualizer has set the inner div's total
 * height — until then, the parent's max scrollTop is 0 and any assignment
 * clamps. Keying off `visibleCount` flipping non-zero ensures we run after
 * the first measured render.
 */
export function useTableScrollRestoration(
  parentRef: RefObject<HTMLElement | null>,
  visibleCount: number,
): void {
  useEffect(() => {
    if (visibleCount === 0) return;
    const el = parentRef.current;
    if (!el) return;
    const saved = readSavedScrollTop();
    if (saved === null) return;
    // Consume the saved value so subsequent table mounts (Clear →
    // re-add) start at the top instead of fighting the user. The
    // throttled scroll listener below writes a fresh value as soon as
    // the user scrolls.
    clearSavedScrollTop();
    if (saved === 0) return;
    // The virtualizer sizes its content via the inner spacer's height. Wait
    // one frame so layout is committed before we assign scrollTop — without
    // this, the assignment can clamp to a too-small scrollHeight on first
    // render and the user lands a few pixels above their saved position.
    requestAnimationFrame(() => {
      el.scrollTop = saved;
    });
  }, [parentRef, visibleCount]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    let pending: number | null = null;
    function onScroll() {
      if (pending !== null) return;
      pending = window.setTimeout(() => {
        pending = null;
        if (el) writeSavedScrollTop(el.scrollTop);
      }, 100);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (pending !== null) clearTimeout(pending);
    };
  }, [parentRef]);
}

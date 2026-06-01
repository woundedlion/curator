// @vitest-environment happy-dom
//
// useTableScrollRestoration previously had no direct tests. It restores
// the saved playlist scroll position exactly once per page load, then
// debounce-writes the resting scrollTop while the user scrolls. The
// subtle bits covered here:
//
//   1. Restore is rAF-deferred (waits a frame so the virtualizer has
//      sized its content) and assigns the saved scrollTop.
//   2. The saved value is one-shot: it's consumed (removed from
//      sessionStorage) on the first restore, so a Clear → re-add mount
//      starts at the top instead of fighting the user.
//   3. The resting scrollTop is written debounced (100 ms after the last
//      scroll event), not on every scroll tick.
//   4. sessionStorage failures (private mode / quota) are swallowed —
//      restoration is best-effort and never throws.
//   5. The pending restore rAF is cancelled on unmount.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { PLAYLIST_SCROLL_KEY } from "../constants";
import { useTableScrollRestoration } from "./useTableScrollRestoration";

// A DOM element whose scrollTop we can read/write freely. happy-dom's
// <div> already supports scrollTop, but we attach an addEventListener so
// the debounced-write effect has something to listen to.
function makeScrollEl(): HTMLDivElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

/**
 * Mount the hook with a ref pointing at `el` and a given visibleCount.
 * Returns renderHook's controls so tests can rerender / unmount.
 */
function mount(el: HTMLElement | null, visibleCount: number) {
  return renderHook(
    ({ count }: { count: number }) => {
      const ref = useRef<HTMLElement | null>(el);
      // Keep the ref pointed at the (possibly null) element across
      // rerenders.
      (ref as { current: HTMLElement | null }).current = el;
      useTableScrollRestoration(ref as RefObject<HTMLElement | null>, count);
    },
    { initialProps: { count: visibleCount } },
  );
}

let rafCallbacks: FrameRequestCallback[];
let rafCancelled: number[];

beforeEach(() => {
  sessionStorage.clear();
  rafCallbacks = [];
  rafCancelled = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(
    (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    },
  );
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
    rafCancelled.push(id);
    rafCallbacks[id - 1] = (() => {}) as FrameRequestCallback;
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function flushRaf(): void {
  const cbs = rafCallbacks;
  rafCallbacks = [];
  for (const cb of cbs) cb(performance.now());
}

describe("useTableScrollRestoration — restore", () => {
  it("restores the saved scrollTop on the next animation frame", () => {
    sessionStorage.setItem(PLAYLIST_SCROLL_KEY, "350");
    const el = makeScrollEl();
    mount(el, 20);
    // Restoration is deferred a frame; nothing applied yet.
    expect(el.scrollTop).toBe(0);
    flushRaf();
    expect(el.scrollTop).toBe(350);
  });

  it("does not restore while visibleCount is 0 (virtualizer not measured)", () => {
    sessionStorage.setItem(PLAYLIST_SCROLL_KEY, "350");
    const el = makeScrollEl();
    mount(el, 0);
    flushRaf();
    expect(el.scrollTop).toBe(0);
    // The saved value is NOT consumed because restore never ran.
    expect(sessionStorage.getItem(PLAYLIST_SCROLL_KEY)).toBe("350");
  });

  it("consumes the saved value one-shot: a fresh mount starts at the top", () => {
    sessionStorage.setItem(PLAYLIST_SCROLL_KEY, "350");
    const el = makeScrollEl();
    const first = mount(el, 20);
    flushRaf();
    expect(el.scrollTop).toBe(350);
    // The value was removed when consumed.
    expect(sessionStorage.getItem(PLAYLIST_SCROLL_KEY)).toBeNull();
    first.unmount();

    // A second mount (Clear → re-add) finds nothing saved and stays put.
    const el2 = makeScrollEl();
    el2.scrollTop = 0;
    mount(el2, 20);
    flushRaf();
    expect(el2.scrollTop).toBe(0);
  });

  it("saved value of 0 is consumed but skips the scroll assignment", () => {
    sessionStorage.setItem(PLAYLIST_SCROLL_KEY, "0");
    const el = makeScrollEl();
    el.scrollTop = 0;
    mount(el, 20);
    // No rAF is scheduled for a 0 target (early return after consume).
    expect(rafCallbacks.length).toBe(0);
    expect(sessionStorage.getItem(PLAYLIST_SCROLL_KEY)).toBeNull();
  });

  it("cancels the pending restore frame on unmount", () => {
    sessionStorage.setItem(PLAYLIST_SCROLL_KEY, "350");
    const el = makeScrollEl();
    const { unmount } = mount(el, 20);
    expect(rafCallbacks.length).toBe(1);
    unmount();
    expect(rafCancelled.length).toBe(1);
  });

  it("ignores a corrupt / negative saved value", () => {
    sessionStorage.setItem(PLAYLIST_SCROLL_KEY, "not-a-number");
    const el = makeScrollEl();
    mount(el, 20);
    flushRaf();
    expect(el.scrollTop).toBe(0);
  });
});

describe("useTableScrollRestoration — debounced write", () => {
  it("writes the resting scrollTop 100 ms after the last scroll event", () => {
    const el = makeScrollEl();
    mount(el, 20);

    el.scrollTop = 120;
    el.dispatchEvent(new Event("scroll"));
    // Not written yet — still inside the debounce window.
    expect(sessionStorage.getItem(PLAYLIST_SCROLL_KEY)).toBeNull();

    // A second scroll resets the debounce.
    el.scrollTop = 200;
    el.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(99);
    expect(sessionStorage.getItem(PLAYLIST_SCROLL_KEY)).toBeNull();

    vi.advanceTimersByTime(1);
    // Only the final resting position is written.
    expect(sessionStorage.getItem(PLAYLIST_SCROLL_KEY)).toBe("200");
  });

  it("clears the pending debounce timer on unmount (no write fires)", () => {
    const el = makeScrollEl();
    const { unmount } = mount(el, 20);
    el.scrollTop = 75;
    el.dispatchEvent(new Event("scroll"));
    unmount();
    vi.advanceTimersByTime(500);
    expect(sessionStorage.getItem(PLAYLIST_SCROLL_KEY)).toBeNull();
  });
});

describe("useTableScrollRestoration — sessionStorage tolerance", () => {
  it("swallows a getItem throw during restore (no crash)", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const el = makeScrollEl();
    // Must not throw.
    expect(() => mount(el, 20)).not.toThrow();
    spy.mockRestore();
  });

  it("swallows a setItem throw during the debounced write (no crash)", () => {
    const el = makeScrollEl();
    mount(el, 20);
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    el.scrollTop = 90;
    el.dispatchEvent(new Event("scroll"));
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    spy.mockRestore();
  });
});

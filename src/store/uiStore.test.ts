// Unit tests for the global UI store. The toast queue, the busy-counter
// ref-counting, and the withBusy wrapper all guard subtle UX invariants
// (errors must not vanish, the spinner must not flicker), so we cover
// each behavior explicitly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "./uiStore";

const TOAST_VISIBLE_MS = 2700;
const TOAST_FADE_MS = 300;
const TOAST_TOTAL_MS = TOAST_VISIBLE_MS + TOAST_FADE_MS;
const MAX_TOASTS = 5;

function resetUiStore(): void {
  useUiStore.setState({
    toasts: [],
    showSettings: false,
    showCreateDialog: false,
    enrichmentQueueDepth: 0,
    busyCount: 0,
  });
}

describe("useUiStore — toast auto-dismiss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetUiStore();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetUiStore();
  });

  it("auto-dismisses info toasts: marks them fading after the visible window and removes them after the fade", () => {
    // Info toasts should self-clear so we don't accumulate noise.
    useUiStore.getState().pushToast({ kind: "info", message: "hello" });
    expect(useUiStore.getState().toasts).toHaveLength(1);
    expect(useUiStore.getState().toasts[0]?.fading).toBe(false);

    vi.advanceTimersByTime(TOAST_VISIBLE_MS);
    expect(useUiStore.getState().toasts[0]?.fading).toBe(true);

    vi.advanceTimersByTime(TOAST_FADE_MS);
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });

  it("auto-dismisses success toasts the same way info toasts dismiss", () => {
    // Success and info share the same TTL contract.
    useUiStore.getState().pushToast({ kind: "success", message: "done" });
    vi.advanceTimersByTime(TOAST_TOTAL_MS);
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });

  it("does NOT auto-dismiss error toasts — they persist until explicitly dismissed", () => {
    // Errors deserve user attention; vanishing them silently is a bug.
    useUiStore.getState().pushToast({ kind: "error", message: "boom" });
    expect(useUiStore.getState().toasts).toHaveLength(1);

    // Run far past the normal TTL.
    vi.advanceTimersByTime(TOAST_TOTAL_MS * 10);
    expect(useUiStore.getState().toasts).toHaveLength(1);
    expect(useUiStore.getState().toasts[0]?.fading).toBe(false);
  });
});

describe("useUiStore — queue-bound eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetUiStore();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetUiStore();
  });

  it("caps the queue at MAX_TOASTS", () => {
    // The queue can't grow unbounded; a spammy producer must not pile up
    // dozens of toasts.
    for (let i = 0; i < MAX_TOASTS + 3; i++) {
      useUiStore.getState().pushToast({ kind: "info", message: `t${i}` });
    }
    expect(useUiStore.getState().toasts.length).toBeLessThanOrEqual(MAX_TOASTS);
  });

  it("drops the oldest non-error toast first so errors survive a flood of info", () => {
    // Critical errors must survive even if the user gets a flood of
    // background info toasts after them.
    const ui = useUiStore.getState();
    ui.pushToast({ kind: "error", message: "critical" });
    for (let i = 0; i < MAX_TOASTS; i++) {
      ui.pushToast({ kind: "info", message: `info${i}` });
    }

    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(MAX_TOASTS);
    // The error must still be in the queue.
    const errors = toasts.filter((t) => t.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("critical");
  });

  it("drops the oldest toast when every toast in the queue is an error", () => {
    // Fallback: if there are no non-error toasts to drop, the oldest
    // toast (which is itself an error) is dropped to make room.
    const ui = useUiStore.getState();
    for (let i = 0; i < MAX_TOASTS; i++) {
      ui.pushToast({ kind: "error", message: `err${i}` });
    }
    ui.pushToast({ kind: "error", message: "newest" });

    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(MAX_TOASTS);
    expect(toasts.find((t) => t.message === "err0")).toBeUndefined();
    expect(toasts.at(-1)?.message).toBe("newest");
  });

  it("does not fire a dismissal timer for an evicted info toast", () => {
    // When a toast is evicted to make room, its pending fade/remove
    // timers must be cleared so they don't try to mutate stale state.
    const ui = useUiStore.getState();
    ui.pushToast({ kind: "info", message: "doomed" });
    // Fill the queue with errors so the next push evicts "doomed".
    for (let i = 0; i < MAX_TOASTS; i++) {
      ui.pushToast({ kind: "error", message: `e${i}` });
    }

    // "doomed" must now be gone.
    expect(
      useUiStore.getState().toasts.find((t) => t.message === "doomed"),
    ).toBeUndefined();

    const before = useUiStore.getState().toasts.map((t) => t.id);
    // Advance well past doomed's would-be lifetime; surviving toasts
    // (all errors) must be untouched.
    vi.advanceTimersByTime(TOAST_TOTAL_MS * 2);
    const after = useUiStore.getState().toasts.map((t) => t.id);
    expect(after).toEqual(before);
  });
});

describe("useUiStore — dismissToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetUiStore();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetUiStore();
  });

  it("removes a specific toast by id", () => {
    // Explicit dismissal is the only way to clear an error toast.
    useUiStore.getState().pushToast({ kind: "error", message: "boom" });
    const id = useUiStore.getState().toasts[0]?.id;
    expect(id).toBeDefined();

    useUiStore.getState().dismissToast(id as number);
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });

  it("is a no-op when called with an unknown id", () => {
    // Components may race dismiss-clicks against auto-dismiss; calling
    // dismiss with a stale id must not throw or wipe other toasts.
    useUiStore.getState().pushToast({ kind: "info", message: "still here" });
    expect(() => useUiStore.getState().dismissToast(999_999)).not.toThrow();
    expect(useUiStore.getState().toasts).toHaveLength(1);
  });
});

describe("useUiStore — ref-counted busyCount", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetUiStore();
  });

  it("increments and decrements the count", () => {
    // The count is the source of truth for the global spinner.
    const ui = useUiStore.getState();
    ui.incrementBusy();
    expect(useUiStore.getState().busyCount).toBe(1);
    ui.decrementBusy();
    expect(useUiStore.getState().busyCount).toBe(0);
  });

  it("supports nested/concurrent increments without spurious toggles", () => {
    // Two concurrent ops must keep busyCount > 0 until both finish, so
    // the spinner doesn't flicker off between them.
    const ui = useUiStore.getState();
    ui.incrementBusy();
    ui.incrementBusy();
    ui.incrementBusy();
    expect(useUiStore.getState().busyCount).toBe(3);

    ui.decrementBusy();
    expect(useUiStore.getState().busyCount).toBe(2);
    ui.decrementBusy();
    expect(useUiStore.getState().busyCount).toBe(1);
    // Still busy — spinner must still be visible.
    expect(useUiStore.getState().busyCount).toBeGreaterThan(0);
    ui.decrementBusy();
    expect(useUiStore.getState().busyCount).toBe(0);
  });

  it("clamps decrementBusy at 0 so an extra decrement can't drive the count negative", () => {
    // A buggy caller must not be able to leave the count negative,
    // which would later require N increments before the spinner shows.
    const ui = useUiStore.getState();
    ui.decrementBusy();
    ui.decrementBusy();
    expect(useUiStore.getState().busyCount).toBe(0);
  });
});

describe("useUiStore — withBusy wrapper", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetUiStore();
  });

  it("brackets the work with increment/decrement and returns the result", () => {
    // withBusy is the convenience entrypoint; it must leave busyCount
    // back at its baseline after a successful call.
    const ui = useUiStore.getState();
    const promise = ui.withBusy(async () => {
      expect(useUiStore.getState().busyCount).toBe(1);
      return 42;
    });
    return promise.then((result) => {
      expect(result).toBe(42);
      expect(useUiStore.getState().busyCount).toBe(0);
    });
  });

  it("decrements via finally even when the work throws", async () => {
    // If withBusy didn't use finally, a failed op would leave the
    // spinner stuck on forever.
    const ui = useUiStore.getState();
    await expect(
      ui.withBusy(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(useUiStore.getState().busyCount).toBe(0);
  });

  it("preserves the count for concurrent withBusy calls", async () => {
    // Two overlapping withBusy calls must share the ref count and
    // return it to 0 only once both have settled.
    const ui = useUiStore.getState();
    let resolveA: () => void = () => {};
    const aGate = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    let resolveB: () => void = () => {};
    const bGate = new Promise<void>((resolve) => {
      resolveB = resolve;
    });

    const pA = ui.withBusy(async () => {
      await aGate;
    });
    const pB = ui.withBusy(async () => {
      await bGate;
    });

    // Allow microtasks to flush so both increments are visible.
    await Promise.resolve();
    expect(useUiStore.getState().busyCount).toBe(2);

    resolveA();
    await pA;
    expect(useUiStore.getState().busyCount).toBe(1);

    resolveB();
    await pB;
    expect(useUiStore.getState().busyCount).toBe(0);
  });
});

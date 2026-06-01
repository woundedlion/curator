import { create } from "zustand";

export type ToastKind = "info" | "success" | "error";

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
  href?: string;
  fading: boolean;
};

const TOAST_VISIBLE_MS = 2700;
const TOAST_FADE_MS = 300;
const TOAST_TOTAL_MS = TOAST_VISIBLE_MS + TOAST_FADE_MS;
// Errors deserve the user's attention — auto-dismissing them after 2.7s
// often means they vanish before the user has read them. We bound the
// queue separately (MAX_TOASTS) so a spammy loop can't pile up dozens.
const MAX_TOASTS = 5;

type UiStore = {
  toasts: Toast[];
  showSettings: boolean;
  showCreateDialog: boolean;
  enrichmentQueueDepth: number;
  busyCount: number;

  pushToast: (toast: Omit<Toast, "id" | "fading">) => void;
  dismissToast: (id: number) => void;
  setShowSettings: (show: boolean) => void;
  setShowCreateDialog: (show: boolean) => void;
  setEnrichmentQueueDepth: (depth: number) => void;
  incrementBusy: () => void;
  decrementBusy: () => void;
  withBusy: <T>(work: () => Promise<T>) => Promise<T>;
};

let nextToastId = 1;
// Store the raw timer handles so the cancel paths can clearTimeout them
// without an `as unknown as number` double-cast — setTimeout's return type
// differs between the DOM (number) and Node (Timeout) lib, so we let
// ReturnType infer whichever this build targets.
type TimerHandle = ReturnType<typeof setTimeout>;
const toastTimers = new Map<number, { fade: TimerHandle; remove: TimerHandle }>();

function clearTimersFor(id: number): void {
  const timers = toastTimers.get(id);
  if (!timers) return;
  clearTimeout(timers.fade);
  clearTimeout(timers.remove);
  toastTimers.delete(id);
}

export const useUiStore = create<UiStore>((set, get) => {
  function beginFadeFor(id: number): void {
    set((state) => ({
      toasts: state.toasts.map((toast) =>
        toast.id === id ? { ...toast, fading: true } : toast,
      ),
    }));
  }

  function removeToastFor(id: number): void {
    clearTimersFor(id);
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    }));
  }

  return {
    toasts: [],
    showSettings: false,
    showCreateDialog: false,
    enrichmentQueueDepth: 0,
    busyCount: 0,

    pushToast(toast) {
      const id = nextToastId++;
      set((state) => {
        const queue = [...state.toasts, { ...toast, id, fading: false }];
        // Bound the queue. When too many toasts pile up, drop the oldest
        // *non-error* toast first so persistent error messages stick around.
        while (queue.length > MAX_TOASTS) {
          const dropIdx = queue.findIndex((t) => t.kind !== "error");
          const idx = dropIdx === -1 ? 0 : dropIdx;
          const dropped = queue.splice(idx, 1)[0];
          if (dropped) clearTimersFor(dropped.id);
        }
        return { toasts: queue };
      });
      // Errors require user action to dismiss — vanishing them silently
      // means the user never sees critical failures (publish failed,
      // playback error, etc.).
      if (toast.kind === "error") return;
      const fade = setTimeout(() => beginFadeFor(id), TOAST_VISIBLE_MS);
      const remove = setTimeout(() => removeToastFor(id), TOAST_TOTAL_MS);
      toastTimers.set(id, { fade, remove });
    },

    dismissToast(id) {
      removeToastFor(id);
    },

    setShowSettings(show) {
      set({ showSettings: show });
    },

    setShowCreateDialog(show) {
      set({ showCreateDialog: show });
    },

    setEnrichmentQueueDepth(depth) {
      set({ enrichmentQueueDepth: depth });
    },

    incrementBusy() {
      set((state) => ({ busyCount: state.busyCount + 1 }));
    },

    decrementBusy() {
      set((state) => ({ busyCount: Math.max(0, state.busyCount - 1) }));
    },

    async withBusy(work) {
      get().incrementBusy();
      try {
        return await work();
      } finally {
        get().decrementBusy();
      }
    },
  };
});

// Test-only: fully reset the UI store INCLUDING the module-global toast id
// counter and the pending-timer map. Resetting store state via setState
// alone leaves `nextToastId` climbing and stale entries in `toastTimers`, so
// a toast pushed in one test whose fade/remove timer fires during the next
// could mutate the next test's `toasts`. Clearing the timers here severs that
// cross-test coupling. No-ops outside test mode.
export function __resetUiStoreForTests(): void {
  if (import.meta.env.MODE !== "test") return;
  for (const timers of toastTimers.values()) {
    clearTimeout(timers.fade);
    clearTimeout(timers.remove);
  }
  toastTimers.clear();
  nextToastId = 1;
  useUiStore.setState({
    toasts: [],
    showSettings: false,
    showCreateDialog: false,
    enrichmentQueueDepth: 0,
    busyCount: 0,
  });
}

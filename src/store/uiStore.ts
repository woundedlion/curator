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
const toastTimers = new Map<number, { fade: number; remove: number }>();

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
      set((state) => ({
        toasts: [...state.toasts, { ...toast, id, fading: false }],
      }));
      const fade = setTimeout(() => beginFadeFor(id), TOAST_VISIBLE_MS) as unknown as number;
      const remove = setTimeout(() => removeToastFor(id), TOAST_TOTAL_MS) as unknown as number;
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

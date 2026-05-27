import { useUiStore } from "../store/uiStore";

const TOAST_COLORS = {
  info: "border-neutral-700 bg-neutral-900",
  success: "border-matched bg-neutral-900",
  error: "border-red-600 bg-neutral-900",
};

export function ToastList() {
  const toasts = useUiStore((state) => state.toasts);
  const dismiss = useUiStore((state) => state.dismissToast);

  return (
    <div
      aria-live="polite"
      // assertive politeness for errors would interrupt screen readers
      // mid-utterance, which is jarring. polite + sticky errors strikes
      // the right balance: they announce when there's a pause, and stay
      // on screen until the user dismisses them.
      className="pointer-events-none fixed bottom-20 right-4 z-30 flex flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === "error" ? "alert" : undefined}
          className={`pointer-events-auto flex items-center gap-2 rounded border px-3 py-2 text-sm shadow-lg transition-opacity duration-300 ${
            toast.fading ? "opacity-0" : "opacity-100"
          } ${TOAST_COLORS[toast.kind]}`}
        >
          <span>{toast.message}</span>
          {toast.href && (
            <a
              href={toast.href}
              target="_blank"
              rel="noreferrer"
              className="text-matched underline"
            >
              Open
            </a>
          )}
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss notification"
            // Errors are sticky — make the dismiss affordance more prominent
            // so users know they're expected to close it manually.
            className={
              toast.kind === "error"
                ? "ml-2 rounded border border-neutral-700 px-1 text-neutral-200 hover:bg-neutral-800"
                : "ml-2 text-neutral-400 hover:text-neutral-100"
            }
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

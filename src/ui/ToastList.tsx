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
      className="pointer-events-none fixed bottom-20 right-4 z-30 flex flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
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
            aria-label="Dismiss"
            className="ml-2 text-neutral-400 hover:text-neutral-100"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

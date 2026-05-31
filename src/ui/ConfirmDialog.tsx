import { useEffect, useId, useRef } from "react";
import { useDialogFocus } from "../hooks/useDialogFocus";

type ConfirmKind = "info" | "danger";

type Props = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  kind?: ConfirmKind;
  onConfirm: () => void;
  onCancel: () => void;
};

// Shared confirmation dialog. Replaces ad-hoc window.confirm() calls and
// silent destructive flows so every place that risks data loss reads the
// same way and is screen-reader-friendly via useDialogFocus.
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  kind = "danger",
  onConfirm,
  onCancel,
}: Props) {
  const dialogRef = useDialogFocus<HTMLDivElement>(open, onCancel);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Unique per instance so two ConfirmDialogs mounted in the same tree
  // (e.g. Toolbar mounts Clear + Nuke confirms) can't collide on a
  // hardcoded DOM id and produce ambiguous aria-labelledby references.
  const titleId = useId();
  const messageId = useId();

  // When the dialog opens, push focus to the confirm button so Enter
  // confirms without an extra Tab. useDialogFocus already pulls focus
  // *into* the container; this just biases to the affirmative action
  // when it exists.
  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const confirmClasses =
    kind === "danger"
      ? "bg-red-600 text-white hover:bg-red-500"
      : "bg-matched text-neutral-900 hover:bg-matched/80";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      // Clicking the backdrop cancels — matches the SettingsDialog
      // pattern users already know.
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        // Stop the click from bubbling to the backdrop's onClose handler.
        onClick={(event) => event.stopPropagation()}
        className="mx-4 w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-5 shadow-2xl"
      >
        <h2
          id={titleId}
          className="text-base font-semibold text-neutral-100"
        >
          {title}
        </h2>
        <p
          id={messageId}
          className="mt-2 text-sm text-neutral-300"
        >
          {message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-neutral-700 bg-transparent px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`rounded px-3 py-1.5 text-sm font-medium ${confirmClasses}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

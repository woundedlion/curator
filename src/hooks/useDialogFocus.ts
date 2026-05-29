import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]):not([type="hidden"]), ' +
  "select:not([disabled]), textarea:not([disabled]), button:not([disabled]), " +
  '[tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    // Only treat aria-hidden="true" as hidden — explicit aria-hidden="false"
    // means the element is intentionally exposed and should remain focusable.
  ).filter((el) => el.getAttribute("aria-hidden") !== "true");
}

// Topmost-dialog wins. Without this, two open dialogs both attach window
// `keydown` listeners — Escape with a nested confirm dismisses both at
// once (inner closes via its handler, outer closes via its handler on
// the same event). The stack tracks every open dialog in mount order;
// only the LAST entry handles Tab/Escape, and it stopPropagation's to
// prevent any non-trap window listener from also acting.
const dialogStack: { container: HTMLElement }[] = [];

// Modal-dialog focus management: when `open` is true, focus moves into the
// container, Tab cycles within it, Escape closes the dialog, and the
// previously-focused element is restored when the dialog closes.
export function useDialogFocus<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
): RefObject<T> {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusables = getFocusable(container);
    (focusables[0] ?? container).focus();

    const stackEntry = { container };
    dialogStack.push(stackEntry);

    function onKeyDown(event: KeyboardEvent) {
      // Only the topmost dialog should respond. Multiple dialogs open
      // simultaneously (Settings → Clear Cache confirm) would otherwise
      // each fire their own onClose on the same Escape, collapsing the
      // whole stack at once.
      if (dialogStack[dialogStack.length - 1] !== stackEntry) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = getFocusable(container!);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      // "On the container itself" must be treated as outside the focusable
      // ring — otherwise Shift+Tab from the (tabIndex={-1}) container slips
      // back through the trap because `container.contains(container)` is
      // true, missing the `!container.contains(active)` branch.
      const onContainerItself = active === container;
      const outsideRing = onContainerItself || !container!.contains(active);
      if (event.shiftKey && (active === first || outsideRing)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outsideRing)) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const idx = dialogStack.indexOf(stackEntry);
      if (idx !== -1) dialogStack.splice(idx, 1);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  return ref;
}

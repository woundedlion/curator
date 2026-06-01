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

// Make everything OUTSIDE the dialog's DOM path non-interactive and
// invisible to assistive tech while the dialog is open. `aria-modal` alone
// is not reliably honored — many screen readers' virtual-cursor/browse
// modes still read the background behind it. We walk from the dialog
// container up to <body> and, at each level, set `inert` (blocks focus +
// pointer) and `aria-hidden="true"` on every sibling branch that does not
// contain the dialog. Prior attribute values are remembered and restored
// on close, so nested dialogs compose: an inner dialog re-inerting the
// outer one leaves it inert when the inner closes (the outer's own
// isolation still holds). Returns the restore function.
function isolateBackground(container: HTMLElement): () => void {
  const modified: {
    el: Element;
    hadInert: boolean;
    prevAriaHidden: string | null;
  }[] = [];
  let node: HTMLElement | null = container;
  while (node && node !== document.body) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children) as Element[]) {
      if (sibling === node || sibling.contains(container)) continue;
      modified.push({
        el: sibling,
        hadInert: sibling.hasAttribute("inert"),
        prevAriaHidden: sibling.getAttribute("aria-hidden"),
      });
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    }
    node = parent;
  }
  return () => {
    for (const m of modified) {
      if (!m.hadInert) m.el.removeAttribute("inert");
      if (m.prevAriaHidden === null) m.el.removeAttribute("aria-hidden");
      else m.el.setAttribute("aria-hidden", m.prevAriaHidden);
    }
  };
}

// Topmost-dialog wins. Without this, two open dialogs both attach window
// `keydown` listeners — Escape with a nested confirm dismisses both at
// once (inner closes via its handler, outer closes via its handler on
// the same event). The stack tracks every open dialog in mount order;
// only the LAST entry handles Tab/Escape, and it stopPropagation's to
// prevent any non-trap window listener from also acting.
const dialogStack: { container: HTMLElement }[] = [];

// Where to send focus on close when the element that opened the dialog is
// gone. The originating control is often a per-row glyph button inside a
// VIRTUALIZED grid: by the time the dialog closes, that row may have
// scrolled out and unmounted, so `previouslyFocused` is detached from the
// document. Restoring focus to a detached node is a no-op and focus
// silently falls to <body>, dropping a keyboard user out of the grid.
// Walk a prioritized list of still-present landmarks and focus the first
// one, making it programmatically focusable if it isn't already.
function focusFallbackTarget(): void {
  const candidates: (HTMLElement | null)[] = [
    document.querySelector<HTMLElement>('[role="grid"]'),
    document.querySelector<HTMLElement>("main"),
    document.body,
  ];
  for (const target of candidates) {
    if (!target) continue;
    // role="grid"/main are not natively focusable; give them a
    // programmatic-only tab stop (tabindex=-1) so .focus() takes effect
    // without inserting them into the Tab order.
    if (!target.hasAttribute("tabindex")) {
      target.setAttribute("tabindex", "-1");
    }
    target.focus();
    if (document.activeElement === target) return;
  }
}

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
    // Initial focus is captured once, synchronously, at open. The app's
    // dialogs render their focusable content synchronously, so the first
    // focusable exists by the time this effect runs. A dialog whose
    // focusable content appeared ASYNCHRONOUSLY after open would keep focus
    // on the container until the user Tabs — acceptable given no such
    // dialog exists; revisit (e.g. via a MutationObserver) if one is added.
    const focusables = getFocusable(container);
    (focusables[0] ?? container).focus();

    const stackEntry = { container };
    dialogStack.push(stackEntry);
    const restoreBackground = isolateBackground(container);

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
      restoreBackground();
      const idx = dialogStack.indexOf(stackEntry);
      if (idx !== -1) dialogStack.splice(idx, 1);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      } else {
        // The originating element unmounted while the dialog was open (a
        // virtualized grid row scrolled out). Don't let focus drop to
        // <body> — restore it to the grid / nearest landmark instead.
        focusFallbackTarget();
      }
    };
  }, [open]);

  return ref;
}

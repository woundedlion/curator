// @vitest-environment happy-dom
//
// Tests for useDialogFocus — the focus trap + Escape handler every
// modal in Curator uses. Three contracts to lock in:
//
//   1. Initial focus moves into the dialog (first focusable, or the
//      container itself when there are none).
//   2. Tab cycles inside the container, Shift+Tab wraps to last,
//      Tab-from-last wraps to first; the "focus is on the container
//      itself" edge is treated as outside the ring so Shift+Tab still
//      lands on the last focusable.
//   3. Escape calls onClose, BUT only on the topmost dialog when
//      multiple are open simultaneously (the Settings → Clear-Cache
//      confirm flow). Without the stack discipline both onClose'd
//      fire on the same Escape and the user dismisses both dialogs at
//      once.
//
// On unmount, focus is restored to whatever was focused before open.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useDialogFocus } from "./useDialogFocus";

afterEach(cleanup);

// ─── Test harness ────────────────────────────────────────────────────
//
// A minimal dialog component that uses the hook. Optional initial
// content controls how many focusables exist; tests need both
// "has-focusables" and "no-focusables" trees.

type DialogProps = {
  open: boolean;
  onClose: () => void;
  /**
   * Optional element id of the focusable to receive initial focus —
   * tests assert against this id.
   */
  testid?: string;
  buttons?: string[];
};

function Dialog({ open, onClose, testid = "dialog", buttons }: DialogProps) {
  const ref = useDialogFocus<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      tabIndex={-1}
      data-testid={testid}
      aria-label={testid}
    >
      {(buttons ?? ["First", "Second", "Third"]).map((label) => (
        <button key={label} data-testid={`btn-${label}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function DialogWithoutFocusables({
  open,
  onClose,
}: Omit<DialogProps, "buttons">) {
  const ref = useDialogFocus<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      tabIndex={-1}
      data-testid="empty-dialog"
      aria-label="empty"
    >
      <p>Plain text only — no focusable children.</p>
    </div>
  );
}

// Trigger focused before opening, used to verify "restore on unmount".
function OuterPage({
  dialogOpen,
  setOpen,
}: {
  dialogOpen: boolean;
  setOpen: (open: boolean) => void;
}) {
  // Auto-focus the trigger on mount so we can observe restoration.
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    triggerRef.current?.focus();
  }, []);
  return (
    <>
      <button ref={triggerRef} data-testid="trigger" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog open={dialogOpen} onClose={() => setOpen(false)} />
    </>
  );
}

// ─── 1. Initial focus ────────────────────────────────────────────────

describe("useDialogFocus — initial focus", () => {
  it("focuses the first focusable child when the dialog opens", () => {
    const { getByTestId } = render(<Dialog open onClose={() => undefined} />);
    expect(document.activeElement).toBe(getByTestId("btn-First"));
  });

  it("focuses the container itself when no focusable children exist", () => {
    // The hook's fallback: `focusables[0] ?? container` — used for
    // info-only dialogs that should still trap focus to prevent
    // background tab-out, but have nothing inside to anchor focus on.
    const { getByTestId } = render(
      <DialogWithoutFocusables open onClose={() => undefined} />,
    );
    expect(document.activeElement).toBe(getByTestId("empty-dialog"));
  });
});

// ─── 2. Tab cycling ──────────────────────────────────────────────────

describe("useDialogFocus — Tab/Shift+Tab cycle", () => {
  it("Tab from the LAST focusable wraps back to the FIRST", () => {
    const { getByTestId } = render(<Dialog open onClose={() => undefined} />);
    const last = getByTestId("btn-Third") as HTMLButtonElement;
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(getByTestId("btn-First"));
  });

  it("Shift+Tab from the FIRST focusable wraps to the LAST", () => {
    const { getByTestId } = render(<Dialog open onClose={() => undefined} />);
    const first = getByTestId("btn-First") as HTMLButtonElement;
    first.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(getByTestId("btn-Third"));
  });

  it("Shift+Tab while focus rests on the container itself lands on the LAST focusable", () => {
    // Regression test: the "container itself" case used to slip through
    // the trap because `container.contains(container)` is true, missing
    // the "outsideRing" branch. The hook explicitly handles this.
    const { getByTestId } = render(
      <Dialog open onClose={() => undefined} buttons={["A", "B"]} />,
    );
    const container = getByTestId("dialog") as HTMLDivElement;
    container.focus();
    expect(document.activeElement).toBe(container);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(getByTestId("btn-B"));
  });

  it("a non-Tab non-Escape key is a no-op (does not move focus)", () => {
    const { getByTestId } = render(<Dialog open onClose={() => undefined} />);
    const first = getByTestId("btn-First") as HTMLButtonElement;
    first.focus();
    fireEvent.keyDown(window, { key: "a" });
    expect(document.activeElement).toBe(first);
  });

  it("a dialog with NO focusables: Tab preventDefaults but doesn't move focus", () => {
    // No first/last to wrap between; the hook still preventDefaults so
    // Tab can't escape the container, but there's nowhere to send the
    // focus.
    const onCloseSpy = vi.fn();
    const { getByTestId } = render(
      <DialogWithoutFocusables open onClose={onCloseSpy} />,
    );
    const container = getByTestId("empty-dialog");
    expect(document.activeElement).toBe(container);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(container);
  });
});

// ─── 3. Escape handling ──────────────────────────────────────────────

describe("useDialogFocus — Escape", () => {
  it("Escape calls onClose", () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape with multiple dialogs open dismisses ONLY the topmost (no collapse)", () => {
    // Regression for the Settings → Clear-Cache confirm bug: both
    // dialogs listened on `window.keydown`; pressing Escape with both
    // open used to call BOTH onClose handlers and slam the entire
    // stack shut. The hook now maintains a module-scope dialog stack
    // and only the last entry handles the key (plus stopPropagation
    // for belt-and-suspenders).
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();
    render(
      <>
        <Dialog open onClose={onCloseOuter} testid="outer" buttons={["O1"]} />
        <Dialog open onClose={onCloseInner} testid="inner" buttons={["I1"]} />
      </>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    // Only the most-recently-opened dialog (inner) sees the Escape.
    expect(onCloseInner).toHaveBeenCalledTimes(1);
    expect(onCloseOuter).not.toHaveBeenCalled();
  });

  it("after the topmost dialog unmounts, Escape dismisses the next-down dialog", () => {
    // The stack must pop on unmount so a subsequent Escape reaches the
    // next dialog. Otherwise the outer dialog would be undismissable
    // by keyboard until the user clicked away.
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();
    const { rerender } = render(
      <>
        <Dialog open onClose={onCloseOuter} testid="outer" buttons={["O1"]} />
        <Dialog open onClose={onCloseInner} testid="inner" buttons={["I1"]} />
      </>,
    );
    // Close inner first by unmounting it.
    rerender(
      <>
        <Dialog open onClose={onCloseOuter} testid="outer" buttons={["O1"]} />
        <Dialog open={false} onClose={onCloseInner} testid="inner" />
      </>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseOuter).toHaveBeenCalledTimes(1);
    expect(onCloseInner).not.toHaveBeenCalled();
  });
});

// ─── 4. Focus restoration on unmount ─────────────────────────────────

describe("useDialogFocus — restoration on unmount", () => {
  it("focus returns to the previously-focused element when the dialog closes", () => {
    // Render an outer page with a focused trigger button; open the
    // dialog (focus moves inside); close (focus returns to trigger).
    const { getByTestId, rerender } = render(
      <OuterPage dialogOpen={false} setOpen={() => undefined} />,
    );
    const trigger = getByTestId("trigger") as HTMLButtonElement;
    expect(document.activeElement).toBe(trigger);

    rerender(<OuterPage dialogOpen={true} setOpen={() => undefined} />);
    // Focus is now inside the dialog (first focusable).
    expect(document.activeElement).toBe(getByTestId("btn-First"));

    rerender(<OuterPage dialogOpen={false} setOpen={() => undefined} />);
    expect(document.activeElement).toBe(trigger);
  });
});

// ─── 5. open=false ───────────────────────────────────────────────────

describe("useDialogFocus — open=false", () => {
  it("does not move focus and does not push onto the dialog stack", () => {
    // The effect bails on !open. Render two closed dialogs and then
    // an open one — Escape should target the open one regardless of
    // mount order, proving the closed ones never registered.
    const onCloseClosed = vi.fn();
    const onCloseOpen = vi.fn();
    render(
      <>
        <Dialog open={false} onClose={onCloseClosed} testid="closed-1" />
        <Dialog open={false} onClose={onCloseClosed} testid="closed-2" />
        <Dialog open onClose={onCloseOpen} testid="opened" buttons={["X"]} />
      </>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseOpen).toHaveBeenCalledTimes(1);
    expect(onCloseClosed).not.toHaveBeenCalled();
  });
});

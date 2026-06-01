// @vitest-environment happy-dom
//
// ToastList previously had no tests. The contract under test is the
// live-region announcement model: there must be exactly ONE coherent
// model, not a polite container wrapping assertive children (which made
// screen readers double-announce / disagree on politeness). Each toast
// now carries its own role — error → role="alert" (assertive), non-error
// → role="status" (polite) — and the container has NO aria-live.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ToastList } from "./ToastList";
import { useUiStore } from "../store/uiStore";

beforeEach(() => {
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ toasts: [] });
});

describe("ToastList — live-region structure", () => {
  it("the outer container is NOT itself a live region", () => {
    const { container } = render(<ToastList />);
    const region = container.querySelector("[aria-live]");
    expect(region).toBeNull();
  });

  it("error toasts use role=alert (assertive)", () => {
    render(<ToastList />);
    act(() => {
      useUiStore.getState().pushToast({ kind: "error", message: "boom" });
    });
    const toast = screen.getByText("boom").closest("[role]");
    expect(toast?.getAttribute("role")).toBe("alert");
  });

  it("non-error toasts use role=status (polite)", () => {
    render(<ToastList />);
    act(() => {
      useUiStore.getState().pushToast({ kind: "success", message: "saved" });
    });
    const toast = screen.getByText("saved").closest("[role]");
    expect(toast?.getAttribute("role")).toBe("status");
  });

  it("does not nest an assertive child inside a polite container", () => {
    render(<ToastList />);
    act(() => {
      useUiStore.getState().pushToast({ kind: "error", message: "nested" });
    });
    // No element with aria-live should contain the alert toast.
    const alert = screen.getByRole("alert");
    expect(alert.closest("[aria-live]")).toBeNull();
  });
});

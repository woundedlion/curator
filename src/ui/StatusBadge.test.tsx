// @vitest-environment happy-dom
//
// Verifies StatusBadge renders against the caller-supplied
// pendingStatus / idleStatus discriminators (finding 9). The prior
// `("pending" as S)` / `("idle" as S)` casts compared against hard-coded
// literals; these tests pin the behavior now that the discriminators are
// passed in — including that the badge works for a caller whose enum uses
// a DIFFERENT idle/pending vocabulary.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

afterEach(cleanup);

type S = "idle" | "pending" | "matched" | "missing";
const labels: Record<S, string> = {
  idle: "Idle",
  pending: "Pending",
  matched: "Matched",
  missing: "Missing",
};
const colors: Record<S, string> = {
  idle: "",
  pending: "",
  matched: "",
  missing: "",
};

function renderBadge(status: S, onPick?: () => void) {
  return render(
    <StatusBadge
      status={status}
      labels={labels}
      colors={colors}
      interactiveStatuses={["matched", "missing"]}
      pendingStatus="pending"
      idleStatus="idle"
      onPick={onPick}
    />,
  );
}

describe("StatusBadge", () => {
  it("renders the ellipsis for the pending status", () => {
    renderBadge("pending");
    expect(screen.getByLabelText("Pending").textContent).toBe("…");
  });

  it("renders a non-pending status as a glyph, not the ellipsis", () => {
    renderBadge("matched");
    expect(screen.getByLabelText("Matched").textContent).not.toBe("…");
  });

  it("is an interactive button only for interactive statuses with onPick", () => {
    const onPick = vi.fn();
    renderBadge("matched", onPick);
    const btn = screen.getByRole("button", { name: "Matched" });
    btn.click();
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("renders a static span for a non-interactive status", () => {
    renderBadge("idle", vi.fn());
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByLabelText("Idle")).toBeTruthy();
  });

  it("honors a caller-specific idle/pending vocabulary (no hard-coded literals)", () => {
    type T = "fresh" | "working" | "done";
    const tLabels: Record<T, string> = {
      fresh: "Fresh",
      working: "Working",
      done: "Done",
    };
    const tColors: Record<T, string> = { fresh: "", working: "", done: "" };
    render(
      <StatusBadge
        status="working"
        labels={tLabels}
        colors={tColors}
        interactiveStatuses={["done"]}
        pendingStatus="working"
        idleStatus="fresh"
      />,
    );
    // "working" is this caller's pending discriminator → ellipsis.
    expect(screen.getByLabelText("Working").textContent).toBe("…");
  });
});

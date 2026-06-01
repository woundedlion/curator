// @vitest-environment happy-dom
//
// NameCollisionDialog previously had no tests. It's a pure presentational
// dialog (no stores) with two modes:
//   - exactly one same-named playlist  → Replace / Cancel actions
//   - several same-named playlists     → a picker list + Cancel
// and a null render when there are no matches. Covers the mode split, the
// id passed to onReplace, and the Cancel path.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NameCollisionDialog } from "./NameCollisionDialog";
import type { SpotifyPlaylistSummary } from "../types";

function summary(
  id: string,
  name: string,
  trackCount?: number,
): SpotifyPlaylistSummary {
  return { id, name, ownerId: "me", trackCount };
}

afterEach(() => {
  cleanup();
});

describe("NameCollisionDialog", () => {
  it("renders nothing when there are no matches", () => {
    const { container } = render(
      <NameCollisionDialog
        candidateName="My Mix"
        matches={[]}
        onReplace={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("single match: Replace passes the match id; Cancel fires onCancel", () => {
    const onReplace = vi.fn();
    const onCancel = vi.fn();
    render(
      <NameCollisionDialog
        candidateName="My Mix"
        matches={[summary("pl-1", "My Mix", 12)]}
        onReplace={onReplace}
        onCancel={onCancel}
      />,
    );
    // Single-match mode shows the Replace existing action.
    fireEvent.click(screen.getByRole("button", { name: "Replace existing" }));
    expect(onReplace).toHaveBeenCalledWith("pl-1");
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("multiple matches: renders one button per match and replaces the picked one", () => {
    const onReplace = vi.fn();
    render(
      <NameCollisionDialog
        candidateName="Dupes"
        matches={[
          summary("pl-1", "Dupes", 3),
          summary("pl-2", "Dupes", 9),
        ]}
        onReplace={onReplace}
        onCancel={() => {}}
      />,
    );
    // The multi-match picker shows a track count per row...
    expect(screen.getByText("3 tracks")).toBeTruthy();
    expect(screen.getByText("9 tracks")).toBeTruthy();
    // ...and there is NO single-match "Replace existing" button.
    expect(
      screen.queryByRole("button", { name: "Replace existing" }),
    ).toBeNull();

    // Pick the second playlist by clicking its row button (named by its
    // accessible text content).
    const rows = screen.getAllByRole("button", { name: /Dupes/ });
    fireEvent.click(rows[1]!);
    expect(onReplace).toHaveBeenCalledWith("pl-2");
  });

  it("renders '? tracks' when a match has an unknown track count", () => {
    render(
      <NameCollisionDialog
        candidateName="Dupes"
        matches={[summary("pl-1", "Dupes"), summary("pl-2", "Dupes", 1)]}
        onReplace={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("? tracks")).toBeTruthy();
  });

  it("shows the candidate name in the heading", () => {
    render(
      <NameCollisionDialog
        candidateName="Roadtrip 2026"
        matches={[summary("pl-1", "Roadtrip 2026", 1)]}
        onReplace={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/Roadtrip 2026/)).toBeTruthy();
  });

  it("clicking the backdrop cancels (== onCancel) without replacing", () => {
    const onReplace = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <NameCollisionDialog
        candidateName="My Mix"
        matches={[summary("pl-1", "My Mix", 12)]}
        onReplace={onReplace}
        onCancel={onCancel}
      />,
    );
    const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement;
    // A genuine backdrop click presses AND releases on the backdrop.
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("REGRESSION: a press starting in the panel and releasing on the backdrop does NOT cancel", () => {
    const onReplace = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <NameCollisionDialog
        candidateName="My Mix"
        matches={[summary("pl-1", "My Mix", 12)]}
        onReplace={onReplace}
        onCancel={onCancel}
      />,
    );
    const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement;
    const panel = screen.getByRole("dialog");
    fireEvent.mouseDown(panel);
    fireEvent.click(backdrop);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("clicking inside the panel does NOT cancel", () => {
    const onCancel = vi.fn();
    render(
      <NameCollisionDialog
        candidateName="My Mix"
        matches={[summary("pl-1", "My Mix", 12)]}
        onReplace={() => {}}
        onCancel={onCancel}
      />,
    );
    // Click the heading inside the panel — must not bubble to the backdrop.
    fireEvent.click(screen.getByText(/You already have a playlist named/));
    expect(onCancel).not.toHaveBeenCalled();
  });
});

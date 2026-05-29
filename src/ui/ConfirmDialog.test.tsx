// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

afterEach(cleanup);

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ConfirmDialog
        open={false}
        title="t"
        message="m"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("calls onConfirm when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Remove tracks?"
        message="This cannot be undone."
        confirmLabel="Remove"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the backdrop is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    // The dialog itself is role=alertdialog; its parent is the backdrop.
    const dialog = screen.getByRole("alertdialog");
    const backdrop = dialog.parentElement!;
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not call onCancel when the dialog body is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("alertdialog"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel on Escape via the focus-trap hook", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("uses the matched-green color for kind=info", () => {
    const { rerender } = render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    // default kind is danger — confirm button has red classes
    expect(
      screen.getByRole("button", { name: "Confirm" }).className,
    ).toMatch(/bg-red-600/);

    rerender(
      <ConfirmDialog
        open
        kind="info"
        title="t"
        message="m"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Confirm" }).className,
    ).toMatch(/bg-matched/);
  });
});

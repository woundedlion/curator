// @vitest-environment happy-dom
//
// DropZone previously had no direct tests. It listens at the window for
// drag/drop and routes drops to either the playlist-append or the
// file-ingest path. The subtle, load-bearing behaviors covered here:
//
//   1. The drop handler snapshots everything it needs from the
//      DataTransfer SYNCHRONOUSLY (playlist id, then dt.items handed to
//      the walker) BEFORE any await — because the DataTransfer is
//      neutered the moment control returns to the event loop. We assert
//      the playlist-id branch fires synchronously and the walker is
//      handed the live items.
//   2. When a modal (Settings / Create) is open, the window listeners
//      are NOT attached (drops belong to the modal's inputs), and any
//      stale `active` overlay state is reset so the overlay can't
//      reappear after the modal closes.
//   3. A walker rejection in the async drop path is CAUGHT and surfaced
//      as a toast — it must never become an unhandled rejection.
//
// happy-dom has no real DataTransfer, so we hand-roll a minimal stub.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const walkDataTransferItems =
  vi.fn<(items: unknown, opts: { recursive: boolean }) => Promise<File[]>>(
    async () => [],
  );
vi.mock("../ingest/folderWalker", () => ({
  walkDataTransferItems: (items: unknown, opts: { recursive: boolean }) =>
    walkDataTransferItems(items, opts),
}));

import { DropZone } from "./DropZone";
import { useUiStore } from "../store/uiStore";
import { PLAYLIST_DRAG_MIME } from "./dragData";

// Minimal DataTransfer stub. `types` drives detection; `getData` returns
// the playlist id; `items` is the opaque list the walker consumes.
function makeDataTransfer(opts: {
  types: string[];
  playlistId?: string;
  items?: unknown[];
}): DataTransfer {
  return {
    types: opts.types,
    items: (opts.items ?? []) as unknown as DataTransferItemList,
    getData: (mime: string) =>
      mime === PLAYLIST_DRAG_MIME ? (opts.playlistId ?? "") : "",
  } as unknown as DataTransfer;
}

function fireWindowDrop(dt: DataTransfer): void {
  const evt = new Event("drop", { cancelable: true }) as DragEvent;
  Object.defineProperty(evt, "dataTransfer", { value: dt });
  window.dispatchEvent(evt);
}

beforeEach(() => {
  useUiStore.setState({ showSettings: false, showCreateDialog: false });
  walkDataTransferItems.mockReset();
  walkDataTransferItems.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DropZone — synchronous DataTransfer snapshot", () => {
  it("a playlist drop reads the id synchronously and routes to onPlaylistDropped (no walker, no await)", () => {
    const onFilesDropped = vi.fn();
    const onPlaylistDropped = vi.fn();
    render(
      <DropZone
        onFilesDropped={onFilesDropped}
        onPlaylistDropped={onPlaylistDropped}
        recursive={false}
      />,
    );

    fireWindowDrop(
      makeDataTransfer({
        types: [PLAYLIST_DRAG_MIME],
        playlistId: "pl-42",
      }),
    );

    // The playlist branch is synchronous — fired before any microtask.
    expect(onPlaylistDropped).toHaveBeenCalledWith("pl-42");
    expect(walkDataTransferItems).not.toHaveBeenCalled();
    expect(onFilesDropped).not.toHaveBeenCalled();
  });

  it("a file drop hands the live dt.items to the walker, then forwards the result", async () => {
    const items = [{ kind: "file" }];
    const files = [new File(["x"], "a.mp3")];
    walkDataTransferItems.mockResolvedValueOnce(files);
    const onFilesDropped = vi.fn();
    render(
      <DropZone
        onFilesDropped={onFilesDropped}
        onPlaylistDropped={vi.fn()}
        recursive={true}
      />,
    );

    fireWindowDrop(makeDataTransfer({ types: ["Files"], items }));

    // The walker received the exact items list and the recursive flag.
    expect(walkDataTransferItems).toHaveBeenCalledTimes(1);
    const [passedItems, opts] = walkDataTransferItems.mock.calls[0]!;
    expect(passedItems).toBe(items);
    expect(opts).toEqual({ recursive: true });

    // Let the async drop resolve, then the files are forwarded.
    await vi.waitFor(() => expect(onFilesDropped).toHaveBeenCalledWith(files));
  });
});

describe("DropZone — async error handling", () => {
  it("a walker rejection is caught and surfaced as a toast (no unhandled rejection)", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const pushToast = vi.fn();
    useUiStore.setState({ pushToast });
    walkDataTransferItems.mockRejectedValueOnce(new Error("boom"));

    render(
      <DropZone
        onFilesDropped={vi.fn()}
        onPlaylistDropped={vi.fn()}
        recursive={false}
      />,
    );
    fireWindowDrop(makeDataTransfer({ types: ["Files"], items: [{}] }));

    await vi.waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "error" }),
      ),
    );
    // The rejection was swallowed inside the handler.
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});

describe("DropZone — modal suppression", () => {
  it("does not attach drop listeners while a modal is open", () => {
    useUiStore.setState({ showSettings: true });
    const onPlaylistDropped = vi.fn();
    render(
      <DropZone
        onFilesDropped={vi.fn()}
        onPlaylistDropped={onPlaylistDropped}
        recursive={false}
      />,
    );
    // With the modal up, the window drop listener isn't attached, so a
    // drop is ignored by the DropZone (belongs to the modal).
    fireWindowDrop(
      makeDataTransfer({ types: [PLAYLIST_DRAG_MIME], playlistId: "pl-9" }),
    );
    expect(onPlaylistDropped).not.toHaveBeenCalled();
  });

  it("resets stale active overlay state when a modal opens", () => {
    const { rerender, container } = render(
      <DropZone
        onFilesDropped={vi.fn()}
        onPlaylistDropped={vi.fn()}
        recursive={false}
      />,
    );
    // Simulate a drag-over to set `active` so the overlay would render.
    // Wrapped in act so the setActive state update flushes before we
    // assert on the DOM.
    const over = new Event("dragover", { cancelable: true }) as DragEvent;
    Object.defineProperty(over, "dataTransfer", {
      value: makeDataTransfer({ types: ["Files"] }),
    });
    act(() => {
      window.dispatchEvent(over);
    });
    // Overlay is now showing (role=status present).
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    // Open a modal → the effect resets `active` AND the render gate
    // hides the overlay.
    useUiStore.setState({ showSettings: true });
    rerender(
      <DropZone
        onFilesDropped={vi.fn()}
        onPlaylistDropped={vi.fn()}
        recursive={false}
      />,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();

    // Closing the modal must NOT bring the stale overlay back (active was
    // reset, and no new dragover heartbeat has fired).
    useUiStore.setState({ showSettings: false });
    rerender(
      <DropZone
        onFilesDropped={vi.fn()}
        onPlaylistDropped={vi.fn()}
        recursive={false}
      />,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

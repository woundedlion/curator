// @vitest-environment happy-dom
//
// Tests for folderWalker — the DOM-side recursive directory walker that
// turns a drag-drop or "Choose Folder" picker into a flat File[] for
// the ingest pipeline. Two APIs are supported and must both observe
// the safety contract:
//
//   - The legacy webkitGetAsEntry / FileSystemEntry tree (used when the
//     user drag-drops a folder onto the drop zone — DataTransfer items
//     expose this on every browser we care about).
//   - The modern FileSystemDirectoryHandle.entries() API (used when the
//     user picks a folder via the File System Access API).
//
// Both walkers must:
//   * filter out non-ingestible files (.DS_Store, .pdf, etc.),
//   * tolerate per-entry failures without aborting the whole walk
//     (one unreadable file / directory shouldn't kill a multi-thousand-
//     file drop),
//   * cap depth at MAX_WALK_DEPTH=32 so a cycle or pathologically deep
//     tree truncates with a console.warn instead of hanging the tab,
//     and
//   * break cycles (the legacy API's fullPath, the handle API's object
//     identity).
//
// The fakes are minimal: just enough shape for the production code to
// run unchanged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { walkDataTransferItems, walkDirectoryHandle } from "./folderWalker";

// ─── Legacy FileSystemEntry fake (webkitGetAsEntry tree) ─────────────

type FakeFileEntry = {
  isFile: true;
  isDirectory: false;
  fullPath: string;
  file: (
    success: (file: File) => void,
    error?: (err: unknown) => void,
  ) => void;
};

type FakeDirectoryEntry = {
  isFile: false;
  isDirectory: true;
  fullPath: string;
  createReader: () => {
    readEntries: (
      success: (entries: (FakeFileEntry | FakeDirectoryEntry)[]) => void,
      error?: (err: unknown) => void,
    ) => void;
  };
};

type FakeFsEntry = FakeFileEntry | FakeDirectoryEntry;

function fileEntry(name: string, fullPath: string): FakeFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    fullPath,
    file(success) {
      // Production reads `file.name` to gate on ingestibility; the
      // resolved File is otherwise structural. A real File via
      // happy-dom keeps the test honest about the contract.
      success(new File([new Uint8Array([0])], name));
    },
  };
}

function failingFileEntry(name: string, fullPath: string): FakeFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    fullPath,
    file(_success, error) {
      error?.(new Error(`unreadable: ${name}`));
    },
  };
}

function dirEntry(
  fullPath: string,
  children: FakeFsEntry[],
): FakeDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    fullPath,
    createReader() {
      // The real entries-reader hands back children in batches and
      // signals end with an empty array. Honoring that protocol means
      // production's readBatch loop runs once with all children then
      // once with []. Splitting into multiple batches doesn't change
      // semantics; we keep it single-batch for clarity.
      let delivered = false;
      return {
        readEntries(success) {
          if (delivered) {
            success([]);
            return;
          }
          delivered = true;
          success(children);
        },
      };
    },
  };
}

function failingDirEntry(fullPath: string): FakeDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    fullPath,
    createReader() {
      return {
        readEntries(_success, error) {
          error?.(new Error(`enumerate failed: ${fullPath}`));
        },
      };
    },
  };
}

function asDataTransferItems(entries: FakeFsEntry[]): DataTransferItemList {
  // walkDataTransferItems indexes the iterable like an array and calls
  // `webkitGetAsEntry()` on each item. A minimal shape with `length`
  // and integer keys is enough — DataTransferItemList is otherwise an
  // exotic object, but this code path only reads what we provide.
  const items: Partial<DataTransferItem>[] = entries.map((entry) => ({
    webkitGetAsEntry: () => entry as unknown as FileSystemEntry,
  }));
  const list = items as unknown as DataTransferItemList;
  Object.defineProperty(list, "length", { value: items.length });
  return list;
}

// ─── Modern FileSystemDirectoryHandle fake ───────────────────────────
//
// The production walker yields (name, handle) tuples from a directory's
// entries() iterator and reads `.kind` on each. To match the wire
// contract precisely, our fakes ARE the handles — a directory's child
// is either a FakeFileHandle (kind="file", getFile) or another
// FakeDirectoryHandle (kind="directory", entries). No wrapping objects.

type FakeFileHandle = {
  readonly kind: "file";
  readonly name: string;
  getFile: () => Promise<File>;
};

type FakeAnyDirectoryHandle = FakeDirectoryHandle | ThrowingDirectoryHandle;
type FakeChild = FakeFileHandle | FakeAnyDirectoryHandle;

class FakeDirectoryHandle {
  readonly kind = "directory" as const;
  constructor(
    readonly name: string,
    private readonly children: FakeChild[],
    private readonly onEnumerate?: () => void,
  ) {}

  entries(): AsyncIterable<[string, FakeChild]> {
    const children = this.children;
    const onEnumerate = this.onEnumerate;
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next(): Promise<IteratorResult<[string, FakeChild]>> {
            if (onEnumerate) onEnumerate();
            if (i >= children.length) {
              return Promise.resolve({ value: undefined, done: true });
            }
            const child = children[i++]!;
            return Promise.resolve({
              value: [child.name, child],
              done: false,
            });
          },
        };
      },
    };
  }
}

class ThrowingDirectoryHandle {
  readonly kind = "directory" as const;
  constructor(readonly name: string) {}
  entries(): AsyncIterable<[string, FakeChild]> {
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<[string, FakeChild]>> {
            return Promise.reject(
              new Error(`entries() failed: enum aborted`),
            );
          },
        };
      },
    };
  }
}

function fileChild(name: string): FakeFileHandle {
  return {
    kind: "file",
    name,
    getFile: async () => new File([new Uint8Array([0])], name),
  };
}

function failingFileChild(name: string): FakeFileHandle {
  return {
    kind: "file",
    name,
    getFile: async () => {
      throw new Error(`getFile failed: ${name}`);
    },
  };
}

// ─── Suite setup ─────────────────────────────────────────────────────

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

// ─── 1. walkDataTransferItems (legacy entries API) ───────────────────

describe("walkDataTransferItems", () => {
  it("walks a nested tree and returns every ingestible file flattened", async () => {
    // Two roots: a folder and a loose file. The folder has a subfolder
    // with one .mp3 and one .DS_Store. The loose file is a .flac. The
    // walker must return the .mp3 + .flac (NOT the .DS_Store) in one
    // flat list. Order isn't part of the contract — we assert by set.
    const tree: FakeFsEntry[] = [
      dirEntry("/Music", [
        dirEntry("/Music/Album", [
          fileEntry("01-track.mp3", "/Music/Album/01-track.mp3"),
          fileEntry(".DS_Store", "/Music/Album/.DS_Store"),
        ]),
      ]),
      fileEntry("loose.flac", "/loose.flac"),
    ];

    const files = await walkDataTransferItems(asDataTransferItems(tree), {
      recursive: true,
    });

    expect(files.map((f) => f.name).sort()).toEqual([
      "01-track.mp3",
      "loose.flac",
    ]);
  });

  it("recursive: false stops descending — only top-level files are returned", async () => {
    // The "Folder" item-itself is dropped at the top level; with
    // recursive false the walker enumerates one level deep and then
    // filters children to files. Anything inside a sub-sub-folder
    // (the .ogg in nested/) is invisible.
    const tree: FakeFsEntry[] = [
      dirEntry("/", [
        fileEntry("root.mp3", "/root.mp3"),
        dirEntry("/nested", [
          fileEntry("buried.ogg", "/nested/buried.ogg"),
        ]),
      ]),
    ];

    const files = await walkDataTransferItems(asDataTransferItems(tree), {
      recursive: false,
    });

    expect(files.map((f) => f.name)).toEqual(["root.mp3"]);
  });

  it("a single failing file doesn't abort the walk — siblings still arrive", async () => {
    // Pre-fix, the walker used Promise.all over a level: one rejection
    // bubbled up and the whole drop failed. Post-fix it's
    // Promise.allSettled with per-entry warn — siblings survive.
    const tree: FakeFsEntry[] = [
      dirEntry("/", [
        fileEntry("ok-1.mp3", "/ok-1.mp3"),
        failingFileEntry("broken.mp3", "/broken.mp3"),
        fileEntry("ok-2.mp3", "/ok-2.mp3"),
      ]),
    ];

    const files = await walkDataTransferItems(asDataTransferItems(tree), {
      recursive: true,
    });

    expect(files.map((f) => f.name).sort()).toEqual(["ok-1.mp3", "ok-2.mp3"]);
    expect(warnSpy).toHaveBeenCalledWith(
      "folderWalker: failed to read file entry",
      "/broken.mp3",
      expect.any(Error),
    );
  });

  it("a failing subdirectory doesn't abort the walk — sibling subtrees still arrive", async () => {
    // Same defense, one level up. If a subdirectory's readEntries
    // fails (permissions, race with rename), the walk must continue
    // through the other subtrees.
    const tree: FakeFsEntry[] = [
      dirEntry("/root", [
        failingDirEntry("/root/no-perms"),
        dirEntry("/root/ok", [
          fileEntry("good.mp3", "/root/ok/good.mp3"),
        ]),
      ]),
    ];

    const files = await walkDataTransferItems(asDataTransferItems(tree), {
      recursive: true,
    });

    expect(files.map((f) => f.name)).toEqual(["good.mp3"]);
    expect(warnSpy).toHaveBeenCalledWith(
      "folderWalker: failed to read directory entry",
      "/root/no-perms",
      expect.any(Error),
    );
  });

  it("cycle protection: the same directory fullPath is not enumerated twice", async () => {
    // The drop API surfaces filesystem symlinks transparently — under
    // unfortunate conditions (a -> b -> a) the BFS would walk forever.
    // The walker dedupes on fullPath. Build a child that references
    // the *same* fullPath as its parent's sibling — the second
    // occurrence is silently skipped (NOT enumerated).
    const loopChildren: FakeFsEntry[] = [
      fileEntry("inner.mp3", "/cycle/inner.mp3"),
    ];
    const dirA = dirEntry("/cycle", loopChildren);
    const dirB = dirEntry("/cycle", loopChildren); // same fullPath
    // Mark the second as already-seen by listing both at level 1.
    const enumerateSpyA = vi.spyOn(dirA, "createReader");
    const enumerateSpyB = vi.spyOn(dirB, "createReader");

    const tree: FakeFsEntry[] = [dirA, dirB];
    const files = await walkDataTransferItems(asDataTransferItems(tree), {
      recursive: true,
    });

    expect(files.map((f) => f.name)).toEqual(["inner.mp3"]);
    expect(enumerateSpyA).toHaveBeenCalled();
    // Second occurrence with the same fullPath was filtered before
    // createReader was called.
    expect(enumerateSpyB).not.toHaveBeenCalled();
  });

  it("depth cap: a deeply nested tree truncates at MAX_WALK_DEPTH with a console.warn", async () => {
    // Build a chain of 40 nested directories with an .mp3 at the
    // bottom. The MAX_WALK_DEPTH=32 ceiling means the bottom .mp3 is
    // unreachable; the walker emits a warn and returns whatever it
    // found above the cap.
    let chain: FakeFsEntry = fileEntry("buried.mp3", "/d/buried.mp3");
    for (let depth = 40; depth > 0; depth--) {
      chain = dirEntry(`/d/${depth}`, [chain]);
    }

    const files = await walkDataTransferItems(asDataTransferItems([chain]), {
      recursive: true,
    });

    expect(files).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("folderWalker: truncating at depth"),
    );
  });

  it("an empty DataTransferItemList resolves to an empty array (no warns)", async () => {
    const files = await walkDataTransferItems(asDataTransferItems([]), {
      recursive: true,
    });
    expect(files).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─── 2. walkDirectoryHandle (modern File System Access API) ──────────

describe("walkDirectoryHandle", () => {
  it("walks the handle tree and returns ingestible files flattened", async () => {
    const inner = new FakeDirectoryHandle("Album", [
      fileChild("01.mp3"),
      fileChild(".DS_Store"),
    ]);
    const root = new FakeDirectoryHandle("Music", [
      inner,
      fileChild("loose.flac"),
    ]);

    const files = await walkDirectoryHandle(
      root as unknown as FileSystemDirectoryHandle,
      { recursive: true },
    );

    expect(files.map((f) => f.name).sort()).toEqual(["01.mp3", "loose.flac"]);
  });

  it("recursive: false collects only the directory's own files", async () => {
    const inner = new FakeDirectoryHandle("nested", [fileChild("buried.mp3")]);
    const root = new FakeDirectoryHandle("root", [fileChild("top.mp3"), inner]);

    const files = await walkDirectoryHandle(
      root as unknown as FileSystemDirectoryHandle,
      { recursive: false },
    );

    expect(files.map((f) => f.name)).toEqual(["top.mp3"]);
  });

  it("one failing getFile() doesn't abort the walk", async () => {
    const root = new FakeDirectoryHandle("root", [
      fileChild("ok-1.mp3"),
      failingFileChild("broken.mp3"),
      fileChild("ok-2.mp3"),
    ]);

    const files = await walkDirectoryHandle(
      root as unknown as FileSystemDirectoryHandle,
      { recursive: true },
    );

    expect(files.map((f) => f.name).sort()).toEqual(["ok-1.mp3", "ok-2.mp3"]);
    expect(warnSpy).toHaveBeenCalledWith(
      "folderWalker: failed to read file handle",
      "broken.mp3",
      expect.any(Error),
    );
  });

  it("a throwing entries() iterator on one subdirectory doesn't abort the walk", async () => {
    const root = new FakeDirectoryHandle("root", [
      new ThrowingDirectoryHandle("bad"),
      new FakeDirectoryHandle("good", [fileChild("good.mp3")]),
    ]);

    const files = await walkDirectoryHandle(
      root as unknown as FileSystemDirectoryHandle,
      { recursive: true },
    );

    expect(files.map((f) => f.name)).toEqual(["good.mp3"]);
    expect(warnSpy).toHaveBeenCalledWith(
      "folderWalker: failed to enumerate directory",
      "bad",
      expect.any(Error),
    );
  });

  it("cycle protection: the same FileSystemDirectoryHandle instance is not enumerated twice", async () => {
    // The modern API doesn't expose a stable string path — the walker
    // dedupes on handle identity (the same FileSystemDirectoryHandle
    // object). Two pointers to the same directory inside a tree
    // resolves to a single enumeration.
    let enumerationCount = 0;
    const shared = new FakeDirectoryHandle(
      "shared",
      [fileChild("inside.mp3")],
      () => {
        enumerationCount++;
      },
    );
    const root = new FakeDirectoryHandle("root", [
      shared,
      // Same handle reference, second occurrence. Without dedup the
      // walker would enumerate twice (and on a real cycle, forever).
      shared,
    ]);

    const files = await walkDirectoryHandle(
      root as unknown as FileSystemDirectoryHandle,
      { recursive: true },
    );

    expect(files.map((f) => f.name)).toEqual(["inside.mp3"]);
    // onEnumerate is called once per .next() tick of the iterator:
    // one for the file child, one for the "done" sentinel — i.e.,
    // exactly one full enumeration of `shared` despite two references
    // from `root`.
    expect(enumerationCount).toBe(2);
  });

  it("depth cap: nested handles past MAX_WALK_DEPTH truncate with a console.warn", async () => {
    // Build 40 nested handles with an .mp3 at the bottom. The handle
    // walker increments depth on each recursive call and bails (with
    // a warn) when the threshold is crossed.
    let chain: FakeDirectoryHandle = new FakeDirectoryHandle("bottom", [
      fileChild("buried.mp3"),
    ]);
    for (let depth = 40; depth > 0; depth--) {
      chain = new FakeDirectoryHandle(`level-${depth}`, [chain]);
    }

    const files = await walkDirectoryHandle(
      chain as unknown as FileSystemDirectoryHandle,
      { recursive: true },
    );

    expect(files).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("folderWalker: truncating at depth"),
      expect.any(String),
    );
  });

  it("an empty directory handle resolves to an empty array (no warns)", async () => {
    const root = new FakeDirectoryHandle("root", []);
    const files = await walkDirectoryHandle(
      root as unknown as FileSystemDirectoryHandle,
      { recursive: true },
    );
    expect(files).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

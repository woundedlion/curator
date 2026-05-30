import { isIngestibleFile } from "./fileExtension";

type FsEntry = FileSystemEntry & {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
};

type FileEntry = FsEntry & {
  file(success: (file: File) => void, error?: (err: unknown) => void): void;
};

type DirectoryEntry = FsEntry & {
  createReader(): {
    readEntries(
      success: (entries: FsEntry[]) => void,
      error?: (err: unknown) => void,
    ): void;
  };
};

// Defensive caps. The drop API exposes no native depth/cycle protection;
// a symlinked tree (legal on some platforms via the legacy entries API)
// could otherwise walk forever. 32 levels comfortably covers real music
// libraries; on the unlikely hit the walk truncates with a console warn
// rather than the ingest hanging the tab.
const MAX_WALK_DEPTH = 32;

function readDirectory(directory: DirectoryEntry): Promise<FsEntry[]> {
  return new Promise((resolve, reject) => {
    const reader = directory.createReader();
    const all: FsEntry[] = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

function readFile(fileEntry: FileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    fileEntry.file(resolve, reject);
  });
}

export async function walkDataTransferItems(
  items: DataTransferItemList,
  options: { recursive: boolean },
): Promise<File[]> {
  // CRITICAL: snapshot every item's entry SYNCHRONOUSLY, before the
  // first `await`. A DataTransferItemList (and the DataTransferItem
  // objects it holds) is only valid during the synchronous portion of
  // the drop event handler — the browser invalidates it the moment the
  // event task yields. `webkitGetAsEntry()` must therefore be called for
  // all items here, while we still hold the live list; the resulting
  // FileSystemEntry objects stay valid across the async walk. This
  // function is `async` only for its return type — there is no `await`
  // between entering it and finishing this loop, so the snapshot is
  // guaranteed to complete before any task boundary. Dropped folders
  // were being lost when this was deferred past an await.
  const roots: FsEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]?.webkitGetAsEntry?.() as FsEntry | null;
    if (entry) roots.push(entry);
  }
  return walkEntries(roots, options);
}

async function walkEntries(
  roots: FsEntry[],
  options: { recursive: boolean },
): Promise<File[]> {
  // Level-order BFS that parallelizes every read at each level. The
  // previous one-entry-at-a-time loop serialized all readFile +
  // readDirectory awaits; on a multi-thousand-file drop the awaits
  // dominated wall-clock time even though each call is a few
  // microseconds. Within-level Promise.allSettled preserves bounded
  // memory (we never hold more entries in flight than one level's
  // width) AND tolerates per-entry failures — one unreadable file or
  // unreadable subdirectory no longer kills the whole drop.
  const files: File[] = [];
  let level: FsEntry[] = [...roots];
  // fullPath is the only stable identity exposed by the entries API;
  // good enough to break a symlink/loop cycle on the rare drops where
  // those occur.
  const seenDirPaths = new Set<string>();
  let depth = 0;

  while (level.length > 0) {
    const fileEntries: FileEntry[] = [];
    const dirEntries: DirectoryEntry[] = [];
    for (const entry of level) {
      if (entry.isFile) fileEntries.push(entry as FileEntry);
      else if (entry.isDirectory) {
        const path = entry.fullPath ?? "";
        if (path && seenDirPaths.has(path)) continue;
        if (path) seenDirPaths.add(path);
        dirEntries.push(entry as DirectoryEntry);
      }
    }

    // Files at the current level are ALWAYS read — including at the
    // truncation boundary. This matches the handle walker
    // (`walkHandleInto`), which reads a directory's own files at its own
    // depth and only gates *descent* into subdirectories by depth+1.
    // Reading files first, then gating descent, makes both walkers
    // truncate at the same effective directory depth for the same
    // MAX_WALK_DEPTH (a file inside a directory at depth `d` is kept iff
    // `d <= MAX_WALK_DEPTH`). The previous "break before reading the
    // whole level" gate dropped files one level shallower than the
    // handle walker did.
    const fileResults = await Promise.allSettled(fileEntries.map(readFile));
    for (let i = 0; i < fileResults.length; i++) {
      const result = fileResults[i]!;
      if (result.status === "fulfilled") {
        if (isIngestibleFile(result.value.name)) files.push(result.value);
      } else {
        console.warn(
          "folderWalker: failed to read file entry",
          fileEntries[i]?.fullPath ?? "(unknown)",
          result.reason,
        );
      }
    }

    // Descent gate: once we're past the depth ceiling, read this level's
    // files (above) but do not enumerate any deeper directories. Using
    // the SAME `depth > MAX_WALK_DEPTH` comparison the handle walker uses
    // — combined with reading files before the gate — makes both walkers
    // keep a file nested exactly `MAX_WALK_DEPTH` directory-levels below
    // the root and truncate the level below that.
    if (depth > MAX_WALK_DEPTH) {
      if (dirEntries.length > 0) {
        console.warn(
          `folderWalker: truncating at depth ${MAX_WALK_DEPTH}; ${dirEntries.length} director${dirEntries.length === 1 ? "y" : "ies"} skipped`,
        );
      }
      break;
    }

    const childResults = await Promise.allSettled(
      dirEntries.map(readDirectory),
    );
    const nextLevel: FsEntry[] = [];
    for (let i = 0; i < childResults.length; i++) {
      const result = childResults[i]!;
      if (result.status !== "fulfilled") {
        console.warn(
          "folderWalker: failed to read directory entry",
          dirEntries[i]?.fullPath ?? "(unknown)",
          result.reason,
        );
        continue;
      }
      const children = result.value;
      if (options.recursive) nextLevel.push(...children);
      else nextLevel.push(...children.filter((c) => c.isFile));
    }
    level = nextLevel;
    depth++;
  }

  return files;
}

export async function walkDirectoryHandle(
  directory: FileSystemDirectoryHandle,
  options: { recursive: boolean },
): Promise<File[]> {
  const files: File[] = [];
  await walkHandleInto(directory, options, files, 0, new Set());
  return files;
}

type EntriesCapable = {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
};

async function walkHandleInto(
  directory: FileSystemDirectoryHandle,
  options: { recursive: boolean },
  files: File[],
  depth: number,
  seenDirs: Set<FileSystemDirectoryHandle>,
): Promise<void> {
  // The entries() iterator itself is necessarily serial (the
  // underlying spec doesn't expose a batched read), but every per-entry
  // await — getFile() for files, recursive descent for directories —
  // happens in parallel after collection. On deep trees this turns
  // O(total-entries) sequential awaits into O(tree-depth).
  if (depth > MAX_WALK_DEPTH) {
    console.warn(
      `folderWalker: truncating at depth ${MAX_WALK_DEPTH}`,
      directory.name,
    );
    return;
  }
  if (seenDirs.has(directory)) return;
  seenDirs.add(directory);

  const fileHandles: FileSystemFileHandle[] = [];
  const dirHandles: FileSystemDirectoryHandle[] = [];
  try {
    const iterable = (directory as unknown as EntriesCapable).entries();
    for await (const [, handle] of iterable) {
      if (handle.kind === "file") {
        fileHandles.push(handle as FileSystemFileHandle);
      } else if (handle.kind === "directory" && options.recursive) {
        dirHandles.push(handle as FileSystemDirectoryHandle);
      }
    }
  } catch (error) {
    console.warn(
      "folderWalker: failed to enumerate directory",
      directory.name,
      error,
    );
    return;
  }

  const fileResults = await Promise.allSettled(
    fileHandles.map((h) => h.getFile()),
  );
  for (let i = 0; i < fileResults.length; i++) {
    const result = fileResults[i]!;
    if (result.status === "fulfilled") {
      if (isIngestibleFile(result.value.name)) files.push(result.value);
    } else {
      console.warn(
        "folderWalker: failed to read file handle",
        fileHandles[i]?.name ?? "(unknown)",
        result.reason,
      );
    }
  }

  await Promise.allSettled(
    dirHandles.map((h) => walkHandleInto(h, options, files, depth + 1, seenDirs)),
  );
}

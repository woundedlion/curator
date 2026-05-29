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
  // microseconds. Within-level Promise.all preserves bounded memory
  // (we never hold more entries in flight than one level's width).
  const files: File[] = [];
  let level: FsEntry[] = [...roots];

  while (level.length > 0) {
    const fileEntries: FileEntry[] = [];
    const dirEntries: DirectoryEntry[] = [];
    for (const entry of level) {
      if (entry.isFile) fileEntries.push(entry as FileEntry);
      else if (entry.isDirectory) dirEntries.push(entry as DirectoryEntry);
    }

    const fileObjs = await Promise.all(fileEntries.map(readFile));
    for (const file of fileObjs) {
      if (isIngestibleFile(file.name)) files.push(file);
    }

    const childArrays = await Promise.all(dirEntries.map(readDirectory));
    const nextLevel: FsEntry[] = [];
    for (const children of childArrays) {
      if (options.recursive) nextLevel.push(...children);
      else nextLevel.push(...children.filter((c) => c.isFile));
    }
    level = nextLevel;
  }

  return files;
}

export async function walkDirectoryHandle(
  directory: FileSystemDirectoryHandle,
  options: { recursive: boolean },
): Promise<File[]> {
  const files: File[] = [];
  await walkHandleInto(directory, options, files);
  return files;
}

type EntriesCapable = {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
};

async function walkHandleInto(
  directory: FileSystemDirectoryHandle,
  options: { recursive: boolean },
  files: File[],
): Promise<void> {
  // The entries() iterator itself is necessarily serial (the
  // underlying spec doesn't expose a batched read), but every per-entry
  // await — getFile() for files, recursive descent for directories —
  // happens in parallel after collection. On deep trees this turns
  // O(total-entries) sequential awaits into O(tree-depth).
  const fileHandles: FileSystemFileHandle[] = [];
  const dirHandles: FileSystemDirectoryHandle[] = [];
  const iterable = (directory as unknown as EntriesCapable).entries();
  for await (const [, handle] of iterable) {
    if (handle.kind === "file") {
      fileHandles.push(handle as FileSystemFileHandle);
    } else if (handle.kind === "directory" && options.recursive) {
      dirHandles.push(handle as FileSystemDirectoryHandle);
    }
  }

  const filesAtLevel = await Promise.all(fileHandles.map((h) => h.getFile()));
  for (const file of filesAtLevel) {
    if (isIngestibleFile(file.name)) files.push(file);
  }

  await Promise.all(
    dirHandles.map((h) => walkHandleInto(h, options, files)),
  );
}

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
    const entry = items[i].webkitGetAsEntry?.() as FsEntry | null;
    if (entry) roots.push(entry);
  }
  return walkEntries(roots, options);
}

async function walkEntries(
  roots: FsEntry[],
  options: { recursive: boolean },
): Promise<File[]> {
  const files: File[] = [];
  const queue: FsEntry[] = [...roots];

  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (entry.isFile) {
      const fileEntry = entry as FileEntry;
      const file = await readFile(fileEntry);
      if (isIngestibleFile(file.name)) files.push(file);
      continue;
    }
    if (entry.isDirectory) {
      const childEntries = await readDirectory(entry as DirectoryEntry);
      if (options.recursive) {
        queue.push(...childEntries);
      } else {
        const directChildren = childEntries.filter((child) => child.isFile);
        queue.push(...directChildren);
      }
    }
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
  const iterable = (directory as unknown as EntriesCapable).entries();
  for await (const [, handle] of iterable) {
    if (handle.kind === "file") {
      const fileHandle = handle as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      if (isIngestibleFile(file.name)) files.push(file);
    } else if (handle.kind === "directory" && options.recursive) {
      await walkHandleInto(handle as FileSystemDirectoryHandle, options, files);
    }
  }
}

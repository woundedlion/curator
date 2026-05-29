import type { Track } from "../types";
import { dedupeFiles } from "./dedupe";
import {
  isAudioFile,
  isPlaylistFile,
  isTextFile,
} from "./fileExtension";
import { parseAudioFile } from "../metadata/audioParser";
import { parseM3uFile } from "./m3uParser";
import { parseTextFile } from "./textParser";

export type IngestProgress = {
  parsedCount: number;
  totalCount: number;
};

export type IngestOptions = {
  onProgress?: (progress: IngestProgress) => void;
};

export type IngestFailure = { fileName: string; error: unknown };

export type IngestResult = {
  tracks: Track[];
  failures: IngestFailure[];
};

async function parseSingleFile(file: File): Promise<Track[]> {
  if (isAudioFile(file.name)) {
    const track = await parseAudioFile(file);
    return [track];
  }
  if (isPlaylistFile(file.name)) return parseM3uFile(file);
  if (isTextFile(file.name)) return parseTextFile(file);
  return [];
}

export async function ingestFiles(
  files: File[],
  options: IngestOptions = {},
): Promise<IngestResult> {
  const unique = dedupeFiles(files);
  const totalCount = unique.length;
  const tracks: Track[] = [];
  const failures: IngestFailure[] = [];
  let parsedCount = 0;

  // Dispatch every file concurrently so the worker pool runs in parallel —
  // a sequential `for await` here pinned throughput to one worker regardless
  // of pool size. The pool itself bounds parallelism.
  const results = await Promise.allSettled(
    unique.map(async (file) => {
      try {
        return await parseSingleFile(file);
      } finally {
        parsedCount++;
        options.onProgress?.({ parsedCount, totalCount });
      }
    }),
  );
  for (let index = 0; index < results.length; index++) {
    // Bounded iteration over results[] and the parallel unique[]; both
    // arrays are the same length.
    const result = results[index]!;
    const file = unique[index]!;
    if (result.status === "fulfilled") {
      tracks.push(...result.value);
      continue;
    }
    failures.push({ fileName: file.name, error: result.reason });
    console.warn("ingest: failed to parse", file.name, result.reason);
  }
  return { tracks, failures };
}

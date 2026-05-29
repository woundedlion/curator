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
import { ConcurrencyLimiter } from "../spotify/concurrencyLimiter";

// Cap producer-side parallelism. Audio parses are already gated by the
// worker pool (size ≤ 8), but text/m3u parsing reads the whole file
// into memory on the main thread — a 100k-text-file drop would
// otherwise allocate 100k File.text() promises and their backing
// buffers simultaneously. 64 is well above the worker-pool ceiling
// (audio still saturates the pool) and bounds resident memory at
// ~64 concurrent file reads regardless of drop size.
const PIPELINE_MAX_IN_FLIGHT = 64;

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

  // Dispatch through a concurrency limiter so the worker pool runs in
  // parallel — a sequential `for await` pinned throughput to one worker
  // regardless of pool size. The limiter caps producer-side parallelism
  // (the audio path is further gated by the worker pool; the text path
  // is gated only here).
  const limiter = new ConcurrencyLimiter(PIPELINE_MAX_IN_FLIGHT);
  const results = await Promise.allSettled(
    unique.map((file) =>
      limiter.run(async () => {
        try {
          return await parseSingleFile(file);
        } finally {
          parsedCount++;
          options.onProgress?.({ parsedCount, totalCount });
        }
      }),
    ),
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

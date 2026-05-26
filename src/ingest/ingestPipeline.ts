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

  for (let index = 0; index < unique.length; index++) {
    const file = unique[index];
    try {
      const parsed = await parseSingleFile(file);
      tracks.push(...parsed);
    } catch (error) {
      failures.push({ fileName: file.name, error });
      console.warn("ingest: failed to parse", file.name, error);
    }
    options.onProgress?.({ parsedCount: index + 1, totalCount });
  }
  return { tracks, failures };
}

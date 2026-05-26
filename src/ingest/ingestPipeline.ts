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
): Promise<Track[]> {
  const unique = dedupeFiles(files);
  const totalCount = unique.length;
  const allTracks: Track[] = [];

  for (let index = 0; index < unique.length; index++) {
    try {
      const parsed = await parseSingleFile(unique[index]);
      allTracks.push(...parsed);
    } catch {
      // A single bad file should not abort the whole drop; skip it silently.
    }
    options.onProgress?.({ parsedCount: index + 1, totalCount });
  }
  return allTracks;
}

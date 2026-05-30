import { v4 as uuid } from "uuid";
import { ARTIST_TITLE_SEPARATOR } from "../constants";
import type { Track } from "../types";
import { normalizeText, readBlobAsText } from "../util/textNormalize";
import { classifySegments } from "./filenameHeuristic";
import {
  buildTracksFromExport,
  tryParseCuratorExport,
} from "./curatorExportParser";

function isMeaningfulLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith("#");
}

function splitOnSeparator(line: string): string[] {
  return line.split(ARTIST_TITLE_SEPARATOR).map((segment) => segment.trim());
}

function buildTrackFromLine(line: string): Track {
  const segments = splitOnSeparator(line);

  const base: Track = {
    id: uuid(),
    source: { kind: "text", rawLine: line },
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
  };

  // Route through the shared segment classifier (filenameHeuristic.ts) so
  // a text line and a filename carrying the same ` - `-separated string
  // parse identically — including embedded track numbers in 4-segment
  // shapes like "Radiohead - In Rainbows - 03 - Nude". Previously this
  // path duplicated (and diverged from) the heuristic, dropping the
  // track-number detection.
  const hint = classifySegments(segments);
  return {
    ...base,
    artist: hint.artist,
    album: hint.album,
    title: hint.title,
    trackNo: hint.trackNo,
  };
}

export function parseTextContent(text: string): Track[] {
  return normalizeText(text)
    .split("\n")
    .filter(isMeaningfulLine)
    .map(buildTrackFromLine);
}

export async function parseTextFile(file: File): Promise<Track[]> {
  // `readBlobAsText` falls back to Windows-1252 when the file isn't
  // valid UTF-8 (common for Notepad "ANSI" saves). Without that, é/ñ/£
  // came through as U+FFFD replacement chars and matching failed.
  const content = await readBlobAsText(file);
  // A Curator export file is a `.txt` carrying our JSON envelope. Detect
  // it before falling back to line-based parsing so the round-trip preserves
  // Spotify/MB selections instead of treating the JSON as 1 line per token.
  const env = tryParseCuratorExport(content);
  if (env) return buildTracksFromExport(env);
  return parseTextContent(content);
}

import { v4 as uuid } from "uuid";
import { ARTIST_TITLE_SEPARATOR } from "../constants";
import type { Track } from "../types";
import { normalizeText, readBlobAsText } from "../util/textNormalize";
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
  const [first, second, third] = segments;

  const base: Track = {
    id: uuid(),
    source: { kind: "text", rawLine: line },
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
  };

  // 4+ segments: last is the title, second-to-last the artist, and the
  // leading segments collapse into the album — mirroring the filename
  // heuristic's no-track-number fallback (filenameHeuristic.ts) so the
  // same string parses the same way whether it came from a filename or a
  // text list. Previously these lines silently dropped everything past the
  // first segment and mislabeled it as the title.
  if (segments.length >= 4) {
    const title = segments[segments.length - 1];
    const artist = segments[segments.length - 2];
    const album = segments
      .slice(0, segments.length - 2)
      .join(ARTIST_TITLE_SEPARATOR);
    return { ...base, artist, album: album || undefined, title };
  }
  if (segments.length === 3) {
    return { ...base, artist: first, album: second, title: third };
  }
  if (segments.length === 2) {
    return { ...base, artist: first, title: second };
  }
  return { ...base, title: first };
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

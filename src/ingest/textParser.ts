import { v4 as uuid } from "uuid";
import { ARTIST_TITLE_SEPARATOR } from "../constants";
import type { Track } from "../types";
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

  if (segments.length === 3) {
    return { ...base, artist: first, album: second, title: third };
  }
  if (segments.length === 2) {
    return { ...base, artist: first, title: second };
  }
  return { ...base, title: first };
}

function stripBom(text: string): string {
  // Notepad on Windows saves UTF-8 with a leading BOM (U+FEFF). Without
  // stripping, the first track's artist becomes `"<U+FEFF>Artist"` which
  // breaks all downstream matching.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseTextContent(text: string): Track[] {
  // Normalize CRLF (Windows) and lone CR (classic Mac) into LF.
  // Existing LFs are untouched.
  const normalized = stripBom(text).replace(/\r\n|\r/g, "\n");
  return normalized.split("\n").filter(isMeaningfulLine).map(buildTrackFromLine);
}

export async function parseTextFile(file: File): Promise<Track[]> {
  const content = await file.text();
  // A Curator export file is a `.txt` carrying our JSON envelope. Detect
  // it before falling back to line-based parsing so the round-trip preserves
  // Spotify/MB selections instead of treating the JSON as 1 line per token.
  const env = tryParseCuratorExport(content);
  if (env) return buildTracksFromExport(env);
  return parseTextContent(content);
}

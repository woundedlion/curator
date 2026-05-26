import { v4 as uuid } from "uuid";
import type { Track } from "../types";

const ARTIST_TITLE_SEPARATOR = " - ";

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

export function parseTextContent(text: string): Track[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  return normalized.split("\n").filter(isMeaningfulLine).map(buildTrackFromLine);
}

export async function parseTextFile(file: File): Promise<Track[]> {
  const content = await file.text();
  return parseTextContent(content);
}

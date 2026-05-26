import { v4 as uuid } from "uuid";
import { ARTIST_TITLE_SEPARATOR } from "../constants";
import type { Track } from "../types";

const EXTINF_PREFIX = "#EXTINF:";

type ExtInfHint = { artist?: string; title?: string };

function parseExtInfLine(line: string): ExtInfHint {
  const commaIndex = line.indexOf(",");
  if (commaIndex === -1) return {};
  const after = line.slice(commaIndex + 1).trim();
  if (after.length === 0) return {};
  const segments = after
    .split(ARTIST_TITLE_SEPARATOR)
    .map((segment) => segment.trim());
  if (segments.length >= 2) {
    return {
      artist: segments[0],
      title: segments.slice(1).join(ARTIST_TITLE_SEPARATOR),
    };
  }
  return { title: after };
}

function buildTrack(rawLine: string, hint: ExtInfHint): Track {
  return {
    id: uuid(),
    source: { kind: "m3u", rawLine },
    artist: hint.artist,
    title: hint.title,
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
  };
}

export function parseM3uContent(text: string): Track[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const tracks: Track[] = [];
  let pendingHint: ExtInfHint = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (trimmed.startsWith(EXTINF_PREFIX)) {
      pendingHint = parseExtInfLine(trimmed);
      continue;
    }
    if (trimmed.startsWith("#")) continue;

    tracks.push(buildTrack(trimmed, pendingHint));
    pendingHint = {};
  }
  return tracks;
}

export async function parseM3uFile(file: File): Promise<Track[]> {
  const content = await file.text();
  return parseM3uContent(content);
}

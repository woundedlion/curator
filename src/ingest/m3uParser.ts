import { v4 as uuid } from "uuid";
import { ARTIST_TITLE_SEPARATOR } from "../constants";
import type { Track } from "../types";
import { normalizeText, readBlobAsText } from "../util/textNormalize";

const EXTINF_PREFIX = "#EXTINF:";

type ExtInfHint = { artist?: string; title?: string; durationMs?: number };

function parseExtInfLine(line: string): ExtInfHint {
  // `#EXTINF:<seconds>,<artist - title>` per the EXTM3U convention.
  // Strip the `#EXTINF:` prefix first so the comma split is
  // unambiguous between the duration and the metadata tail. Seconds
  // may be `-1` (unknown), integer, or float; any non-finite or
  // non-positive value is treated as missing.
  const payload = line.startsWith(EXTINF_PREFIX)
    ? line.slice(EXTINF_PREFIX.length)
    : line;
  const commaIndex = payload.indexOf(",");
  if (commaIndex === -1) return {};
  const seconds = Number.parseFloat(payload.slice(0, commaIndex).trim());
  const durationMs =
    Number.isFinite(seconds) && seconds > 0
      ? Math.round(seconds * 1000)
      : undefined;

  const after = payload.slice(commaIndex + 1).trim();
  if (after.length === 0) return durationMs !== undefined ? { durationMs } : {};
  const segments = after
    .split(ARTIST_TITLE_SEPARATOR)
    .map((segment) => segment.trim());
  if (segments.length >= 2) {
    // Defense-in-depth: coerce empty segments to undefined rather than
    // letting `""` through as a real blank field (a blank title/artist
    // would suppress the downstream blank-fallthrough and feed an empty
    // string to the matchers). The leading `.trim()` on `after` makes an
    // empty segment unreachable today, but this keeps the contract intact
    // if the separator handling ever changes.
    return {
      artist: segments[0] || undefined,
      title: segments.slice(1).join(ARTIST_TITLE_SEPARATOR) || undefined,
      durationMs,
    };
  }
  return { title: after, durationMs };
}

function buildTrack(rawLine: string, hint: ExtInfHint): Track {
  return {
    id: uuid(),
    source: { kind: "m3u", rawLine },
    artist: hint.artist,
    title: hint.title,
    durationMs: hint.durationMs,
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
  };
}

export function parseM3uContent(text: string): Track[] {
  // VLC/iTunes export .m3u8 with a UTF-8 BOM. Without stripping, the
  // `#EXTM3U` header becomes `<U+FEFF>#EXTM3U` (still ignorable as a
  // comment), but more importantly a BOM-prefixed file's first non-
  // comment line lands prepended with U+FEFF in `rawLine`.
  const lines = normalizeText(text).split("\n");
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
  // `.m3u` (non-`.m3u8`) is conventionally Latin-1/Windows-1252 — the
  // `8` in `.m3u8` is the legacy spec's marker for "UTF-8 encoded."
  // `readBlobAsText` tries strict UTF-8 first (handles `.m3u8` and any
  // ASCII-safe `.m3u`) and falls back to Windows-1252 on decode
  // failure, which covers VLC/iTunes-exported playlists that still
  // carry Latin-1 accented characters.
  const content = await readBlobAsText(file);
  return parseM3uContent(content);
}

import { v4 as uuid } from "uuid";
import { ARTIST_TITLE_SEPARATOR } from "../constants";
import type { Track } from "../types";
import { classifySegments, deriveHintsFromFileName } from "./filenameHeuristic";
import { normalizeText, readBlobAsText } from "../util/textNormalize";

const EXTINF_PREFIX = "#EXTINF:";

type ExtInfHint = {
  artist?: string;
  title?: string;
  album?: string;
  trackNo?: number;
  durationMs?: number;
};

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
  // Route the metadata tail through the same `classifySegments` source of
  // truth that the filename heuristic and text-line parser use, so a
  // `<artist> - <album> - <track#> - <title>` EXTINF tail parses
  // identically to the same string arriving as a filename instead of
  // collapsing everything after the first separator into the title (which
  // silently dropped the album and any embedded track number).
  const segments = after
    .split(ARTIST_TITLE_SEPARATOR)
    .map((segment) => segment.trim());
  const hint = classifySegments(segments);
  return {
    // Coerce empty fields to undefined rather than letting `""` through as
    // a real blank field (a blank title/artist would suppress the
    // downstream blank-fallthrough and feed an empty string to the
    // matchers).
    artist: hint.artist || undefined,
    title: hint.title || undefined,
    album: hint.album || undefined,
    trackNo: hint.trackNo,
    durationMs,
  };
}

function deriveHintFromPathLine(line: string): ExtInfHint {
  // A standard `.m3u` body line is a file path or URL, not "Artist - Title".
  // Reduce it to a basename (strip any URL query/fragment, take the last
  // `/`- or `\`-separated segment, percent-decode best-effort) and route it
  // through the same filename heuristic the dropped-files path uses, so a
  // plain path-list m3u (no `#EXTINF`) yields usable metadata instead of
  // empty, unmatchable rows.
  const withoutQuery = line.split(/[?#]/, 1)[0] ?? line;
  const segments = withoutQuery.split(/[\\/]/);
  const base = segments[segments.length - 1] ?? withoutQuery;
  let decoded = base;
  try {
    decoded = decodeURIComponent(base);
  } catch {
    // Malformed percent-encoding: fall back to the raw basename.
  }
  return deriveHintsFromFileName(decoded.trim());
}

function buildTrack(rawLine: string, hint: ExtInfHint): Track {
  // `#EXTINF` metadata wins; the path basename only fills fields it left
  // blank. A bare path-list line arrives with an empty `hint` and is fully
  // derived from the path.
  const pathHint =
    hint.artist || hint.title ? {} : deriveHintFromPathLine(rawLine);
  return {
    id: uuid(),
    source: { kind: "m3u", rawLine },
    artist: hint.artist ?? pathHint.artist,
    title: hint.title ?? pathHint.title,
    album: hint.album ?? pathHint.album,
    trackNo: hint.trackNo ?? pathHint.trackNo,
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

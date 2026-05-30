import { v4 as uuid } from "uuid";
import { ARTIST_TITLE_SEPARATOR } from "../constants";
import type { Track } from "../types";
import {
  CURATOR_EXPORT_FORMAT,
  type CuratorExportEnvelope,
  type CuratorExportedTrack,
} from "./curatorExportFormat";

// Only scan the leading window of the file for the marker. A genuine
// export is a JSON object whose `"format"` field sits near the top, so
// the marker always appears within the first few hundred bytes. A
// previous `text.includes(...)` scanned the ENTIRE file: a large plain
// `.txt` whose body happened to contain the literal marker string would
// pass the pre-check and force a full `JSON.parse` of the whole file
// (which then fails). Bounding both the substring scan AND requiring a
// JSON-object shape (trimmed start `{`) keeps the cheap reject cheap.
const MARKER_SCAN_WINDOW = 1024;

function looksLikeCuratorExport(text: string): boolean {
  // A curator export is always a JSON object; if it doesn't start with
  // `{` it can't be one, so we never parse it.
  if (text.trimStart()[0] !== "{") return false;
  return text.slice(0, MARKER_SCAN_WINDOW).includes(CURATOR_EXPORT_FORMAT);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// Export files are user-editable plain text, so the resolved ids are
// untrusted input. A row only gets restored to `matched` (bypassing the
// search/enrichment score gate) when its id is well-formed, so a hand-
// edited or hostile file can't smuggle an arbitrary string into
// `spotify.uri` (which is later pushed to the Spotify API) or into the
// MB recording id. A malformed id is dropped → the row comes back `idle`
// and re-runs the normal resolution flow.
const SPOTIFY_TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]{22}$/;
const MB_RECORDING_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function asSpotifyTrackUri(value: unknown): string | undefined {
  const s = asString(value);
  return s && SPOTIFY_TRACK_URI_RE.test(s) ? s : undefined;
}
function asMbRecordingId(value: unknown): string | undefined {
  const s = asString(value);
  return s && MB_RECORDING_ID_RE.test(s) ? s : undefined;
}

// Reconstruct a faithful source line for a round-tripped row. Exports
// don't carry the original `rawLine`, so we synthesize the canonical
// "Artist - Title" form (the same separator the text-list parser uses)
// when both are present, falling back to whichever single field exists.
function reconstructRawLine(t: CuratorExportedTrack): string {
  if (t.artist && t.title) {
    return `${t.artist}${ARTIST_TITLE_SEPARATOR}${t.title}`;
  }
  return t.title ?? t.artist ?? "";
}

function readTrack(raw: unknown): CuratorExportedTrack | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return {
    title: asString(obj.title),
    artist: asString(obj.artist),
    album: asString(obj.album),
    albumArtist: asString(obj.albumArtist),
    year: asNumber(obj.year),
    originalYear: asNumber(obj.originalYear),
    trackNo: asNumber(obj.trackNo),
    trackOf: asNumber(obj.trackOf),
    discNo: asNumber(obj.discNo),
    durationMs: asNumber(obj.durationMs),
    coverUrl: asString(obj.coverUrl),
    spotifyUri: asSpotifyTrackUri(obj.spotifyUri),
    mbRecordingId: asMbRecordingId(obj.mbRecordingId),
  };
}

export function tryParseCuratorExport(
  text: string,
): CuratorExportEnvelope | null {
  if (!looksLikeCuratorExport(text)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== CURATOR_EXPORT_FORMAT) return null;
  if (!Array.isArray(obj.tracks)) return null;
  const tracks: CuratorExportedTrack[] = [];
  for (const raw of obj.tracks) {
    const t = readTrack(raw);
    if (t) tracks.push(t);
  }
  return {
    format: CURATOR_EXPORT_FORMAT,
    name: asString(obj.name) ?? "",
    description: asString(obj.description),
    public: asBool(obj.public),
    collaborative: asBool(obj.collaborative),
    tracks,
  };
}

// Map an exported track into the runtime Track shape. Selected Spotify /
// MusicBrainz ids land in `matched` state so the existing runners skip
// them (they only touch idle/pending rows) — round-trip is instant and
// burns no API quota.
export function buildTrackFromExport(t: CuratorExportedTrack): Track {
  return {
    id: uuid(),
    source: {
      kind: "text",
      rawLine: reconstructRawLine(t),
    },
    title: t.title,
    artist: t.artist,
    album: t.album,
    albumArtist: t.albumArtist,
    year: t.year,
    originalYear: t.originalYear,
    trackNo: t.trackNo,
    trackOf: t.trackOf,
    discNo: t.discNo,
    durationMs: t.durationMs,
    coverUrl: t.coverUrl,
    // Round-tripped rows are restored as `matched` by user decision.
    // We don't carry the original score or the full candidate set
    // through the export (intentional — the file would be massive);
    // synthesize a sentinel score of 1 and an empty candidate list so
    // the discriminated union's `matched` shape is satisfied.
    enrichment: t.mbRecordingId
      ? {
          status: "matched",
          mbRecordingId: t.mbRecordingId,
          score: 1,
        }
      : { status: "idle" },
    spotify: t.spotifyUri
      ? {
          status: "matched",
          uri: t.spotifyUri,
          candidates: [],
          score: 1,
        }
      : { status: "idle" },
  };
}

export function buildTracksFromExport(env: CuratorExportEnvelope): Track[] {
  return env.tracks.map(buildTrackFromExport);
}

// Counts surfaced in the import toast so the user can see at a glance how
// much of the round-trip's resolved state came back.
export type CuratorImportStats = {
  total: number;
  spotifyMatched: number;
  mbMatched: number;
};

export function countResolved(env: CuratorExportEnvelope): CuratorImportStats {
  let spotifyMatched = 0;
  let mbMatched = 0;
  for (const t of env.tracks) {
    if (t.spotifyUri) spotifyMatched++;
    if (t.mbRecordingId) mbMatched++;
  }
  return { total: env.tracks.length, spotifyMatched, mbMatched };
}

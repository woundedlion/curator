import { v4 as uuid } from "uuid";
import type { Track } from "../types";
import {
  CURATOR_EXPORT_FORMAT,
  type CuratorExportEnvelope,
  type CuratorExportedTrack,
} from "./curatorExportFormat";

// Cheap pre-check to avoid running JSON.parse on every plain text drop.
// The format marker appears in any valid export (in the "format" field).
function looksLikeCuratorExport(text: string): boolean {
  return text.includes(CURATOR_EXPORT_FORMAT);
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
    spotifyUri: asString(obj.spotifyUri),
    mbRecordingId: asString(obj.mbRecordingId),
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
      rawLine: t.title ?? t.artist ?? "",
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
    enrichment: t.mbRecordingId
      ? { status: "matched", mbRecordingId: t.mbRecordingId }
      : { status: "idle" },
    spotify: t.spotifyUri
      ? { status: "matched", uri: t.spotifyUri }
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

import { v4 as uuid } from "uuid";
import type { Track } from "../types";
import { deriveHintsFromFileName } from "../ingest/filenameHeuristic";
import { parseAudioInPool } from "../workers/audioParserPool";
import type { ParsedFields } from "../workers/audioParser.worker";

type IdentifyingFields = { title?: string; artist?: string };

function blankToUndefined(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

// Numeric guards mirroring the worker's (audioParser.worker.ts). The
// worker already sanitizes these before they cross the wire; we repeat
// the validation here so the two code paths stay consistent and so the
// Track is protected even if a future caller feeds unsanitized
// ParsedFields straight into buildTrackFromParsed.
function sanePosition(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function saneYear(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < 1860 || value > 2200) return undefined;
  return value;
}

function saneDuration(value: number | undefined): number | undefined {
  // The worker already drops NaN/Infinity/negative durations, but repeat
  // the guard here so a direct buildTrackFromParsed caller can't leak a
  // junk duration into the Track (matches the worker's durationToMs).
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return value;
}

function pickArtistFromParsed(fields: ParsedFields): string | undefined {
  return blankToUndefined(fields.artist) ?? blankToUndefined(fields.albumartist);
}

function caseFoldedEquals(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function altQueryIfDifferent(
  primary: IdentifyingFields,
  filenameDerived: IdentifyingFields,
): IdentifyingFields | undefined {
  const titleMismatch = !caseFoldedEquals(primary.title, filenameDerived.title);
  const artistMismatch = !caseFoldedEquals(primary.artist, filenameDerived.artist);
  if (!titleMismatch && !artistMismatch) return undefined;
  const alt: IdentifyingFields = {};
  if (filenameDerived.title) alt.title = filenameDerived.title;
  if (filenameDerived.artist) alt.artist = filenameDerived.artist;
  if (!alt.title && !alt.artist) return undefined;
  return alt;
}

function buildTrackFromParsed(
  file: File,
  parsed: ParsedFields,
  filenameHint: ReturnType<typeof deriveHintsFromFileName>,
): Track {
  const id3Title = blankToUndefined(parsed.title);
  const id3Artist = pickArtistFromParsed(parsed);
  const id3Album = blankToUndefined(parsed.album);
  const id3AlbumArtist = blankToUndefined(parsed.albumartist);
  const primaryTitle = id3Title ?? filenameHint.title;
  const primaryArtist = id3Artist ?? filenameHint.artist;
  const altQuery = altQueryIfDifferent(
    { title: primaryTitle, artist: primaryArtist },
    { title: filenameHint.title, artist: filenameHint.artist },
  );
  return {
    id: uuid(),
    source: { kind: "file", fileName: file.name },
    title: primaryTitle,
    artist: primaryArtist,
    album: id3Album ?? filenameHint.album,
    albumArtist: id3AlbumArtist,
    year: saneYear(parsed.year),
    trackNo: sanePosition(parsed.trackNo) ?? filenameHint.trackNo,
    trackOf: sanePosition(parsed.trackOf),
    discNo: sanePosition(parsed.discNo),
    durationMs: saneDuration(parsed.durationMs),
    localFile: file,
    altQuery,
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
  };
}

function buildTrackFromFilenameOnly(
  file: File,
  filenameHint: ReturnType<typeof deriveHintsFromFileName>,
): Track {
  return {
    id: uuid(),
    source: { kind: "file", fileName: file.name },
    title: filenameHint.title,
    artist: filenameHint.artist,
    album: filenameHint.album,
    trackNo: filenameHint.trackNo,
    localFile: file,
    enrichment: { status: "idle" },
    spotify: { status: "idle" },
  };
}

export async function parseAudioFile(file: File): Promise<Track> {
  const filenameHint = deriveHintsFromFileName(file.name);
  try {
    const parsed = await parseAudioInPool(file);
    return buildTrackFromParsed(file, parsed, filenameHint);
  } catch (error) {
    // ID3/container parse failure is a real signal — file may be corrupt
    // or a format `music-metadata` doesn't cover. We still fall back to
    // filename-only so the row isn't dropped, but the error needs to
    // surface (DESIGN §4.1) so a user can diagnose the row.
    console.warn("audioParser: ID3 parse failed", file.name, error);
    return buildTrackFromFilenameOnly(file, filenameHint);
  }
}

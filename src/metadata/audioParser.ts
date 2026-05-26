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
    year: parsed.year,
    trackNo: parsed.trackNo ?? filenameHint.trackNo,
    trackOf: parsed.trackOf,
    discNo: parsed.discNo,
    durationMs: parsed.durationMs,
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

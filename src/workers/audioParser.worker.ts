import { parseBlob } from "music-metadata";

type ParseRequest = { id: number; file: File };

type ParsedFields = {
  title?: string;
  artist?: string;
  albumartist?: string;
  album?: string;
  year?: number;
  trackNo?: number;
  trackOf?: number;
  discNo?: number;
  durationMs?: number;
};

type ParseResponse =
  | { id: number; ok: true; fields: ParsedFields }
  | { id: number; ok: false; error: string };

function durationToMs(durationSec: number | undefined): number | undefined {
  if (typeof durationSec !== "number") return undefined;
  return Math.round(durationSec * 1000);
}

// Malformed ID3/Vorbis tags routinely carry junk numbers (year "0",
// track "-1", disc NaN, year 99999 from a corrupt frame). music-metadata
// surfaces them verbatim, so we apply the same kind of light validation
// filenameHeuristic uses for parsed positions: coerce anything that
// isn't a sane, in-range value to undefined rather than letting it
// poison the Track. Kept in sync with the equivalent guards in
// metadata/audioParser.ts (the non-worker fallback consumer).
function sanePosition(value: unknown): number | undefined {
  // track/disc numbers: must be a finite positive integer.
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function saneYear(value: unknown): number | undefined {
  // A plausible release year. The lower bound predates recorded music;
  // the upper bound gives generous slack past "now" for mis-tagged or
  // future-dated promo releases without admitting 5-digit garbage.
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < 1860 || value > 2200) return undefined;
  return value;
}

async function parseOne(file: File): Promise<ParsedFields> {
  const result = await parseBlob(file, { duration: true });
  const { common, format } = result;
  return {
    title: common.title,
    artist: common.artist,
    albumartist: common.albumartist,
    album: common.album,
    year: saneYear(common.year),
    trackNo: sanePosition(common.track?.no),
    trackOf: sanePosition(common.track?.of),
    discNo: sanePosition(common.disk?.no),
    durationMs: durationToMs(format.duration),
  };
}

self.addEventListener("message", async (event: MessageEvent<ParseRequest>) => {
  const { id, file } = event.data;
  try {
    const fields = await parseOne(file);
    const response: ParseResponse = { id, ok: true, fields };
    (self as unknown as Worker).postMessage(response);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown parse error";
    const response: ParseResponse = { id, ok: false, error: message };
    (self as unknown as Worker).postMessage(response);
  }
});

export type { ParseRequest, ParseResponse, ParsedFields };

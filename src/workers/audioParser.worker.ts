import { parseBlob } from "music-metadata";

type ParseRequest = { id: number; file: File };

type ParsedFields = {
  title?: string;
  artist?: string;
  albumartist?: string;
  album?: string;
  year?: number;
  originalYear?: number;
  trackNo?: number;
  trackOf?: number;
  discNo?: number;
  durationMs?: number;
};

type ParseResponse =
  | { id: number; ok: true; fields: ParsedFields }
  | { id: number; ok: false; error: string };

export function durationToMs(
  durationSec: number | undefined,
): number | undefined {
  // music-metadata can surface a NaN or Infinity duration for some
  // containers/streams. `typeof NaN === "number"`, so a bare type check
  // would let it through and poison Track.durationMs (sort/scoring/UI).
  // Require a finite, non-negative value.
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec)) {
    return undefined;
  }
  if (durationSec < 0) return undefined;
  return Math.round(durationSec * 1000);
}

// Malformed ID3/Vorbis tags routinely carry junk numbers (year "0",
// track "-1", disc NaN, year 99999 from a corrupt frame). music-metadata
// surfaces them verbatim, so we apply the same kind of light validation
// filenameHeuristic uses for parsed positions: coerce anything that
// isn't a sane, in-range value to undefined rather than letting it
// poison the Track. Kept in sync with the equivalent guards in
// metadata/audioParser.ts (the non-worker fallback consumer).
export function sanePosition(value: unknown): number | undefined {
  // track/disc numbers: must be a finite positive integer.
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

export function saneYear(value: unknown): number | undefined {
  // A plausible release year. The lower bound predates recorded music;
  // the upper bound gives generous slack past "now" for mis-tagged or
  // future-dated promo releases without admitting 5-digit garbage.
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < 1860 || value > 2200) return undefined;
  return value;
}

// music-metadata exposes the original release year via `common.originalyear`
// and, on some tag dialects, only as the leading year of `common.originaldate`
// ("1997-06-16"). Prefer the dedicated numeric field; otherwise fall back to
// parsing the leading 4-digit year out of originaldate. Both are run through
// saneYear so a corrupt frame can't poison Track.originalYear.
export function saneOriginalYear(
  originalyear: unknown,
  originaldate: unknown,
): number | undefined {
  const fromYear = saneYear(originalyear);
  if (fromYear !== undefined) return fromYear;
  if (typeof originaldate === "string") {
    const match = originaldate.match(/^\s*(\d{4})/);
    if (match) return saneYear(parseInt(match[1]!, 10));
  }
  return undefined;
}

async function parseOne(file: File): Promise<ParsedFields> {
  // skipCovers: music-metadata otherwise decodes embedded cover-art frames
  // (frequently multi-MB JPEGs) into common.picture, which this parser never
  // reads. Skipping the decode avoids wasting memory/CPU across the worker
  // pool when a large library is dropped in.
  const result = await parseBlob(file, { duration: true, skipCovers: true });
  const { common, format } = result;
  return {
    title: common.title,
    artist: common.artist,
    albumartist: common.albumartist,
    album: common.album,
    year: saneYear(common.year),
    originalYear: saneOriginalYear(common.originalyear, common.originaldate),
    trackNo: sanePosition(common.track?.no),
    trackOf: sanePosition(common.track?.of),
    discNo: sanePosition(common.disk?.no),
    durationMs: durationToMs(format.duration),
  };
}

// Guard the top-level worker wiring behind a typeof check. In a real
// Worker context `self` is the WorkerGlobalScope and this registers the
// message handler exactly as before. Under the node/happy-dom test env
// there is no worker `self.addEventListener`, so importing this module
// to unit-test the pure helpers above would otherwise throw at load
// time. The guard makes the module importable in tests WITHOUT changing
// runtime behavior in an actual worker.
if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener(
    "message",
    async (event: MessageEvent<ParseRequest>) => {
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
    },
  );
}

export type { ParseRequest, ParseResponse, ParsedFields };

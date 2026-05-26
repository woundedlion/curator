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

async function parseOne(file: File): Promise<ParsedFields> {
  const result = await parseBlob(file, { duration: true });
  const { common, format } = result;
  return {
    title: common.title,
    artist: common.artist,
    albumartist: common.albumartist,
    album: common.album,
    year: typeof common.year === "number" ? common.year : undefined,
    trackNo: common.track?.no ?? undefined,
    trackOf: common.track?.of ?? undefined,
    discNo: common.disk?.no ?? undefined,
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

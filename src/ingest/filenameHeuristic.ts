import { ARTIST_TITLE_SEPARATOR } from "../constants";

export type FilenameHint = {
  artist?: string;
  album?: string;
  trackNo?: number;
  title?: string;
};

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? fileName : fileName.slice(0, dot);
}

// A "track number" is at most 3 digits (the segment regex below) AND at
// most this value. The *value* guard — not the digit count — is what
// rejects years: 4-digit numbers like 1999/2017 fail the regex anyway,
// but the real protection is `<= 199`, which also rejects 3-digit values
// (200+) that are too large to be plausible album positions. A 3-digit
// number <= 199 (e.g. "007", "150") IS accepted as a track number.
// We'd rather under-classify a large number as a leading title than
// treat a year or catalog number embedded in a filename as a track
// position.
const MAX_TRACK_NUMBER = 199;

function isValidTrackNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_TRACK_NUMBER;
}

function parseTrackNumberSegment(segment: string): number | undefined {
  const trimmed = segment.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return undefined;
  const value = parseInt(trimmed, 10);
  return isValidTrackNumber(value) ? value : undefined;
}

function parseLeadingTrackNumber(segment: string): {
  trackNo?: number;
  remainder: string;
} {
  const match = segment.match(/^\s*(\d{1,3})\s*[-.\s]\s*(.*)$/);
  if (!match) return { remainder: segment };
  const value = parseInt(match[1]!, 10);
  if (!isValidTrackNumber(value)) return { remainder: segment };
  return { trackNo: value, remainder: match[2]! };
}

function hintFromTwoSegments(segments: string[]): FilenameHint {
  // Callers route here only when segments.length === 2, so first/second
  // are guaranteed defined.
  const first = segments[0]!;
  const second = segments[1]!;
  const trackOnly = parseTrackNumberSegment(first);
  if (trackOnly !== undefined) {
    return { trackNo: trackOnly, title: second };
  }
  const { trackNo, remainder } = parseLeadingTrackNumber(first);
  if (trackNo !== undefined) {
    return { trackNo, title: second, artist: remainder || undefined };
  }
  return { artist: first, title: second };
}

function hintFromThreeSegments(segments: string[]): FilenameHint {
  const first = segments[0]!;
  const second = segments[1]!;
  const third = segments[2]!;
  const trackOnly = parseTrackNumberSegment(first);
  if (trackOnly !== undefined) {
    return { trackNo: trackOnly, artist: second, title: third };
  }
  const { trackNo, remainder } = parseLeadingTrackNumber(first);
  if (trackNo !== undefined) {
    return { trackNo, artist: remainder, title: third, album: second };
  }
  return { artist: first, album: second, title: third };
}

function hintFromFourOrMoreSegments(segments: string[]): FilenameHint {
  // Two common 4-segment ripper conventions:
  //   A) `Artist - Album - 03 - Title`   (track number at index -2)
  //   B) `Album - 15 - Artist - Title`   (track number at index -3)
  // Detect by looking for a track-number-looking segment. Without this
  // shape detection, "Radiohead - In Rainbows - 03 - Nude" parses as
  // `album="Radiohead - In Rainbows", artist="03", title="Nude"`.
  // Caller guarantees segments.length >= 4.
  const title = segments[segments.length - 1]!;

  const trackNoAtMinus2 = parseTrackNumberSegment(
    segments[segments.length - 2]!,
  );
  if (trackNoAtMinus2 !== undefined) {
    // Pattern A: …Artist… - Album - Track# - Title.
    // Treat segment[-3] alone as album, everything before as artist.
    const head = segments.slice(0, segments.length - 2);
    return {
      trackNo: trackNoAtMinus2,
      title,
      artist: head.slice(0, -1).join(ARTIST_TITLE_SEPARATOR) || undefined,
      album: head[head.length - 1],
    };
  }

  const trackNoAtMinus3 = parseTrackNumberSegment(
    segments[segments.length - 3]!,
  );
  if (trackNoAtMinus3 !== undefined) {
    // Pattern B: …Album… - Track# - Artist - Title.
    const albumSegments = segments.slice(0, segments.length - 3);
    return {
      trackNo: trackNoAtMinus3,
      title,
      artist: segments[segments.length - 2]!,
      album:
        albumSegments.length > 0
          ? albumSegments.join(ARTIST_TITLE_SEPARATOR)
          : undefined,
    };
  }

  // No track number found — fall back to `[…album] - artist - title`.
  const artist = segments[segments.length - 2]!;
  const albumSegments = segments.slice(0, segments.length - 2);
  return {
    title,
    artist,
    album:
      albumSegments.length > 0
        ? albumSegments.join(ARTIST_TITLE_SEPARATOR)
        : undefined,
  };
}

function hintFromSingleSegment(segment: string): FilenameHint {
  const { trackNo, remainder } = parseLeadingTrackNumber(segment);
  if (trackNo !== undefined) return { trackNo, title: remainder };
  return { title: segment };
}

// The single source of truth for turning a list of ` - `-separated
// segments into artist/album/trackNo/title. Both the filename heuristic
// and the text-line parser (ingest/textParser.ts) route through this so
// the same string parses identically regardless of whether it arrived as
// a filename or a line in a text list — including the 4-segment
// track-number detection (e.g. "Radiohead - In Rainbows - 03 - Nude").
export function classifySegments(segments: string[]): FilenameHint {
  if (segments.length >= 4) return hintFromFourOrMoreSegments(segments);
  if (segments.length === 3) return hintFromThreeSegments(segments);
  if (segments.length === 2) return hintFromTwoSegments(segments);
  return hintFromSingleSegment(segments[0] ?? "");
}

export function deriveHintsFromFileName(fileName: string): FilenameHint {
  const base = stripExtension(fileName);
  const segments = base
    .split(ARTIST_TITLE_SEPARATOR)
    .map((segment) => segment.trim());
  return classifySegments(segments);
}

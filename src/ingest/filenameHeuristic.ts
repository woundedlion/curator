import { ARTIST_TITLE_SEPARATOR } from "../constants";

type FilenameHint = {
  artist?: string;
  album?: string;
  trackNo?: number;
  title?: string;
};

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? fileName : fileName.slice(0, dot);
}

function parseTrackNumberSegment(segment: string): number | undefined {
  const trimmed = segment.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return undefined;
  return parseInt(trimmed, 10);
}

function parseLeadingTrackNumber(segment: string): {
  trackNo?: number;
  remainder: string;
} {
  const match = segment.match(/^\s*(\d{1,3})\s*[-.\s]\s*(.*)$/);
  if (!match) return { remainder: segment };
  return { trackNo: parseInt(match[1], 10), remainder: match[2] };
}

function hintFromTwoSegments(segments: string[]): FilenameHint {
  const [first, second] = segments;
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
  const [first, second, third] = segments;
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
  const title = segments[segments.length - 1];
  const artist = segments[segments.length - 2];
  const possibleTrackNo = parseTrackNumberSegment(segments[segments.length - 3]);
  if (possibleTrackNo !== undefined) {
    const albumSegments = segments.slice(0, segments.length - 3);
    return {
      trackNo: possibleTrackNo,
      title,
      artist,
      album:
        albumSegments.length > 0
          ? albumSegments.join(ARTIST_TITLE_SEPARATOR)
          : undefined,
    };
  }
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

function hintFromSingleSegment(base: string): FilenameHint {
  const { trackNo, remainder } = parseLeadingTrackNumber(base);
  if (trackNo !== undefined) return { trackNo, title: remainder };
  return { title: base };
}

export function deriveHintsFromFileName(fileName: string): FilenameHint {
  const base = stripExtension(fileName);
  const segments = base
    .split(ARTIST_TITLE_SEPARATOR)
    .map((segment) => segment.trim());

  if (segments.length >= 4) return hintFromFourOrMoreSegments(segments);
  if (segments.length === 3) return hintFromThreeSegments(segments);
  if (segments.length === 2) return hintFromTwoSegments(segments);
  return hintFromSingleSegment(base);
}

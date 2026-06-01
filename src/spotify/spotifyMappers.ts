import { v4 as uuid } from "uuid";
import type {
  SpotifyCandidate,
  SpotifyPlaylistSummary,
  Track,
} from "../types";
import type {
  SpotifyImage,
  SpotifyPlaylistResponse,
  SpotifyTrackResponse,
} from "./dtos";

function pickSmallestImage(images?: SpotifyImage[]): string | undefined {
  if (!images || images.length === 0) return undefined;
  return [...images].sort(
    (a, b) => (a.width ?? Infinity) - (b.width ?? Infinity),
  )[0]?.url;
}

function combineArtistNames(track: SpotifyTrackResponse): string {
  const artists = track.artists ?? [];
  return artists.map((artist) => artist?.name ?? "").filter(Boolean).join(", ");
}

function parseReleaseYear(date?: string): number | undefined {
  if (!date) return undefined;
  const year = parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : undefined;
}

export function toSpotifyCandidate(track: SpotifyTrackResponse): SpotifyCandidate {
  return {
    uri: track.uri,
    id: track.id,
    title: track.name,
    artist: combineArtistNames(track),
    album: track.album?.name,
    year: parseReleaseYear(track.album?.release_date),
    durationMs: track.duration_ms,
    previewUrl: track.preview_url ?? undefined,
    coverUrl: pickSmallestImage(track.album?.images),
    score: 0,
  };
}

function readItemCount(
  playlist: SpotifyPlaylistResponse,
): number | undefined {
  const fromItems = playlist.items?.total;
  if (typeof fromItems === "number") return fromItems;
  const fromTracks = playlist.tracks?.total;
  if (typeof fromTracks === "number") return fromTracks;
  return undefined;
}

export function toPlaylistSummary(
  playlist: SpotifyPlaylistResponse,
): SpotifyPlaylistSummary {
  return {
    id: playlist.id,
    name: playlist.name ?? "(untitled)",
    trackCount: readItemCount(playlist),
    ownerId: playlist.owner?.id ?? "",
    ownerDisplayName: playlist.owner?.display_name,
    coverUrl: pickSmallestImage(playlist.images),
  };
}

export function isMappablePlaylist(
  playlist: SpotifyPlaylistResponse | null | undefined,
): playlist is SpotifyPlaylistResponse {
  return Boolean(playlist && playlist.id && playlist.name);
}

export function toImportedTrack(item: SpotifyTrackResponse): Track {
  const album = item.album ?? undefined;
  return {
    id: uuid(),
    source: { kind: "spotify-import", spotifyUri: item.uri },
    title: item.name,
    artist: combineArtistNames(item),
    album: album?.name,
    year: parseReleaseYear(album?.release_date),
    durationMs: item.duration_ms,
    coverUrl: pickSmallestImage(album?.images),
    enrichment: { status: "idle" },
    // Spotify-import is "matched by definition" — the user picked this
    // row by importing the playlist. We don't have a candidate list or
    // score (this isn't a search result); synthesize so the matched
    // arm is satisfied. previewUrl carries through when present.
    spotify: {
      status: "matched",
      uri: item.uri,
      candidates: [],
      score: 1,
      previewUrl: item.preview_url ?? undefined,
    },
  };
}

// A Spotify track result (search OR import) is only usable if it carries
// the identity fields every downstream path depends on: `id` (candidate
// dedup key), `uri` (selection + publish), and `name` (display + similarity
// scoring). Partial/malformed items from schema drift or a truncated body
// are dropped rather than producing a candidate with `title: undefined` or
// an undefined dedup key. `spotify:local:` URIs are also excluded — they
// aren't playable through the SDK or replayable to other playlists.
export function isUsableSpotifyTrack(
  item: SpotifyTrackResponse | null | undefined,
): item is SpotifyTrackResponse {
  if (!item || !item.id || !item.uri || !item.name) return false;
  if (item.uri.startsWith("spotify:local:")) return false;
  return true;
}

// Import uses the same usability contract as search — delegates so the two
// paths can't drift (the search path previously had NO guard, letting a
// malformed item map to a candidate with `title: undefined`).
export function isImportableTrack(
  item: SpotifyTrackResponse | null | undefined,
): item is SpotifyTrackResponse {
  return isUsableSpotifyTrack(item);
}

// The six displayed fields Spotify is authoritative for (DESIGN §4.5). Both
// the auto-match runner and the manual picker promote a candidate to the
// row's displayed identity by writing this exact set, so the two paths can't
// drift — earlier versions had auto-match miss `durationMs` / `coverUrl`.
export type SpotifyDisplayFields = Partial<{
  title: string;
  artist: string;
  album: string;
  year: number;
  durationMs: number;
  coverUrl: string;
}>;

export function spotifyDisplayFieldsFromCandidate(
  candidate: SpotifyCandidate,
): SpotifyDisplayFields {
  const result: SpotifyDisplayFields = {
    title: candidate.title,
    artist: candidate.artist,
  };
  if (candidate.album !== undefined) result.album = candidate.album;
  if (candidate.year !== undefined) result.year = candidate.year;
  if (candidate.durationMs !== undefined) result.durationMs = candidate.durationMs;
  if (candidate.coverUrl !== undefined) result.coverUrl = candidate.coverUrl;
  return result;
}

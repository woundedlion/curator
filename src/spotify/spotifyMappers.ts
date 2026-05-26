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
    spotify: {
      status: "matched",
      uri: item.uri,
      previewUrl: item.preview_url ?? undefined,
    },
  };
}

export function isImportableTrack(
  item: SpotifyTrackResponse | null | undefined,
): item is SpotifyTrackResponse {
  return Boolean(item && item.id && item.uri && item.name);
}

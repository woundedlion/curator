import { SPOTIFY_TRACK_ADD_CHUNK } from "../constants";
import type {
  SpotifyPlaylistSummary,
  Track,
} from "../types";
import {
  callSpotify,
  SpotifyAuthExpiredError,
  SpotifyForbiddenError,
  SpotifyHttpError,
  SpotifyRateLimitError,
  SpotifyServerError,
} from "./apiClient";
import type {
  SpotifyPaging,
  SpotifyPlaylistResponse,
  SpotifyPlaylistTrackItem,
  SpotifyUserResponse,
} from "./dtos";
import {
  isImportableTrack,
  isMappablePlaylist,
  toImportedTrack,
  toPlaylistSummary,
} from "./spotifyMappers";

type CreatePlaylistInput = {
  name: string;
  description?: string;
  public: boolean;
  collaborative: boolean;
};

export async function fetchCurrentUser(
  clientId: string,
): Promise<SpotifyUserResponse> {
  return callSpotify<SpotifyUserResponse>({ path: "/me" }, clientId);
}

// 500 pages × 100 items/page = 50k items, well above any sane user
// playlist. The cap exists to bound the rate-limit budget a single
// import can spend if Spotify ever ships a malformed `next` loop
// (or just a pathologically large playlist) — we'd rather error
// loudly than burn 350ms × N requests into a 429 ban.
const FETCH_ALL_PAGES_MAX = 500;

async function fetchAllPages<T>(
  initialPath: string,
  clientId: string,
  query?: Record<string, string | number>,
): Promise<T[]> {
  const items: T[] = [];
  let path: string | null = initialPath;
  let pageQuery = query;
  let pageCount = 0;

  while (path) {
    if (pageCount >= FETCH_ALL_PAGES_MAX) {
      throw new Error(
        `Spotify paging exceeded ${FETCH_ALL_PAGES_MAX} pages — truncating to prevent runaway request budget`,
      );
    }
    const page: SpotifyPaging<T> = await callSpotify<SpotifyPaging<T>>(
      { path, query: pageQuery },
      clientId,
    );
    items.push(...page.items);
    pageCount++;
    if (page.next) {
      // Spotify's `next` is an absolute api.spotify.com URL whose path is
      // always prefixed with the `/v1` API version (callSpotify prepends
      // SPOTIFY_API_BASE, which already includes `/v1`). Strip the prefix
      // when present so we don't double it; tolerate its absence (a future
      // unversioned/relative `next`) by passing the path through unchanged
      // rather than corrupting it.
      const url = new URL(page.next);
      const pathname = url.pathname.startsWith("/v1/")
        ? url.pathname.slice("/v1".length)
        : url.pathname;
      path = pathname + url.search;
      pageQuery = undefined;
    } else {
      path = null;
    }
  }
  return items;
}

export async function fetchAllPlaylists(
  clientId: string,
): Promise<SpotifyPlaylistSummary[]> {
  const pages = await fetchAllPages<SpotifyPlaylistResponse | null>(
    "/me/playlists",
    clientId,
    { limit: 50 },
  );
  return pages.filter(isMappablePlaylist).map(toPlaylistSummary);
}

function extractTrackFromItem(
  item: SpotifyPlaylistTrackItem | null | undefined,
): SpotifyPlaylistTrackItem["track"] | undefined {
  if (!item) return undefined;
  // Local-file uploads to a Spotify playlist carry `is_local: true`
  // on the envelope. Their inner uri is `spotify:local:...`, which is
  // not playable through the Web Playback SDK and cannot be re-published
  // to a different playlist. Drop them at the boundary so they never
  // get synthesized as a `matched` SpotifyMatch downstream.
  if (item.is_local) return undefined;
  if (item.track) return item.track;
  if (item.item) return item.item;
  const flat = item as unknown as Partial<
    NonNullable<SpotifyPlaylistTrackItem["track"]>
  >;
  if (flat.id && flat.uri && flat.name) {
    return flat as NonNullable<SpotifyPlaylistTrackItem["track"]>;
  }
  return undefined;
}

export async function fetchPlaylistTracks(
  playlistId: string,
  clientId: string,
): Promise<Track[]> {
  const items = await fetchAllPages<SpotifyPlaylistTrackItem>(
    `/playlists/${playlistId}/items`,
    clientId,
    { limit: 100 },
  );
  const importable = items
    .map(extractTrackFromItem)
    .filter(isImportableTrack);
  if (items.length > 0 && importable.length === 0) {
    console.warn(
      "[curator] fetchPlaylistTracks: items present but none extractable. " +
        "First item shape:",
      JSON.stringify(items[0], null, 2),
    );
  }
  return importable.map(toImportedTrack);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export type PlaylistPushProgress = {
  added: number;
  total: number;
  failedChunks: number[];
};

async function addTrackChunk(
  playlistId: string,
  uris: string[],
  clientId: string,
): Promise<void> {
  await callSpotify(
    {
      path: `/playlists/${playlistId}/items`,
      method: "POST",
      body: { uris },
    },
    clientId,
  );
}

async function replacePlaylistContents(
  playlistId: string,
  uris: string[],
  clientId: string,
): Promise<void> {
  await callSpotify(
    {
      path: `/playlists/${playlistId}/items`,
      method: "PUT",
      body: { uris },
    },
    clientId,
  );
}

export async function createPlaylist(
  input: CreatePlaylistInput,
  clientId: string,
): Promise<SpotifyPlaylistResponse> {
  // Use POST /me/playlists. The legacy /users/{user_id}/playlists is
  // deprecated and returns 403 for many accounts even when scopes and
  // dashboard allowlists are correct. /me/playlists derives the owner
  // from the bearer token, which Spotify still accepts.
  //
  // Conservative body shape — Spotify's validation is strict:
  //   - description is OPTIONAL; sending "" is accepted by most users
  //     but some accounts reject it. Omit when empty.
  //   - `collaborative: true` REQUIRES `public: false` per Spotify docs;
  //     the combination otherwise yields a 400/403. Force a private
  //     playlist when collaborative is requested.
  const body: Record<string, unknown> = {
    name: input.name,
    public: input.collaborative ? false : input.public,
    collaborative: input.collaborative,
  };
  const trimmedDescription = input.description?.trim();
  if (trimmedDescription) body.description = trimmedDescription;

  return callSpotify<SpotifyPlaylistResponse>(
    {
      path: `/me/playlists`,
      method: "POST",
      body,
    },
    clientId,
  );
}

type PushHandlers = {
  onProgress?: (progress: PlaylistPushProgress) => void;
};

// Errors that mean "every subsequent chunk will also fail." Bucketing
// these as a "failed chunk" would silently continue and produce a publish
// claim of "0/N added" with no real error to surface to the user.
function isFatalPushError(error: unknown): boolean {
  return (
    error instanceof SpotifyAuthExpiredError ||
    error instanceof SpotifyRateLimitError ||
    // 403 on a chunk = write access to this playlist was lost (scope
    // revoked, collaborator removed). Every subsequent chunk hits the same
    // wall — abort with the real error instead of bucketing each one and
    // claiming a misleading "0/N added" with no surfaced cause.
    error instanceof SpotifyForbiddenError ||
    // 404 on a chunk = the playlist was deleted mid-publish (e.g. from
    // another device). Same reasoning: it can never succeed for the
    // remaining chunks, so fail loudly rather than retry-bucket them all.
    (error instanceof SpotifyHttpError && error.status === 404) ||
    // A failed token refresh (transient 5xx on /api/token) leaves us with
    // no valid bearer for ANY subsequent chunk — abort rather than retry
    // the same doomed refresh once per remaining chunk. A chunk-level 5xx
    // on the /items call itself stays non-fatal and is bucketed for retry.
    (error instanceof SpotifyServerError && error.path === "/api/token")
  );
}

export async function pushTracksToPlaylist(
  playlistId: string,
  uris: string[],
  clientId: string,
  handlers: PushHandlers = {},
): Promise<PlaylistPushProgress> {
  const chunks = chunk(uris, SPOTIFY_TRACK_ADD_CHUNK);
  const progress: PlaylistPushProgress = {
    added: 0,
    total: uris.length,
    failedChunks: [],
  };

  for (let i = 0; i < chunks.length; i++) {
    const slice = chunks[i]!;
    try {
      await addTrackChunk(playlistId, slice, clientId);
      progress.added += slice.length;
    } catch (error) {
      if (isFatalPushError(error)) throw error;
      progress.failedChunks.push(i);
    }
    handlers.onProgress?.({ ...progress });
  }
  return progress;
}

// Thrown by replaceAndPushTracks when called with no URIs. A PUT
// /items {uris: []} is destructive — it CLEARS the destination playlist.
// The publisher (playlistPublisher.EmptyReplaceError) already guards its
// own call site, but this is an exported function: any other/future
// caller must not be able to silently wipe a playlist by passing an empty
// list. Defend at the destructive boundary itself rather than trusting
// every caller.
export class EmptyReplaceUrisError extends Error {
  constructor() {
    super("replaceAndPushTracks called with no URIs (would clear the playlist)");
    this.name = "EmptyReplaceUrisError";
  }
}

export async function replaceAndPushTracks(
  playlistId: string,
  uris: string[],
  clientId: string,
  handlers: PushHandlers = {},
): Promise<PlaylistPushProgress> {
  // Refuse to issue the clearing PUT. With empty uris the first chunk
  // would be `[]`, and PUT /items {uris: []} wipes the playlist — throw
  // before any request goes out.
  if (uris.length === 0) throw new EmptyReplaceUrisError();
  const [firstChunk, ...remainingChunks] = chunk(uris, SPOTIFY_TRACK_ADD_CHUNK);
  const progress: PlaylistPushProgress = {
    added: 0,
    total: uris.length,
    failedChunks: [],
  };

  try {
    await replacePlaylistContents(playlistId, firstChunk ?? [], clientId);
    progress.added += firstChunk?.length ?? 0;
  } catch (error) {
    if (isFatalPushError(error)) throw error;
    progress.failedChunks.push(0);
  }
  handlers.onProgress?.({ ...progress });

  for (let i = 0; i < remainingChunks.length; i++) {
    const slice = remainingChunks[i]!;
    try {
      await addTrackChunk(playlistId, slice, clientId);
      progress.added += slice.length;
    } catch (error) {
      if (isFatalPushError(error)) throw error;
      progress.failedChunks.push(i + 1);
    }
    handlers.onProgress?.({ ...progress });
  }
  return progress;
}


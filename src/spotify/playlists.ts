import { SPOTIFY_TRACK_ADD_CHUNK } from "../constants";
import type {
  SpotifyPlaylistSummary,
  Track,
} from "../types";
import {
  callSpotify,
  SpotifyAuthExpiredError,
  SpotifyRateLimitError,
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

async function fetchAllPages<T>(
  initialPath: string,
  clientId: string,
  query?: Record<string, string | number>,
): Promise<T[]> {
  const items: T[] = [];
  let path: string | null = initialPath;
  let pageQuery = query;

  while (path) {
    const page: SpotifyPaging<T> = await callSpotify<SpotifyPaging<T>>(
      { path, query: pageQuery },
      clientId,
    );
    items.push(...page.items);
    if (page.next) {
      const url = new URL(page.next);
      path = url.pathname.replace(/^\/v1/, "") + url.search;
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
    error instanceof SpotifyRateLimitError
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
    try {
      await addTrackChunk(playlistId, chunks[i], clientId);
      progress.added += chunks[i].length;
    } catch (error) {
      if (isFatalPushError(error)) throw error;
      progress.failedChunks.push(i);
    }
    handlers.onProgress?.({ ...progress });
  }
  return progress;
}

export async function replaceAndPushTracks(
  playlistId: string,
  uris: string[],
  clientId: string,
  handlers: PushHandlers = {},
): Promise<PlaylistPushProgress> {
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
    try {
      await addTrackChunk(playlistId, remainingChunks[i], clientId);
      progress.added += remainingChunks[i].length;
    } catch (error) {
      if (isFatalPushError(error)) throw error;
      progress.failedChunks.push(i + 1);
    }
    handlers.onProgress?.({ ...progress });
  }
  return progress;
}

export function findPlaylistsByName(
  playlists: SpotifyPlaylistSummary[],
  ownerId: string,
  candidateName: string,
): SpotifyPlaylistSummary[] {
  const targetName = candidateName.trim().toLowerCase();
  return playlists.filter(
    (playlist) =>
      playlist.ownerId === ownerId &&
      playlist.name.trim().toLowerCase() === targetName,
  );
}

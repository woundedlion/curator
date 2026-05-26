import { SPOTIFY_TRACK_ADD_CHUNK } from "../constants";
import type {
  SpotifyPlaylistSummary,
  Track,
} from "../types";
import { callSpotify } from "./apiClient";
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
  userId: string,
  input: CreatePlaylistInput,
  clientId: string,
): Promise<SpotifyPlaylistResponse> {
  return callSpotify<SpotifyPlaylistResponse>(
    {
      path: `/users/${userId}/playlists`,
      method: "POST",
      body: {
        name: input.name,
        description: input.description ?? "",
        public: input.public,
        collaborative: input.collaborative,
      },
    },
    clientId,
  );
}

type PushHandlers = {
  onProgress?: (progress: PlaylistPushProgress) => void;
};

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
    } catch {
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
  } catch {
    progress.failedChunks.push(0);
  }
  handlers.onProgress?.({ ...progress });

  for (let i = 0; i < remainingChunks.length; i++) {
    try {
      await addTrackChunk(playlistId, remainingChunks[i], clientId);
      progress.added += remainingChunks[i].length;
    } catch {
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

export type SpotifyUserResponse = {
  id: string;
  display_name?: string;
  country?: string;
};

export type SpotifyImage = { url: string; width?: number; height?: number };

export type SpotifyArtistRef = { id: string; name: string };

export type SpotifyAlbumRef = {
  id: string;
  name: string;
  release_date?: string;
  images?: SpotifyImage[];
};

export type SpotifyTrackResponse = {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  preview_url: string | null;
  artists: SpotifyArtistRef[];
  album: SpotifyAlbumRef;
};

export type SpotifySearchResponse = {
  tracks: { items: SpotifyTrackResponse[] };
};

export type SpotifyPaging<T> = {
  items: T[];
  next: string | null;
  total: number;
};

export type SpotifyPlaylistResponse = {
  id: string;
  name: string;
  owner: { id: string; display_name?: string };
  images?: SpotifyImage[];
  // Newer Spotify responses use `items` for the item-count envelope on
  // /me/playlists, while older / single-playlist responses still use
  // `tracks`. We accept either.
  items?: { total: number };
  tracks?: { total: number };
  snapshot_id?: string;
  collaborative?: boolean;
  public?: boolean;
};

export type SpotifyPlaylistTrackItem = {
  added_at?: string;
  is_local?: boolean;
  track?: SpotifyTrackResponse | null;
  item?: SpotifyTrackResponse | null;
};

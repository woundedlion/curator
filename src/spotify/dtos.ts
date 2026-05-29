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

// Spotify's playlist-tracks endpoint ships at least three on-the-wire
// shapes that callers need to tolerate, often within the same response:
//   1. `{ track: SpotifyTrackResponse | null }`  — the documented shape.
//   2. `{ item: SpotifyTrackResponse | null }`   — newer envelope on
//      some unified endpoints; same payload, different key.
//   3. A wholly flat SpotifyTrackResponse with no envelope at all.
// `extractTrackFromItem` in playlists.ts is the single funnel that
// normalizes all three; this DTO carries the two named-envelope
// variants. The "flat" form is matched structurally by the same helper.
export type SpotifyPlaylistTrackItem = {
  added_at?: string;
  is_local?: boolean;
  track?: SpotifyTrackResponse | null;
  item?: SpotifyTrackResponse | null;
};

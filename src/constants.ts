export const APP_VERSION = "0.1.0";

// Bump when the shape or derivation of cached MBCandidate values changes.
// Cache entries written with an older version are treated as cache misses
// and refetched, so the cache self-heals without needing a manual clear.
export const MB_CACHE_VERSION = 3;

export const AUDIO_EXTENSIONS = [
  "mp3",
  "flac",
  "m4a",
  "ogg",
  "opus",
  "wav",
  "aac",
  "wma",
] as const;

export const TEXT_EXTENSIONS = ["txt"] as const;
export const PLAYLIST_EXTENSIONS = ["m3u", "m3u8"] as const;

export const SPOTIFY_SCOPES = [
  "playlist-modify-public",
  "playlist-modify-private",
  "playlist-read-private",
  "playlist-read-collaborative",
  "streaming",
  "user-modify-playback-state",
  "user-read-playback-state",
  "user-read-email",
  "user-read-private",
].join(" ");

export const SPOTIFY_PLAYBACK_SDK_URL = "https://sdk.scdn.co/spotify-player.js";

export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

export const MUSICBRAINZ_API_BASE = "https://musicbrainz.org/ws/2";
export const COVER_ART_BASE = "https://coverartarchive.org/release";

export const MUSICBRAINZ_RATE_INTERVAL_MS = 1100;

export const SPOTIFY_TRACK_ADD_CHUNK = 100;

export const DEFAULT_ACCEPT_MB = 0.75;
export const DEFAULT_ACCEPT_SPOTIFY_HIGH = 0.9;
export const SPOTIFY_AUTOPICK_GAP = 0.15;
export const SPOTIFY_SEARCH_LIMIT = 10;
// MB returns a smaller working set than Spotify per query — its match
// quality is high enough that the top-5 covers the realistic outcome
// space, and asking for more burns the 1-req/sec budget for diminishing
// returns. The dedup pass collapses release variants further before
// scoring.
export const MB_SEARCH_LIMIT = 5;

export const ROW_HEIGHT_PX = 44;

export const DRAFT_PLAYLIST_ID = "active-draft";
export const DEFAULT_PLAYLIST_NAME = "New Playlist";

// Universal " - " delimiter used by text-list ingest, filename heuristics,
// and m3u EXTINF parsing to split artist/title (and album/track when present).
export const ARTIST_TITLE_SEPARATOR = " - ";

export const SETTINGS_STORAGE_KEY = "curator.settings.v1";
export const TOKENS_STORAGE_KEY = "curator.spotify.tokens.v1";
export const PKCE_VERIFIER_KEY = "curator.spotify.pkce_verifier";
export const PKCE_STATE_KEY = "curator.spotify.pkce_state";
// Set when an auth callback returns ?error= (user denied, scope rejected,
// etc.). Suppresses the bootstrap's auto-reconnect for the rest of the
// tab session so a denial doesn't loop the user straight back to Spotify
// on every refresh. Cleared when the user explicitly clicks Connect.
export const SPOTIFY_AUTO_RECONNECT_SUPPRESSED_KEY =
  "curator.spotify.autoReconnectSuppressed";
// Per-tab playlist scroll position. sessionStorage scope: survives reloads,
// clears on tab close — matches DESIGN §5 "fresh tab should start clean."
export const PLAYLIST_SCROLL_KEY = "curator.playlist.scrollTop";

// Spotify rate-limit circuit-breaker expiry. localStorage scope: must
// survive across page reloads and across tabs — a Retry-After penalty
// is enforced per Spotify app (client_id), not per tab, so a fresh tab
// would otherwise re-burn the quota immediately.
export const SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY =
  "curator.spotify.circuitOpenUntil.v1";

// Consecutive-failure counter for exponential backoff. Persisted so
// reload doesn't reset escalation — Spotify's CORS-hidden Retry-After
// is often a multi-hour ban; we discover the actual duration only by
// watching successive probes still come back 429, so losing that count
// on reload would put us back at the 5-min default and resume probing
// into the ban.
export const SPOTIFY_CIRCUIT_FAILURE_COUNT_KEY =
  "curator.spotify.circuitFailureCount.v1";

// Proactive spacing window. Persisted for the same reason as the
// circuit breaker: Spotify's rolling-30s quota counts requests from the
// previous page session, but the in-memory `nextAllowedAt` resets on
// reload. Without persistence, a refresh that follows a heavy burst
// (re-enrich-all, playlist import) lets the new tab fire immediately
// and 429 into the unfinished window.
export const SPOTIFY_NEXT_ALLOWED_AT_KEY =
  "curator.spotify.nextAllowedAt.v1";

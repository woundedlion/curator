export type SourceKind = "file" | "text" | "m3u" | "spotify-import";

export type TrackSource = {
  kind: SourceKind;
  fileName?: string;
  rawLine?: string;
  spotifyUri?: string;
};

export type EnrichmentStatus =
  | "idle"
  | "pending"
  | "matched"
  | "ambiguous"
  | "failed";

export type SpotifyMatchStatus =
  | "idle"
  | "pending"
  | "matched"
  | "ambiguous"
  | "missing";

export type MBCandidate = {
  recordingId: string;
  releaseId?: string;
  title: string;
  artist: string;
  album?: string;
  year?: number;
  originalYear?: number;
  score: number;
};

export type SpotifyCandidate = {
  uri: string;
  id: string;
  title: string;
  artist: string;
  album?: string;
  year?: number;
  durationMs?: number;
  previewUrl?: string;
  coverUrl?: string;
  score: number;
};

export type Enrichment = {
  status: EnrichmentStatus;
  mbRecordingId?: string;
  candidates?: MBCandidate[];
  score?: number;
  userOverride?: boolean;
};

export type SpotifyMatch = {
  status: SpotifyMatchStatus;
  uri?: string;
  candidates?: SpotifyCandidate[];
  score?: number;
  previewUrl?: string;
};

export type Track = {
  id: string;
  source: TrackSource;

  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  year?: number;
  originalYear?: number;
  trackNo?: number;
  trackOf?: number;
  discNo?: number;
  durationMs?: number;
  coverUrl?: string;

  localFile?: File;

  altQuery?: { title?: string; artist?: string };

  enrichment: Enrichment;
  spotify: SpotifyMatch;
};

export type SortField =
  | "index"
  | "artist"
  | "year"
  | "originalYear"
  | "album"
  | "trackNo"
  | "title";

export type SortDirection = "asc" | "desc";

export type SortSpec = {
  field: SortField;
  dir: SortDirection;
} | null;

export type Playlist = {
  id: string;
  name: string;
  description?: string;
  public: boolean;
  collaborative: boolean;
  trackIds: string[];
  sort: SortSpec;
  hideUnmatched: boolean;
};

export type Settings = {
  spotifyClientId?: string;
  spotifyRedirectUri: string;
  recursiveFolderScan: boolean;
  acceptThresholds: { mb: number; spotify: number };
  musicbrainzContact: string;
  preferFullPlayback: boolean;
};

export type SpotifyPlaylistSummary = {
  id: string;
  name: string;
  trackCount?: number;
  ownerId: string;
  ownerDisplayName?: string;
  coverUrl?: string;
  lastModified?: string;
};

export type SpotifyTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
};

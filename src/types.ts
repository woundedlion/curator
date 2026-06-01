export type SourceKind = "file" | "text" | "m3u" | "spotify-import";

// Discriminated on `kind` so each arm carries exactly the locator field
// that's meaningful for that source — a `file` row can't smuggle a
// `spotifyUri`, a `spotify-import` row can't be missing one, and a text/
// m3u line can't claim a `fileName`. The constructors in ingest/ and
// spotify/ are the only writers; the union keeps a future writer from
// producing a nonsensical combination the type system would otherwise
// wave through.
export type TrackSource =
  | { kind: "file"; fileName: string }
  | { kind: "text"; rawLine?: string }
  | { kind: "m3u"; rawLine?: string }
  | { kind: "spotify-import"; spotifyUri: string };

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

// Discriminated union over status. Each arm carries exactly the
// payload that's valid for that state — the type system rejects e.g.
// `{ status: "missing", uri: ... }` or `{ status: "matched" }` with no
// `mbRecordingId`. Status-only arms (`idle` / `pending` / `failed` /
// `missing`) are deliberately payload-free so partial-update spreads
// like `{ ...spotify, status: "pending" }` can't smuggle stale fields
// across a transition.
export type Enrichment =
  | { status: "idle"; userOverride?: boolean }
  | { status: "pending"; userOverride?: boolean }
  | {
      status: "matched";
      mbRecordingId: string;
      score: number;
      // Required (possibly empty) so `matched ⇒ candidates array exists`
      // holds symmetrically with SpotifyMatch.matched and the `ambiguous`
      // arm below — a consumer never has to disambiguate "no candidates"
      // from "candidates not carried." Round-tripped imports synthesize [].
      candidates: MBCandidate[];
      userOverride?: boolean;
    }
  | {
      status: "ambiguous";
      candidates: MBCandidate[];
      score: number;
      userOverride?: boolean;
    }
  | {
      status: "failed";
      candidates?: MBCandidate[];
      userOverride?: boolean;
    };

export type SpotifyMatch =
  | { status: "idle" }
  | { status: "pending" }
  | {
      status: "matched";
      uri: string;
      candidates: SpotifyCandidate[];
      score: number;
      previewUrl?: string;
    }
  | {
      status: "ambiguous";
      candidates: SpotifyCandidate[];
      score: number;
      // Set when a round-tripped curator-export row carries a URI but
      // imports as ambiguous (the user picked the version originally,
      // but the score gate doesn't re-confirm on import).
      uri?: string;
    }
  | { status: "missing" };

// Derived enums for callers that just need to switch on status (e.g.
// glyph color maps). Always in lock-step with the union arms above.
export type EnrichmentStatus = Enrichment["status"];
export type SpotifyMatchStatus = SpotifyMatch["status"];

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

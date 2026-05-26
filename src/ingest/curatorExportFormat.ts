// Shared types + format marker for the Curator playlist export round-trip.
// The build helper lives next to the export action; the parse helper lives
// next to the ingest pipeline so the format definition itself stays
// dependency-free.

export const CURATOR_EXPORT_FORMAT = "curator-playlist-v1";

export type CuratorExportedTrack = {
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
  // The selected Spotify URI for this row (if the user accepted a match).
  spotifyUri?: string;
  // The selected MusicBrainz recording id for this row (if enriched).
  mbRecordingId?: string;
};

export type CuratorExportEnvelope = {
  format: typeof CURATOR_EXPORT_FORMAT;
  name: string;
  description?: string;
  public?: boolean;
  collaborative?: boolean;
  tracks: CuratorExportedTrack[];
};

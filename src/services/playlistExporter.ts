import {
  CURATOR_EXPORT_FORMAT,
  type CuratorExportEnvelope,
  type CuratorExportedTrack,
} from "../ingest/curatorExportFormat";
import { usePlaylistStore } from "../store/playlistStore";
import { useUiStore } from "../store/uiStore";
import type { Track } from "../types";
import { getMbRecordingId, getSpotifyUri } from "../util/trackAccessors";

function toExported(track: Track): CuratorExportedTrack {
  // Only round-trippable fields. We intentionally drop:
  //  - localFile (not serializable, and a dropped file can't carry the
  //    File handle back anyway)
  //  - candidates[] arrays (large; re-fetchable via per-row re-enrich)
  //  - per-track UI/runtime state (status flags, scores)
  // The remaining fields are exactly what the runtime needs to render the
  // row and what publish-to-Spotify needs to push (the URI).
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumArtist: track.albumArtist,
    year: track.year,
    originalYear: track.originalYear,
    trackNo: track.trackNo,
    trackOf: track.trackOf,
    discNo: track.discNo,
    durationMs: track.durationMs,
    coverUrl: track.coverUrl,
    spotifyUri: getSpotifyUri(track.spotify),
    mbRecordingId: getMbRecordingId(track.enrichment),
  };
}

function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return s || "playlist";
}

export function buildExportEnvelope(): CuratorExportEnvelope {
  const state = usePlaylistStore.getState();
  const tracks = state.playlist.trackIds
    .map((id) => state.tracksById[id])
    .filter((t): t is Track => t !== undefined)
    .map(toExported);
  return {
    format: CURATOR_EXPORT_FORMAT,
    name: state.playlist.name,
    description: state.playlist.description ?? "",
    public: state.playlist.public,
    collaborative: state.playlist.collaborative,
    tracks,
  };
}

export function exportActivePlaylist(): void {
  const state = usePlaylistStore.getState();
  if (state.playlist.trackIds.length === 0) return;
  const envelope = buildExportEnvelope();
  const json = JSON.stringify(envelope, null, 2);
  // text/plain so browsers download rather than rendering the JSON view.
  const blob = new Blob([json], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slugify(envelope.name)}.curator.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revocation. Some browsers (notably Firefox/Safari) start the
  // download asynchronously after a.click(); revoking the object URL
  // synchronously can race and cancel the download. The macrotask lets
  // the download stream initiate first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  useUiStore.getState().pushToast({
    kind: "success",
    message: `Exported ${envelope.tracks.length} tracks`,
  });
}

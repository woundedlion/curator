// Removes every queued Spotify and MusicBrainz request tagged with
// the given trackId. Used by the playlist store's deletion actions
// (removeTrack, removeTracks, clearPlaylist, replaceAll) to keep the
// rate-limit queues from working on rows the user has already
// removed.
//
// Layered with the defense-in-depth guards inside the queue task
// bodies (matchOne / runOneTrack pass `guard: () => storeHas(id)`).
// The cancel sweep removes pending tasks synchronously; the guards
// catch the narrow race window where a task has already shifted out
// of pending but hasn't yet sent its HTTP call.
//
// In-flight requests cannot be aborted (no AbortSignal contract on
// the HTTP path) — they complete naturally and the orchestrators
// discard the result because the track is gone from the store.

import { cancelSpotifyRequestsByTag } from "../spotify/apiClient";
import { cancelMusicbrainzRequestsByTag } from "../enrichment/musicbrainzClient";

export function cancelTrackRequests(trackIds: readonly string[]): void {
  for (const id of trackIds) {
    cancelSpotifyRequestsByTag(id);
    cancelMusicbrainzRequestsByTag(id);
  }
}

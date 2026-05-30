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
// In-flight HTTP requests ARE aborted at the network layer: the
// IntervalQueue routes `cancelByTag` through the in-flight slot's
// AbortController, which the apiClient/musicbrainzClient fetch
// wrappers compose with their per-request timeout signal. The
// orchestrators still discard any response that does manage to
// arrive late, because the track is gone from the store — the
// abort is a network-side resource reclaim, not a correctness
// requirement.

import { cancelSpotifyRequestsByTag } from "../spotify/apiClient";
import { cancelMusicbrainzRequestsByTag } from "../enrichment/musicbrainzClient";

export function cancelTrackRequests(trackIds: readonly string[]): void {
  for (const id of trackIds) {
    cancelSpotifyRequestsByTag(id);
    cancelMusicbrainzRequestsByTag(id);
  }
}

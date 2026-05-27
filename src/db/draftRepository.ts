import { getDatabase, STORE_PLAYLISTS, STORE_TRACKS } from "./database";
import type { Playlist, Track } from "../types";

function trackWithoutFile(track: Track): Track {
  const copy = { ...track };
  delete copy.localFile;
  return copy;
}

// Verify the track is structured-clone-safe up front. IDB transactions
// auto-commit when their request queue drains; if we let `put(track)` fail
// inside the transaction we'd then need to issue a retry `put`, but by the
// time the catch runs the transaction may have committed/aborted. Doing the
// structured-clone check synchronously here means we either put the full
// track or its file-less variant — never both, never on an inactive txn.
function trackSafeToPut(track: Track): Track {
  if (track.localFile === undefined) return track;
  try {
    structuredClone(track.localFile);
    return track;
  } catch (error) {
    console.warn(
      "saveDraft: dropping localFile (not structured-clone-safe)",
      { trackId: track.id, error },
    );
    return trackWithoutFile(track);
  }
}

// All saveDraft calls are serialized through this single-flight chain so a
// debounced write and a flush-on-hide write can't interleave at the IDB
// layer (clear() + put-loop is not atomic across overlapping callers).
let activeSave: Promise<void> = Promise.resolve();

export function saveDraft(
  playlist: Playlist,
  tracks: Track[],
): Promise<void> {
  const next = activeSave.then(() => writeDraft(playlist, tracks));
  activeSave = next.catch(() => undefined);
  return next;
}

async function writeDraft(
  playlist: Playlist,
  tracks: Track[],
): Promise<void> {
  try {
    const db = await getDatabase();
    const safeTracks = tracks.map(trackSafeToPut);
    const tx = db.transaction([STORE_PLAYLISTS, STORE_TRACKS], "readwrite");
    const playlistStore = tx.objectStore(STORE_PLAYLISTS);
    const trackStore = tx.objectStore(STORE_TRACKS);
    // Fire requests synchronously inside the transaction; awaiting each
    // request individually would let the transaction's request queue
    // drain and auto-commit. We collect the request promises and await
    // them as a batch alongside tx.done.
    const requests: Promise<unknown>[] = [
      playlistStore.put(playlist),
      trackStore.clear(),
    ];
    for (const track of safeTracks) requests.push(trackStore.put(track));
    await Promise.all(requests);
    await tx.done;
  } catch (error) {
    console.error("saveDraft failed", error);
    throw error;
  }
}

export async function loadDraft(
  playlistId: string,
): Promise<{ playlist: Playlist | null; tracks: Track[] }> {
  const db = await getDatabase();
  // Single read transaction so a save-in-between can't produce a
  // playlist-with-pruned-trackIds paired with the old tracks list. The
  // current writer pattern (clear+put under one tx) already prevents
  // most interleavings, but this is cheap and forward-compatible.
  const tx = db.transaction([STORE_PLAYLISTS, STORE_TRACKS], "readonly");
  const playlist =
    ((await tx.objectStore(STORE_PLAYLISTS).get(playlistId)) as
      | Playlist
      | undefined) ?? null;
  const tracks = (await tx.objectStore(STORE_TRACKS).getAll()) as Track[];
  await tx.done;
  return { playlist, tracks };
}

export async function clearDraft(playlistId: string): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction([STORE_PLAYLISTS, STORE_TRACKS], "readwrite");
  await tx.objectStore(STORE_PLAYLISTS).delete(playlistId);
  await tx.objectStore(STORE_TRACKS).clear();
  await tx.done;
}

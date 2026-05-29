import { getDatabase, STORE_PLAYLISTS, STORE_TRACKS } from "./database";
import type { Playlist, Track } from "../types";

// Thrown when IDB rejects a write because the origin has exceeded its
// quota. Callers should surface this to the user — a silent failure
// here means the active draft is no longer being persisted and a
// reload will discard their work.
export class DraftQuotaExceededError extends Error {
  constructor(cause: unknown) {
    super("IndexedDB quota exceeded — draft can't be saved");
    this.name = "DraftQuotaExceededError";
    this.cause = cause;
  }
}

function isQuotaExceeded(error: unknown): boolean {
  // DOMException name is the portable signal across browsers; the legacy
  // numeric code (22) is only set on some engines.
  return error instanceof DOMException && error.name === "QuotaExceededError";
}

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
  // Pin a resolved promise as the new chain head so a rejection here
  // doesn't poison every subsequent save. The caller's `next` still
  // sees the original rejection; we only swallow it on the chain so
  // future writes get a fresh attempt rather than inheriting a
  // permanently-rejected predecessor.
  activeSave = next.catch(() => undefined);
  return next;
}

// Retry transient IDB failures (e.g. brief lock contention, a transaction
// aborted by a competing tab) so an isolated failure doesn't drop the
// user's draft. Quota errors are stable and not retried — they surface to
// the caller immediately. Delays are tight because IDB recovers fast and
// a long pause would let the debounce queue stack writes.
const TRANSIENT_RETRY_DELAYS_MS = [100, 500];

async function writeDraft(
  playlist: Playlist,
  tracks: Track[],
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await writeDraftOnce(playlist, tracks);
      return;
    } catch (error) {
      if (isQuotaExceeded(error)) {
        console.error("saveDraft failed: IndexedDB quota exceeded", error);
        throw new DraftQuotaExceededError(error);
      }
      lastError = error;
      const delay = TRANSIENT_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      console.warn(
        `saveDraft attempt ${attempt + 1} failed; retrying in ${delay}ms`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  console.error("saveDraft failed after retries", lastError);
  throw lastError;
}

async function writeDraftOnce(
  playlist: Playlist,
  tracks: Track[],
): Promise<void> {
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

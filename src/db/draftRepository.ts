import { getDatabase, STORE_PLAYLISTS, STORE_TRACKS } from "./database";
import type { Playlist, Track } from "../types";

type PutOne = (track: Track) => Promise<unknown>;

function trackWithoutFile(track: Track): Track {
  const copy = { ...track };
  delete copy.localFile;
  return copy;
}

async function putTrackTolerant(put: PutOne, track: Track): Promise<void> {
  if (!track) {
    console.warn("saveDraft: skipping undefined track entry");
    return;
  }
  try {
    await put(track);
  } catch (error) {
    console.warn(
      "saveDraft: full track put failed, retrying without localFile",
      { trackId: track.id, error },
    );
    await put(trackWithoutFile(track));
  }
}

export async function saveDraft(
  playlist: Playlist,
  tracks: Track[],
): Promise<void> {
  try {
    const db = await getDatabase();
    const tx = db.transaction([STORE_PLAYLISTS, STORE_TRACKS], "readwrite");
    await tx.objectStore(STORE_PLAYLISTS).put(playlist);
    const trackStore = tx.objectStore(STORE_TRACKS);
    await trackStore.clear();
    const put: PutOne = (track) => trackStore.put(track);
    for (const track of tracks) {
      await putTrackTolerant(put, track);
    }
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
  const playlist = (await db.get(STORE_PLAYLISTS, playlistId)) ?? null;
  const tracks = (await db.getAll(STORE_TRACKS)) as Track[];
  return { playlist, tracks };
}

export async function clearDraft(playlistId: string): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction([STORE_PLAYLISTS, STORE_TRACKS], "readwrite");
  await tx.objectStore(STORE_PLAYLISTS).delete(playlistId);
  await tx.objectStore(STORE_TRACKS).clear();
  await tx.done;
}

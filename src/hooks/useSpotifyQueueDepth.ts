import { useEffect, useState } from "react";
import {
  getPendingSpotifyRequestCount,
  observeSpotifyQueueDepth,
} from "../spotify/apiClient";

/**
 * Live Spotify queue depth (queued + in-flight). Uses the unified
 * IntervalQueue's observer hook — no polling, updates fire exactly
 * when the depth changes.
 */
export function useSpotifyQueueDepth(): number {
  const [depth, setDepth] = useState(() => getPendingSpotifyRequestCount());
  useEffect(() => observeSpotifyQueueDepth(setDepth), []);
  return depth;
}

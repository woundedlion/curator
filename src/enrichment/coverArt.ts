import { COVER_ART_BASE } from "../constants";
import {
  loadCoverArtNegativeCache,
  saveCoverArtNegativeMbids,
} from "../db/musicbrainzCache";
import { ConcurrencyLimiter } from "../util/concurrencyLimiter";

const FRONT_250_SUFFIX = "/front-250";
const PROBE_TIMEOUT_MS = 5_000;
// CAA is hosted on archive.org; firing 1k parallel HEADs (one per row of
// a freshly imported library) wastes bandwidth and risks rate-limiting.
// 4 in-flight keeps us responsive without being abusive.
const PROBE_CONCURRENCY = 4;

const probeLimiter = new ConcurrencyLimiter(PROBE_CONCURRENCY);

// Negative results — a confirmed 404 from Cover Art Archive — are stable;
// re-probing burns bandwidth and rate budget for no benefit. Transient
// errors (network, 5xx) are *not* cached so a later re-enrich can retry.
// The set is hydrated from IndexedDB on first use and persisted on each
// new addition so the cache survives reloads.
//
// Memory cap mirrors the persistence cap (MAX_NEGATIVE_CACHE_SIZE in
// musicbrainzCache.ts). JS Sets preserve insertion order, so we evict
// the oldest entry whenever a new one would push us past the cap —
// FIFO, matching the on-disk slice policy. Without this, a session
// that probes a million distinct releases would keep them all live
// regardless of how many actually persist.
const MAX_IN_MEMORY_NEGATIVE_CACHE = 10_000;
// Initialized to an EMPTY Set up front (not null) so `recordNegative`
// always has a live in-memory target. Rationale: during the async
// hydration window a probe can land a fresh 404 and call
// `recordNegative(mbid)`. If `negativeCache` were null until hydration
// resolved, that in-session 404 would persist to IDB but be lost from
// memory the instant hydration overwrote the Set with the IDB snapshot
// — a track probed during startup could then re-probe the same dead
// release later in the session. Keeping a live Set + UNIONing the IDB
// ids on hydration (rather than replacing) makes the in-memory
// short-circuit authoritative for the whole session.
const negativeCache: Set<string> = new Set();
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

async function ensureHydrated(): Promise<Set<string>> {
  if (hydrated) return negativeCache;
  if (!hydratePromise) {
    hydratePromise = loadCoverArtNegativeCache()
      .then((mbids) => {
        // UNION, not replace: any 404s recorded in-session during the
        // hydration window are already in `negativeCache` and must
        // survive. Adding the loaded ids on top preserves both.
        for (const mbid of mbids) negativeCache.add(mbid);
        hydrated = true;
      })
      .catch((error) => {
        console.warn("coverArt: failed to hydrate negative cache", error);
        // Degraded mode: keep whatever was recorded in-session and mark
        // hydrated so we don't re-await a known-failed loader on every
        // probe (re-probing dead releases is the acceptable fallback).
        hydrated = true;
      });
  }
  await hydratePromise;
  return negativeCache;
}

// Microtask-batched persistence buffer. A re-enrich-all burst on a
// fresh import can produce dozens of 404s in the same tick; firing one
// IDB read-modify-write transaction per miss serializes them through
// IDB's per-store transaction lock and burns disk writes. Coalescing
// to one transaction per microtask is correctness-preserving (the
// in-memory Set is updated synchronously, so the negative-cache
// short-circuit is already authoritative for the rest of the session)
// and cuts the IDB pressure proportional to burst size.
const pendingNegativePersist = new Set<string>();
let persistFlushScheduled = false;

function flushNegativePersist(): void {
  persistFlushScheduled = false;
  if (pendingNegativePersist.size === 0) return;
  const batch = Array.from(pendingNegativePersist);
  pendingNegativePersist.clear();
  void saveCoverArtNegativeMbids(batch).catch((error) => {
    console.warn("coverArt: failed to persist negative cache entry", error);
  });
}

function recordNegative(mbid: string): void {
  // `negativeCache` is always a live Set (initialized eagerly), so an
  // in-session 404 updates memory immediately — even mid-hydration.
  negativeCache.add(mbid);
  // FIFO evict: Set iteration order is insertion order, so the first
  // value seen by the iterator is the oldest. We only evict one per
  // add because we only added one — the set never overshoots by more
  // than one entry between record calls.
  if (negativeCache.size > MAX_IN_MEMORY_NEGATIVE_CACHE) {
    const oldest = negativeCache.values().next().value;
    if (oldest !== undefined) negativeCache.delete(oldest);
  }
  pendingNegativePersist.add(mbid);
  if (!persistFlushScheduled) {
    persistFlushScheduled = true;
    queueMicrotask(flushNegativePersist);
  }
}

export function coverArtUrlForRelease(releaseMbid: string | undefined): string | undefined {
  if (!releaseMbid) return undefined;
  return `${COVER_ART_BASE}/${releaseMbid}${FRONT_250_SUFFIX}`;
}

// Discriminates a confirmed 404 (caller does nothing further, the negative
// cache absorbs it) from a transient failure (network / 5xx / timeout) the
// caller may want to surface to the user. Without this distinction the
// runner sees only `undefined` for both outcomes and silently drops cover
// art that *should* have resolved.
export type CoverArtProbeResult =
  | { kind: "ok"; url: string }
  | { kind: "missing" }
  | { kind: "transient" };

export async function probeCoverArtUrl(
  releaseMbid: string | undefined,
): Promise<CoverArtProbeResult> {
  const url = coverArtUrlForRelease(releaseMbid);
  if (!url || !releaseMbid) return { kind: "missing" };
  const cache = await ensureHydrated();
  if (cache.has(releaseMbid)) return { kind: "missing" };
  return probeLimiter.run(() => probeOne(url, releaseMbid));
}

async function probeOne(
  url: string,
  releaseMbid: string,
): Promise<CoverArtProbeResult> {
  // HEAD probes against CAA are usually fast but the host occasionally
  // hangs without responding. Cap the wait so a stall doesn't leak fetch
  // resources and so re-enrich-all on a 1k-track playlist can't pin on
  // one bad release id.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    if (response.status === 404) {
      recordNegative(releaseMbid);
      return { kind: "missing" };
    }
    if (!response.ok) {
      console.warn("probeCoverArtUrl: transient failure", response.status, url);
      return { kind: "transient" };
    }
    return { kind: "ok", url };
  } catch (error) {
    // AbortError from our own timeout isn't worth surfacing in console as
    // a "network error" — that misleads about the failure cause.
    if (error instanceof Error && error.name !== "AbortError") {
      console.warn("probeCoverArtUrl: network error", url, error);
    }
    return { kind: "transient" };
  } finally {
    clearTimeout(timeoutId);
  }
}

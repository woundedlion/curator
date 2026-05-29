import { COVER_ART_BASE } from "../constants";
import {
  loadCoverArtNegativeCache,
  saveCoverArtNegativeMbids,
} from "../db/musicbrainzCache";
import { ConcurrencyLimiter } from "../spotify/concurrencyLimiter";

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
let negativeCache: Set<string> | null = null;
let hydratePromise: Promise<void> | null = null;

async function ensureHydrated(): Promise<Set<string>> {
  if (negativeCache !== null) return negativeCache;
  if (!hydratePromise) {
    hydratePromise = loadCoverArtNegativeCache()
      .then((mbids) => {
        negativeCache = new Set(mbids);
      })
      .catch((error) => {
        console.warn("coverArt: failed to hydrate negative cache", error);
        negativeCache = new Set();
      });
  }
  await hydratePromise;
  return negativeCache!;
}

function recordNegative(mbid: string): void {
  if (negativeCache !== null) negativeCache.add(mbid);
  // Fire-and-forget persistence — losing a single negative cache write is
  // not data loss (next reload re-probes).
  void saveCoverArtNegativeMbids([mbid]).catch((error) => {
    console.warn("coverArt: failed to persist negative cache entry", error);
  });
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

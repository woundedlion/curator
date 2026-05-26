import { COVER_ART_BASE } from "../constants";

const FRONT_250_SUFFIX = "/front-250";
const PROBE_TIMEOUT_MS = 5_000;

// Negative results — a confirmed 404 from Cover Art Archive — are stable;
// re-probing burns bandwidth and rate budget for no benefit. Transient
// errors (network, 5xx) are *not* cached so a later re-enrich can retry.
const negativeCache = new Set<string>();

export function coverArtUrlForRelease(releaseMbid: string | undefined): string | undefined {
  if (!releaseMbid) return undefined;
  return `${COVER_ART_BASE}/${releaseMbid}${FRONT_250_SUFFIX}`;
}

export async function probeCoverArtUrl(
  releaseMbid: string | undefined,
): Promise<string | undefined> {
  const url = coverArtUrlForRelease(releaseMbid);
  if (!url || !releaseMbid) return undefined;
  if (negativeCache.has(releaseMbid)) return undefined;
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
      negativeCache.add(releaseMbid);
      return undefined;
    }
    if (!response.ok) {
      console.warn("probeCoverArtUrl: transient failure", response.status, url);
      return undefined;
    }
    return url;
  } catch (error) {
    console.warn("probeCoverArtUrl: network error", url, error);
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}

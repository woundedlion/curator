import { COVER_ART_BASE } from "../constants";

const FRONT_250_SUFFIX = "/front-250";

export function coverArtUrlForRelease(releaseMbid: string | undefined): string | undefined {
  if (!releaseMbid) return undefined;
  return `${COVER_ART_BASE}/${releaseMbid}${FRONT_250_SUFFIX}`;
}

export async function probeCoverArtUrl(
  releaseMbid: string | undefined,
): Promise<string | undefined> {
  const url = coverArtUrlForRelease(releaseMbid);
  if (!url) return undefined;
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

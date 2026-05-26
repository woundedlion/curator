import {
  APP_VERSION,
  MUSICBRAINZ_API_BASE,
  MUSICBRAINZ_RATE_INTERVAL_MS,
} from "../constants";
import type { MBCandidate } from "../types";
import { RateLimitedQueue } from "./rateLimitedQueue";

const SEARCH_LIMIT = 5;
const SEARCH_TIMEOUT_MS = 10_000;

type MBRecording = {
  id: string;
  title: string;
  "artist-credit"?: { name: string }[];
  releases?: { id?: string; title?: string; date?: string }[];
  "first-release-date"?: string;
};

type MBSearchResponse = {
  recordings?: MBRecording[];
};

const queue = new RateLimitedQueue(MUSICBRAINZ_RATE_INTERVAL_MS);

export function getMusicbrainzQueue(): RateLimitedQueue {
  return queue;
}

function buildClientParam(contactEmail: string): string {
  return `Curator/${APP_VERSION}-${contactEmail}`;
}

function buildSearchUrl(
  query: string,
  contactEmail: string,
  dismax: boolean,
): string {
  const params = new URLSearchParams({
    query,
    fmt: "json",
    limit: String(SEARCH_LIMIT),
    client: buildClientParam(contactEmail),
  });
  if (dismax) params.set("dismax", "true");
  return `${MUSICBRAINZ_API_BASE}/recording?${params.toString()}`;
}

function buildRequestHeaders(): HeadersInit {
  return { Accept: "application/json" };
}

function parseYearFromReleaseDate(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : undefined;
}

type MBRelease = NonNullable<MBRecording["releases"]>[number];

function earliestRelease(
  releases: MBRelease[] | undefined,
): MBRelease | undefined {
  if (!releases || releases.length === 0) return undefined;
  let earliest: MBRelease | undefined;
  let earliestYear = Number.POSITIVE_INFINITY;
  for (const release of releases) {
    const year = parseYearFromReleaseDate(release.date);
    if (year === undefined) continue;
    if (year < earliestYear) {
      earliestYear = year;
      earliest = release;
    }
  }
  return earliest ?? releases[0];
}

function recordingToCandidate(recording: MBRecording): MBCandidate {
  const artist = (recording["artist-credit"] ?? [])
    .map((credit) => credit.name)
    .join(", ");
  const earliest = earliestRelease(recording.releases);
  const earliestYearFromReleases = parseYearFromReleaseDate(earliest?.date);
  const recordingFirstYear = parseYearFromReleaseDate(
    recording["first-release-date"],
  );
  return {
    recordingId: recording.id,
    releaseId: earliest?.id,
    title: recording.title,
    artist,
    album: earliest?.title,
    year: earliestYearFromReleases ?? recordingFirstYear,
    originalYear: recordingFirstYear,
    score: 0,
  };
}

async function runOneSearch(
  query: string,
  contactEmail: string,
  dismax: boolean,
): Promise<MBCandidate[]> {
  return queue.enqueue(async () => {
    const url = buildSearchUrl(query, contactEmail, dismax);
    // The rate-limited queue serializes work — one hung request pins the
    // entire enrichment pipeline. Cap each fetch so a network stall
    // becomes a normal failure instead of a deadlock.
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      SEARCH_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(url, {
        headers: buildRequestHeaders(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("MusicBrainz search failed", {
        url,
        status: response.status,
        body: body.slice(0, 500),
      });
      throw new Error(
        `MusicBrainz ${response.status} ${response.statusText}: ${body.slice(0, 200)}`,
      );
    }
    try {
      const json = (await response.json()) as MBSearchResponse;
      const recordings = json.recordings ?? [];
      return recordings.map(recordingToCandidate);
    } catch (error) {
      // MB occasionally serves HTML during maintenance windows; a
      // SyntaxError from `response.json()` shouldn't kill the row with
      // an opaque message — surface a clearer transient-error message.
      throw new Error(
        `MusicBrainz returned non-JSON response: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
  });
}

function buildPermissiveQuery(strictQuery: string): string {
  // Strip Lucene field prefixes and quotes so MB's dismax parser can
  // tokenize the remaining words freely. Handles cases like
  // "Lovesponge" vs "Love Sponge" where strict phrase matching fails
  // but token-based search would hit.
  return strictQuery
    .replace(/\b\w+:/g, "")
    .replace(/"/g, "")
    .replace(/\bAND\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function searchRecordings(
  strictQuery: string,
  contactEmail: string,
): Promise<MBCandidate[]> {
  if (!strictQuery) return [];
  const strictResults = await runOneSearch(strictQuery, contactEmail, false);
  if (strictResults.length > 0) return strictResults;

  const permissiveQuery = buildPermissiveQuery(strictQuery);
  if (!permissiveQuery || permissiveQuery === strictQuery) {
    console.warn(
      "[curator] MusicBrainz strict + permissive returned 0 recordings.\n  strict:     " +
        strictQuery,
    );
    return [];
  }
  const permissiveResults = await runOneSearch(
    permissiveQuery,
    contactEmail,
    true,
  );
  if (permissiveResults.length === 0) {
    console.warn(
      "[curator] MusicBrainz returned 0 recordings.\n  strict:     " +
        strictQuery +
        "\n  permissive: " +
        permissiveQuery,
    );
  }
  return permissiveResults;
}

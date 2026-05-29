import {
  APP_VERSION,
  MUSICBRAINZ_API_BASE,
  MUSICBRAINZ_RATE_INTERVAL_MS,
} from "../constants";
import type { MBCandidate } from "../types";
import { parseRetryAfter } from "../spotify/apiClient";
import { IntervalQueue } from "../util/intervalQueue";

const SEARCH_LIMIT = 5;
const SEARCH_TIMEOUT_MS = 10_000;
const SERVICE_UNAVAILABLE_STATUS = 503;
// MB returns 503 during sustained traffic or maintenance windows. One
// retry buys us a free pass through a transient blip without retrying so
// aggressively that we punish a struggling server.
const MAX_503_RETRIES = 1;

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

// MB has a rigid 1 req/sec contract; no rolling window, no escalating
// penalty, so we don't persist `nextRunAt` across reloads (a fresh tab
// is fine to start at t=0 against MB's per-IP gate).
const queue = new IntervalQueue({ intervalMs: MUSICBRAINZ_RATE_INTERVAL_MS });

export function getMusicbrainzQueue(): IntervalQueue {
  return queue;
}

// MB recommends `Application/Version ( Contact )` — the bracketed contact
// form is the convention every official client follows. The value is also
// passed as the `client` URL parameter (alphanumerics + dashes + dots
// only, no spaces or parens) per the MB Application Identification docs.
export function buildClientParam(contactEmail: string): string {
  return `Curator-${APP_VERSION}-${contactEmail.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

export function buildUserAgent(contactEmail: string): string {
  return `Curator/${APP_VERSION} ( ${contactEmail} )`;
}

function maskContactInUrl(url: string): string {
  // The contact email leaks into devtools console logs via search URLs.
  // Redact the client= param before logging — keeps the URL useful for
  // debugging without exposing the user's address.
  return url.replace(/(client=)[^&]+/, "$1<redacted>");
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

function buildRequestHeaders(contactEmail: string): HeadersInit {
  // Some browsers ignore custom User-Agent on fetch() — the `client=` URL
  // param is the authoritative form for MB. Set both so non-browser
  // environments (test runners, node-fetch) still satisfy MB TOS.
  return {
    Accept: "application/json",
    "User-Agent": buildUserAgent(contactEmail),
  };
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
  // Prefer the recording's `first-release-date` for `year` when present —
  // it's MB's canonical "when was this recording first released" answer.
  // The search endpoint pre-filters releases by relevance and can omit
  // earlier reissues, so picking "earliest of the returned releases" can
  // disagree with the true earliest. originalYear stays pinned to
  // recording.first-release-date so callers that need the canonical
  // first-release year always have it.
  return {
    recordingId: recording.id,
    releaseId: earliest?.id,
    title: recording.title,
    artist,
    album: earliest?.title,
    year: recordingFirstYear ?? earliestYearFromReleases,
    originalYear: recordingFirstYear,
    score: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  contactEmail: string,
): Promise<Response> {
  // The rate-limited queue serializes work — one hung request pins the
  // entire enrichment pipeline. Cap each fetch so a network stall
  // becomes a normal failure instead of a deadlock.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: buildRequestHeaders(contactEmail),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runOneSearch(
  query: string,
  contactEmail: string,
  dismax: boolean,
  tag: string | undefined,
  guard: (() => boolean) | undefined,
): Promise<MBCandidate[]> {
  return queue.enqueue(async () => {
    const url = buildSearchUrl(query, contactEmail, dismax);
    let attempts = 0;
    while (true) {
      const response = await fetchWithTimeout(url, contactEmail);

      if (response.status === SERVICE_UNAVAILABLE_STATUS) {
        // MB asks for a backoff via Retry-After. Honor it once, then
        // give up so the user sees a clear error rather than the queue
        // stalling indefinitely on a wedged upstream.
        const retryMs = parseRetryAfter(
          response.headers.get("Retry-After"),
        );
        if (attempts < MAX_503_RETRIES) {
          attempts++;
          console.warn(
            `MusicBrainz 503 — waiting ${Math.round(retryMs / 1000)}s before retry`,
          );
          await sleep(retryMs);
          continue;
        }
        throw new Error(
          `MusicBrainz unavailable (503) — try again later`,
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error("MusicBrainz search failed", {
          url: maskContactInUrl(url),
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
          { cause: error },
        );
      }
    }
  }, { tag, guard });
}

// Match Lucene's escape pair (`\"` or `\\`). We must remove these BEFORE
// stripping bare `"` so the leading backslash doesn't survive into the
// permissive query as an orphan token.
const LUCENE_ESCAPE_PAIR = /\\["\\]/g;

// Lucene field-prefix tokens at word boundaries (recording:, artist:, etc.)
const LUCENE_FIELD_PREFIX = /\b\w+:/g;

// Lucene clause-joining `AND` — only between space-delimited clauses, NOT
// the literal word "AND" inside a title. Requires whitespace on both
// sides; the `\s+` collapse after handles the spacing fallout.
const LUCENE_AND_OPERATOR = / +AND +/g;

export function buildPermissiveQuery(strictQuery: string): string {
  // Strip Lucene field prefixes and quotes so MB's dismax parser can
  // tokenize the remaining words freely. Handles cases like
  // "Lovesponge" vs "Love Sponge" where strict phrase matching fails
  // but token-based search would hit.
  return strictQuery
    .replace(LUCENE_ESCAPE_PAIR, "")
    .replace(LUCENE_FIELD_PREFIX, "")
    .replace(/"/g, "")
    .replace(LUCENE_AND_OPERATOR, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type SearchOptions = {
  /**
   * Caller-supplied tag (typically a trackId) used by
   * `cancelMusicbrainzRequestsByTag` to drop still-pending MB
   * lookups when the track is deleted. Both the strict and the
   * permissive query for one trackId share the same tag.
   */
  tag?: string;
  /**
   * Defense-in-depth guard evaluated when the queued search pops.
   * If it returns false the search is treated as cancelled — no
   * HTTP call, no rate-limit slot consumed.
   */
  guard?: () => boolean;
};

export async function searchRecordings(
  strictQuery: string,
  contactEmail: string,
  options: SearchOptions = {},
): Promise<MBCandidate[]> {
  if (!strictQuery) return [];
  const { tag, guard } = options;
  const strictResults = await runOneSearch(
    strictQuery,
    contactEmail,
    false,
    tag,
    guard,
  );
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
    tag,
    guard,
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

/**
 * Remove every pending MusicBrainz request tagged with `tag` from
 * the queue, rejecting their promises with RequestCancelledError.
 * In-flight requests complete normally; the caller (enrichmentRunner)
 * is responsible for discarding the result when the track is gone.
 */
export function cancelMusicbrainzRequestsByTag(tag: string): number {
  return queue.cancelByTag(tag);
}

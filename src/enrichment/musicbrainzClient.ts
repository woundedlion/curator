import {
  APP_VERSION,
  MB_SEARCH_LIMIT,
  MUSICBRAINZ_API_BASE,
  MUSICBRAINZ_RATE_INTERVAL_MS,
} from "../constants";
import type { MBCandidate } from "../types";
import { tryParseRetryAfterMs } from "../spotify/apiClient";
import { IntervalQueue, RequestCancelledError } from "../util/intervalQueue";

// MB serves traffic from a single global cluster; tail latency during
// peak hours can climb above 10s on routine searches. Bumped to 30s so
// a slow-but-successful response doesn't surface as a confusing
// "signal is aborted without reason" error toast.
const SEARCH_TIMEOUT_MS = 30_000;
const SERVICE_UNAVAILABLE_STATUS = 503;
// MB returns 503 during sustained traffic or maintenance windows. One
// retry buys us a free pass through a transient blip without retrying so
// aggressively that we punish a struggling server.
const MAX_503_RETRIES = 1;
// A misconfigured upstream advertising `Retry-After: 86400` would stall
// the head of the queue (and every caller behind it) for a day. MB
// outages are short — the user benefits more from a clear error after a
// brief pause than a multi-hour hang. Cap locally so any Retry-After
// larger than this is treated as "give up after one short wait."
const MB_RETRY_AFTER_CAP_MS = 60_000;
// When the 503 carries no usable Retry-After (header absent — common —
// or unparseable), wait a short, MB-appropriate beat rather than
// inheriting the shared parser's 10-minute Spotify default. The old
// code defaulted to 10 min → clamped to the 60s cap above, so a bare
// 503 pinned the single in-flight slot (and every queued track) for a
// full minute. MB's gate is 1 req/sec, so a 1s pause is plenty.
const MB_503_DEFAULT_RETRY_MS = 1_000;

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

// Out-of-slot 503 backoffs (see runOneSearch) are NOT in the queue, so
// `queue.cancelByTag` can't reach them. Track each in-progress backoff's
// AbortController by tag here so `cancelMusicbrainzRequestsByTag` can
// abort the wait immediately — otherwise a deleted track's retry would
// keep ticking for up to the 60s cap before its re-enqueued attempt's
// guard noticed. A tag can have at most one active backoff (one lookup
// retries at a time per query), but we store a Set to be safe across the
// strict→permissive pair sharing a tag.
const backoffControllersByTag = new Map<string, Set<AbortController>>();

function registerBackoff(tag: string, controller: AbortController): void {
  let set = backoffControllersByTag.get(tag);
  if (!set) {
    set = new Set();
    backoffControllersByTag.set(tag, set);
  }
  set.add(controller);
}

function unregisterBackoff(tag: string, controller: AbortController): void {
  const set = backoffControllersByTag.get(tag);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) backoffControllersByTag.delete(tag);
}

function abortBackoffsForTag(tag: string): void {
  const set = backoffControllersByTag.get(tag);
  if (!set) return;
  for (const controller of set) controller.abort();
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
    limit: String(MB_SEARCH_LIMIT),
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

// Abortable wait used for the 503 backoff that happens OUTSIDE the queue
// slot (see runOneSearch). Unlike `sleep`, this REJECTS with
// RequestCancelledError on abort so a deletion mid-backoff surfaces
// promptly as cancellation rather than silently completing the wait.
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new RequestCancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RequestCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchWithTimeout(
  url: string,
  contactEmail: string,
  cancelSignal: AbortSignal,
): Promise<Response> {
  // The rate-limited queue serializes work — one hung request pins the
  // entire enrichment pipeline. Cap each fetch so a network stall
  // becomes a normal failure instead of a deadlock. The cancelSignal
  // is the queue-supplied AbortSignal raised by `cancelByTag` when
  // the underlying track is deleted; we compose it with the timeout
  // so either source aborts the in-flight fetch.
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SEARCH_TIMEOUT_MS);
  const forwardCancel = (): void => controller.abort();
  if (cancelSignal.aborted) {
    controller.abort();
  } else {
    cancelSignal.addEventListener("abort", forwardCancel, { once: true });
  }
  try {
    return await fetch(url, {
      headers: buildRequestHeaders(contactEmail),
      signal: controller.signal,
    });
  } catch (error) {
    // If cancellation drove the abort, propagate the AbortError so
    // the queue can translate it to RequestCancelledError. Only
    // wrap a true timeout in our user-facing timeout message.
    if (cancelSignal.aborted) throw error;
    // Translate any abort-shape error into a user-meaningful timeout.
    // `instanceof DOMException` is too narrow — fetch in some browsers
    // (Safari, some polyfills) throws an Error subclass with
    // name="AbortError" that isn't a DOMException. Checking the name
    // alone is the portable test. Also catches the raw "signal is
    // aborted without reason" message that surfaces when an Error
    // shape we don't expect carries the abort.
    const message = error instanceof Error ? error.message : String(error);
    const isAbort =
      timedOut ||
      (error instanceof Error && error.name === "AbortError") ||
      message.includes("aborted");
    if (isAbort) {
      throw new Error(
        `MusicBrainz request timed out after ${Math.round(
          SEARCH_TIMEOUT_MS / 1000,
        )}s — try again later`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    cancelSignal.removeEventListener("abort", forwardCancel);
  }
}

// Result of a single in-slot attempt. A 503 we want to retry returns
// `{ retryAfterMs }` instead of throwing so the BACKOFF can happen
// outside the queue slot — see runOneSearch.
type AttemptResult =
  | { kind: "done"; candidates: MBCandidate[] }
  | { kind: "retry"; retryAfterMs: number };

async function runOneAttempt(
  url: string,
  contactEmail: string,
  canRetry: boolean,
  signal: AbortSignal,
): Promise<AttemptResult> {
  const response = await fetchWithTimeout(url, contactEmail, signal);

  if (response.status === SERVICE_UNAVAILABLE_STATUS) {
    // MB asks for a backoff via Retry-After. Honor it once, then
    // give up so the user sees a clear error rather than the queue
    // stalling indefinitely on a wedged upstream. Clamp locally —
    // a misconfigured upstream advertising Retry-After: 86400
    // would otherwise pin the head of the MB queue (and every
    // queued track behind it) for a day.
    if (!canRetry) {
      throw new Error(`MusicBrainz unavailable (503) — try again later`);
    }
    const parsedRetryMs = tryParseRetryAfterMs(
      response.headers.get("Retry-After"),
    );
    const retryAfterMs = Math.min(
      parsedRetryMs ?? MB_503_DEFAULT_RETRY_MS,
      MB_RETRY_AFTER_CAP_MS,
    );
    return { kind: "retry", retryAfterMs };
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
    return { kind: "done", candidates: recordings.map(recordingToCandidate) };
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

async function runOneSearch(
  query: string,
  contactEmail: string,
  dismax: boolean,
  tag: string | undefined,
  guard: (() => boolean) | undefined,
): Promise<MBCandidate[]> {
  const url = buildSearchUrl(query, contactEmail, dismax);
  // 503-retry is driven HERE, across enqueue boundaries — NOT inside a
  // single slot. The old design slept the Retry-After (up to the 60s
  // cap) inside the one in-flight queue slot, re-introducing the exact
  // head-of-line stall the 1-req/sec pacer exists to avoid: a single
  // lookup that hit a 60s Retry-After pinned the only slot for a full
  // minute and blocked every other queued track. By releasing the slot
  // between attempts and doing the backoff out-of-slot, other tracks
  // keep draining at the normal rate interval while this lookup waits
  // for its retry window.
  let attempts = 0;
  while (true) {
    const canRetry = attempts < MAX_503_RETRIES;
    const result = await queue.enqueue<AttemptResult>(
      (signal) => runOneAttempt(url, contactEmail, canRetry, signal),
      { tag, guard },
    );
    if (result.kind === "done") return result.candidates;
    // 503 with a retry budget: back off OUTSIDE the slot, then
    // re-enqueue. The slot is free during the wait so the queue keeps
    // pacing other tracks.
    attempts++;
    console.warn(
      `MusicBrainz 503 — waiting ${Math.round(result.retryAfterMs / 1000)}s before retry`,
    );
    // Cancellation during the out-of-slot wait: a deletion that fires
    // `cancelMusicbrainzRequestsByTag(tag)` aborts the backoff timer
    // immediately (via the tag registry), so a cancelled track's retry
    // does not keep ticking for up to the 60s cap. A flipped guard is
    // also re-checked here before burning the retry window.
    if (guard && !guard()) throw new RequestCancelledError();
    const controller = new AbortController();
    if (tag !== undefined) registerBackoff(tag, controller);
    try {
      // Rejects with RequestCancelledError on abort, so cancellation
      // surfaces promptly rather than only on the next loop iteration.
      await abortableDelay(result.retryAfterMs, controller.signal);
    } finally {
      if (tag !== undefined) unregisterBackoff(tag, controller);
    }
  }
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
  // Lucene → dismax: produce a free-token bag from the strict query so
  // MB's dismax parser can tokenize loosely (catches "Lovesponge" vs
  // "Love Sponge"). The strict query is `field:"value" AND field:"value"`,
  // so the title/artist text lives inside the quoted segments. Pull
  // those out verbatim rather than regex-stripping field prefixes — a
  // blind `\w+:` strip also eats a colon INSIDE a value (a title like
  // `Song: The Remix` would lose "Song", since the strip can't tell a
  // real field prefix from quoted content).
  const withoutEscapes = strictQuery.replace(LUCENE_ESCAPE_PAIR, "");
  const quotedValues = [...withoutEscapes.matchAll(/"([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.trim().length > 0);
  if (quotedValues.length > 0) {
    return quotedValues.join(" ").replace(/\s+/g, " ").trim();
  }
  // Bareword fallback: no quoted clauses (e.g. a hand-built unquoted
  // query). Strip field prefixes and the clause-joining AND directly.
  return withoutEscapes
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
  // Abort any out-of-slot 503 backoff for this tag too — those waits
  // live outside the queue, so cancelByTag alone wouldn't reach them.
  abortBackoffsForTag(tag);
  return queue.cancelByTag(tag);
}

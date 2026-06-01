// Three-state circuit breaker for the Spotify API.
//
// State machine:
//
//          ┌──────────┐
//          │  closed  │  (openUntil === 0)
//          │ traffic  │
//          │  flows   │
//          └────┬─────┘
//               │ trip() — typically on a 429
//               ▼
//          ┌──────────┐
//          │   open   │  (now < openUntil)
//          │   fail-  │
//          │  fast    │
//          └────┬─────┘
//               │ now reaches openUntil → half-open
//               ▼
//          ┌──────────┐
//          │ half-open│
//          │ ONE probe│
//          │ allowed  │
//          └─┬──────┬─┘
//   probe ok │      │ probe still 429
//            ▼      ▼
//        closed   open (new openUntil)
//
// Without the half-open phase, a queue of N concurrent calls all
// flood through the moment the timer elapses; if Spotify still wants
// us to wait, every one of them earns a fresh 429 and the penalty
// compounds. The probe gives us a single canary request to verify
// the ban lifted before we let the herd through.
//
// Exponential backoff on consecutive trips: Spotify hides Retry-After
// behind CORS (no Access-Control-Expose-Headers), so a multi-hour ban
// reaches the breaker as the 10-min default fallback (see
// DEFAULT_RETRY_AFTER_SECONDS in apiClient.ts). Without escalation, the
// breaker would probe every 10 min for the entire ban — each probe a
// fresh violation Spotify counts (incidents observed defaults
// compounding into ~23h bans this way). Each trip since the last
// successful close doubles the open window:
//
//   trip #1: retryMs * 1     (typically 10 min)
//   trip #2: retryMs * 2     (20 min)
//   trip #3: retryMs * 4     (40 min)
//   trip #4: retryMs * 8     (80 min)
//   trip #5: retryMs * 16    (160 min)
//   …capped at 2^6 = 64× (~10.6h from the 10-min default), and again
//    by maxOpenMs (12h).
//
// A successful probe (`close()`) resets the count. The breaker's own
// state (open-until timestamp + escalation count — NOT any OAuth token;
// tokens live in sessionStorage, see tokenStorage.ts) is persisted to
// localStorage so a page refresh DURING an active open window honors
// both the window AND the escalation count — Spotify enforces the
// penalty per app (client_id), not per tab, so a fresh tab that started
// over at trip #1 would probe back into the ban. Crucially, the count
// is only carried across reload while the window is still in the future;
// once it has fully elapsed the escalation memory is stale (see the
// constructor) and is dropped, so a lone transient 429 after a long idle
// can't be treated as trip #(n+1) and escalate straight to hours.
//
// KNOWN LIMITATION — wall-clock dependence: every timing decision uses
// Date.now() (required, since the open window is persisted to localStorage
// and must survive a reload, which a monotonic clock can't). A backward
// system-clock/NTP correction therefore extends an open window; a forward
// jump can lift it early or admit the half-open probe prematurely. There is
// no monotonic fallback by design; the worst case is a mis-timed probe,
// which the half-open single-canary logic still contains.

import {
  SPOTIFY_CIRCUIT_FAILURE_COUNT_KEY,
  SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY,
} from "../constants";

// Cap the exponent so a hostile or buggy counter can't overflow the
// duration computation. 2^6 = 64× the fallback (~10.6h from the 10-min
// DEFAULT_RETRY_AFTER_SECONDS default), which combined with the maxOpenMs
// cap (12h) is plenty to ride out any realistic ban.
const MAX_BACKOFF_EXPONENT = 6;

// Cap a corrupt/stale persisted counter. If localStorage carries a
// nonsense value we'd otherwise extend pauses indefinitely.
const MAX_PERSISTED_FAILURE_COUNT = MAX_BACKOFF_EXPONENT + 1;

export type CircuitBreakerOptions = {
  minOpenMs: number;
  maxOpenMs: number;
};

export type CircuitSlot = "pass" | "probe" | "fail-fast";

export class CircuitBreaker {
  private openUntil: number;
  private probeInFlight = false;
  private consecutiveFailures: number;

  constructor(private readonly options: CircuitBreakerOptions) {
    const now = Date.now();
    const rawOpenUntil = readPersistedTimestamp(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY);

    if (rawOpenUntil !== null && rawOpenUntil > now) {
      // Window still active: honor it (capped) and keep escalating across
      // the reload — Spotify enforces the penalty per app, so a fresh tab
      // must not restart at trip #1 mid-ban.
      this.openUntil = Math.min(rawOpenUntil, now + options.maxOpenMs);
      this.consecutiveFailures = readPersistedFailureCount();
    } else {
      // Window already closed. We MUST keep the escalation count while the
      // ban is still being discovered — a multi-hour ban reaches us as the
      // 10-min default, so we ride it out by re-escalating across reloads
      // even after each window elapses (covered by rateLimit.test.ts).
      // BUT a count that's been idle a long time is stale: resuming a
      // days-old escalation on a single transient 429 would jump straight
      // to hours. Keep the count only if the window closed within one
      // max-open window; beyond that, decay to trip #1.
      this.openUntil = 0;
      const closedRecently =
        rawOpenUntil !== null && now - rawOpenUntil < options.maxOpenMs;
      if (closedRecently) {
        this.consecutiveFailures = readPersistedFailureCount();
      } else {
        this.consecutiveFailures = 0;
        persistFailureCount(0);
      }
    }
  }

  /** ms until the breaker closes, 0 if already closed. */
  remainingMs(): number {
    return Math.max(0, this.openUntil - Date.now());
  }

  /**
   * Attempt to acquire a slot for a new request:
   *   - "pass"     — circuit closed, proceed normally
   *   - "probe"    — half-open, this caller is the canary
   *   - "fail-fast"— open (or probe already in flight)
   *
   * `tryAcquire` is synchronous because there's no waiting in this
   * state machine — open is open, the caller decides what to do.
   */
  tryAcquire(): CircuitSlot {
    const now = Date.now();
    if (this.openUntil === 0) return "pass";
    if (now < this.openUntil) return "fail-fast";
    if (this.probeInFlight) return "fail-fast";
    this.probeInFlight = true;
    return "probe";
  }

  /** Called when the probe call settles (success or rejection). */
  releaseProbe(): void {
    this.probeInFlight = false;
  }

  /**
   * Half-open = the open window has elapsed but the breaker hasn't been
   * closed by a successful probe yet (openUntil is a real past timestamp,
   * not the closed sentinel 0). Distinguishes "closed" from "recovering"
   * for callers that traverse the breaker without going through
   * tryAcquire (the token-refresh lane), which must know whether a
   * successful pass should itself close the circuit.
   */
  isHalfOpen(): boolean {
    return this.openUntil !== 0 && Date.now() >= this.openUntil;
  }

  /** Whether a half-open probe slot is currently held by an API submission. */
  isProbeInFlight(): boolean {
    return this.probeInFlight;
  }

  /**
   * Trip the breaker for the given Retry-After window. The actual
   * open duration is `retryMs * 2^(consecutiveFailures - 1)` so each
   * repeated trip doubles the wait — Spotify hides Retry-After via
   * CORS, so we discover the real ban only by watching probes still
   * 429. Clamped to [minOpenMs, maxOpenMs]: minimum keeps a "1s"
   * Retry-After from leaving us essentially open, maximum bounds a
   * corrupt or hostile response.
   */
  trip(retryMs: number): void {
    this.consecutiveFailures = Math.min(
      this.consecutiveFailures + 1,
      MAX_PERSISTED_FAILURE_COUNT,
    );
    const exponent = Math.min(
      this.consecutiveFailures - 1,
      MAX_BACKOFF_EXPONENT,
    );
    const escalated = retryMs * 2 ** exponent;
    const cooloff = Math.max(escalated, this.options.minOpenMs);
    this.openUntil = Date.now() + Math.min(cooloff, this.options.maxOpenMs);
    persistFutureTimestamp(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY, this.openUntil);
    persistFailureCount(this.consecutiveFailures);
  }

  /** Successful probe: fully close. Resets the escalation counter. */
  close(): void {
    this.openUntil = 0;
    this.consecutiveFailures = 0;
    persistFutureTimestamp(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY, 0);
    persistFailureCount(0);
  }

  /** Manual reset (Settings → "Reset rate-limit"). */
  reset(): void {
    this.close();
    this.probeInFlight = false;
  }
}

// Read the raw persisted timestamp (does NOT zero out an expired value —
// the constructor needs to know HOW stale a closed window is to decide
// whether the escalation count has decayed). Returns null when absent or
// unparseable.
function readPersistedTimestamp(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistFutureTimestamp(key: string, timestamp: number): void {
  try {
    if (timestamp <= Date.now()) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, String(timestamp));
    }
  } catch {
    // best-effort
  }
}

function readPersistedFailureCount(): number {
  try {
    const raw = localStorage.getItem(SPOTIFY_CIRCUIT_FAILURE_COUNT_KEY);
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.min(parsed, MAX_PERSISTED_FAILURE_COUNT);
  } catch {
    return 0;
  }
}

function persistFailureCount(count: number): void {
  try {
    if (count <= 0) {
      localStorage.removeItem(SPOTIFY_CIRCUIT_FAILURE_COUNT_KEY);
    } else {
      localStorage.setItem(SPOTIFY_CIRCUIT_FAILURE_COUNT_KEY, String(count));
    }
  } catch {
    // best-effort
  }
}

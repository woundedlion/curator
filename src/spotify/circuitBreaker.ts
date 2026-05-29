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
// reaches the breaker as the 5-min default fallback. Without
// escalation, the breaker would probe every 5 min for the entire ban
// — each probe a fresh violation Spotify counts (incidents observed
// 5-min defaults compounding into ~12h bans this way). Each trip
// since the last successful close doubles the open window:
//
//   trip #1: retryMs * 1     (typically 5 min)
//   trip #2: retryMs * 2     (10 min)
//   trip #3: retryMs * 4     (20 min)
//   trip #4: retryMs * 8     (40 min)
//   trip #5: retryMs * 16    (80 min → cap)
//
// A successful probe (`close()`) resets the count. State is persisted
// to localStorage so a page refresh honors both the open window AND
// the escalation count — Spotify enforces the penalty per app
// (client_id), not per tab, so a fresh tab that started over at trip
// #1 would probe back into the ban.

import {
  SPOTIFY_CIRCUIT_FAILURE_COUNT_KEY,
  SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY,
} from "../constants";

// Cap the exponent so a hostile or buggy counter can't overflow the
// duration computation. 2^6 = 64× the fallback (~5h from 5-min default),
// which combined with the maxOpenMs cap is plenty to ride out any
// realistic ban.
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
    this.openUntil = readPersistedFutureTimestamp(
      SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY,
      options.maxOpenMs,
    );
    this.consecutiveFailures = readPersistedFailureCount();
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

function readPersistedFutureTimestamp(key: string, capMs: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= Date.now()) return 0;
    return Math.min(parsed, Date.now() + capMs);
  } catch {
    return 0;
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

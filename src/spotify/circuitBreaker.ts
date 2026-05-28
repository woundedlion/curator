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
// State is persisted to localStorage so a page refresh honors the
// open window — Spotify enforces the penalty per app (client_id),
// not per tab, so a fresh tab that ignored the in-flight penalty
// would immediately re-burn the quota.

import { SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY } from "../constants";

export type CircuitBreakerOptions = {
  minOpenMs: number;
  maxOpenMs: number;
};

export type CircuitSlot = "pass" | "probe" | "fail-fast";

export class CircuitBreaker {
  private openUntil: number;
  private probeInFlight = false;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.openUntil = readPersistedFutureTimestamp(
      SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY,
      options.maxOpenMs,
    );
  }

  /** ms until the breaker closes, 0 if already closed. */
  remainingMs(): number {
    return Math.max(0, this.openUntil - Date.now());
  }

  /** True when the breaker is open and no probe is in flight either. */
  isOpenAndIdle(): boolean {
    return this.openUntil > 0 && !this.probeInFlight;
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
   * open duration is clamped to [minOpenMs, maxOpenMs] — minimum
   * keeps a "1s" Retry-After from leaving us essentially open,
   * maximum bounds a corrupt or hostile response.
   */
  trip(retryMs: number): void {
    const cooloff = Math.max(retryMs, this.options.minOpenMs);
    this.openUntil = Date.now() + Math.min(cooloff, this.options.maxOpenMs);
    persistFutureTimestamp(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY, this.openUntil);
  }

  /** Successful probe: fully close. */
  close(): void {
    this.openUntil = 0;
    persistFutureTimestamp(SPOTIFY_CIRCUIT_OPEN_UNTIL_KEY, 0);
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

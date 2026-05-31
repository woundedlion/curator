// Tests for the sessionStorage token codec. sessionStorage is user-writable
// (devtools) and can carry a stale shape from an older app version, so
// readTokens must reject anything that isn't a well-formed SpotifyTokens
// rather than handing a half-shaped object to the refresh path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKENS_STORAGE_KEY } from "../constants";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

vi.stubGlobal("sessionStorage", new MemoryStorage());

import { clearTokens, readTokens, writeTokens } from "./tokenStorage";
import type { SpotifyTokens } from "../types";

const VALID: SpotifyTokens = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 1_700_000_000_000,
  scope: "playlist-read-private",
};

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("tokenStorage", () => {
  it("round-trips a well-formed token bundle", () => {
    writeTokens(VALID);
    expect(readTokens()).toEqual(VALID);
  });

  it("returns null when nothing is stored", () => {
    expect(readTokens()).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    sessionStorage.setItem(TOKENS_STORAGE_KEY, "{not json");
    expect(readTokens()).toBeNull();
  });

  it("rejects a structurally-wrong object (missing fields)", () => {
    sessionStorage.setItem(TOKENS_STORAGE_KEY, JSON.stringify({}));
    expect(readTokens()).toBeNull();
  });

  it("rejects a bundle with a non-finite expiresAt (would compute NaN freshness)", () => {
    sessionStorage.setItem(
      TOKENS_STORAGE_KEY,
      JSON.stringify({ ...VALID, expiresAt: "soon" }),
    );
    expect(readTokens()).toBeNull();
  });

  it("rejects a bundle with a non-string refreshToken", () => {
    sessionStorage.setItem(
      TOKENS_STORAGE_KEY,
      JSON.stringify({ ...VALID, refreshToken: null }),
    );
    expect(readTokens()).toBeNull();
  });

  it("clearTokens removes the entry", () => {
    writeTokens(VALID);
    clearTokens();
    expect(readTokens()).toBeNull();
  });
});

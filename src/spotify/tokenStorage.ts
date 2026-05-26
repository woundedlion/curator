import { TOKENS_STORAGE_KEY } from "../constants";
import type { SpotifyTokens } from "../types";

export function readTokens(): SpotifyTokens | null {
  const raw = sessionStorage.getItem(TOKENS_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SpotifyTokens;
  } catch {
    return null;
  }
}

export function writeTokens(tokens: SpotifyTokens): void {
  sessionStorage.setItem(TOKENS_STORAGE_KEY, JSON.stringify(tokens));
}

export function clearTokens(): void {
  sessionStorage.removeItem(TOKENS_STORAGE_KEY);
}

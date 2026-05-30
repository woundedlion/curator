// @vitest-environment happy-dom
//
// The persistence-failure tests exercise localStorage (Storage.prototype
// spies, DOMException) and rely on `window` being defined so persistSettings
// actually attempts the write rather than early-returning — both require a
// DOM environment.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCEPT_MB,
  DEFAULT_ACCEPT_SPOTIFY_HIGH,
} from "../constants";
import { sanitizeSettings } from "./settingsStore";

describe("sanitizeSettings", () => {
  it("returns defaults for non-object input", () => {
    const s = sanitizeSettings(null);
    expect(s.recursiveFolderScan).toBe(true);
    expect(s.preferFullPlayback).toBe(false);
    expect(s.acceptThresholds.mb).toBe(DEFAULT_ACCEPT_MB);
    expect(s.acceptThresholds.spotify).toBe(DEFAULT_ACCEPT_SPOTIFY_HIGH);
    expect(s.musicbrainzContact).toBe("");
  });

  it("returns defaults for primitive / array input", () => {
    expect(sanitizeSettings(7).recursiveFolderScan).toBe(true);
    expect(sanitizeSettings("hello").recursiveFolderScan).toBe(true);
    expect(sanitizeSettings([1, 2, 3]).recursiveFolderScan).toBe(true);
  });

  it("clamps acceptThresholds to [0, 1]", () => {
    const s = sanitizeSettings({
      acceptThresholds: { mb: 9, spotify: -2 },
    });
    expect(s.acceptThresholds.mb).toBe(1);
    expect(s.acceptThresholds.spotify).toBe(0);
  });

  it("rejects NaN / non-finite thresholds in favor of defaults", () => {
    const s = sanitizeSettings({
      acceptThresholds: { mb: Number.NaN, spotify: Number.POSITIVE_INFINITY },
    });
    expect(s.acceptThresholds.mb).toBe(DEFAULT_ACCEPT_MB);
    expect(s.acceptThresholds.spotify).toBe(DEFAULT_ACCEPT_SPOTIFY_HIGH);
  });

  it("rejects non-numeric thresholds in favor of defaults", () => {
    const s = sanitizeSettings({
      acceptThresholds: { mb: "0.9", spotify: true },
    });
    expect(s.acceptThresholds.mb).toBe(DEFAULT_ACCEPT_MB);
    expect(s.acceptThresholds.spotify).toBe(DEFAULT_ACCEPT_SPOTIFY_HIGH);
  });

  it("preserves valid string and boolean fields", () => {
    const s = sanitizeSettings({
      spotifyClientId: "abc",
      spotifyRedirectUri: "https://example.test/",
      recursiveFolderScan: false,
      musicbrainzContact: "me@example.test",
      preferFullPlayback: true,
      acceptThresholds: { mb: 0.4, spotify: 0.8 },
    });
    expect(s.spotifyClientId).toBe("abc");
    expect(s.spotifyRedirectUri).toBe("https://example.test/");
    expect(s.recursiveFolderScan).toBe(false);
    expect(s.musicbrainzContact).toBe("me@example.test");
    expect(s.preferFullPlayback).toBe(true);
    expect(s.acceptThresholds).toEqual({ mb: 0.4, spotify: 0.8 });
  });

  it("rejects wrong-type fields in favor of defaults", () => {
    const s = sanitizeSettings({
      spotifyClientId: 42,
      spotifyRedirectUri: 0,
      recursiveFolderScan: "true",
      musicbrainzContact: 123,
      preferFullPlayback: 1,
    });
    expect(s.spotifyClientId).toBeUndefined();
    // Default redirect URI is whatever the store's default is — just confirm
    // we don't return the bogus `0`.
    expect(typeof s.spotifyRedirectUri).toBe("string");
    expect(s.recursiveFolderScan).toBe(true);
    expect(s.musicbrainzContact).toBe("");
    expect(s.preferFullPlayback).toBe(false);
  });

  it("treats a missing acceptThresholds object as defaults", () => {
    const s = sanitizeSettings({});
    expect(s.acceptThresholds.mb).toBe(DEFAULT_ACCEPT_MB);
    expect(s.acceptThresholds.spotify).toBe(DEFAULT_ACCEPT_SPOTIFY_HIGH);
  });

  it("treats a non-object acceptThresholds as defaults", () => {
    const s = sanitizeSettings({ acceptThresholds: "0.9" });
    expect(s.acceptThresholds.mb).toBe(DEFAULT_ACCEPT_MB);
    expect(s.acceptThresholds.spotify).toBe(DEFAULT_ACCEPT_SPOTIFY_HIGH);
  });
});

describe("useSettingsStore.update persistence failures", () => {
  // The notify-once latch in persistNotifications is module-level state,
  // so each test re-imports the modules fresh (vi.resetModules) to start
  // from an un-latched baseline. We pull both the settings store and the
  // UI store from the SAME freshly-loaded module graph so the toast the
  // notifier pushes lands in the store instance we assert against.
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The two behaviors (commit-despite-failure, and warn-only-once) are
  // asserted in a SINGLE test because the warn-once latch lives in
  // module-level state in persistNotifications. vi.resetModules() reloads
  // the settings/ui modules but the persistNotifications latch is aliased
  // across the freshly-imported graphs in a way resetModules doesn't
  // reliably clear, so splitting these into two tests let the first test's
  // latch leak into the second. Asserting both within one module graph and
  // one failing-write sequence is unambiguous and order-independent.
  it("never throws, always commits in-memory, and warns exactly once across repeated failed writes", async () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });

    const { useSettingsStore } = await import("./settingsStore");
    const { useUiStore } = await import("./uiStore");

    // Each write throws inside persistSettings, but update() must swallow
    // it so the call never rejects...
    expect(() =>
      useSettingsStore.getState().update({ musicbrainzContact: "a" }),
    ).not.toThrow();
    useSettingsStore.getState().update({ musicbrainzContact: "b" });
    useSettingsStore.getState().update({ preferFullPlayback: true });

    // ...and every patch still lands in memory despite the failed writes.
    expect(useSettingsStore.getState().settings.musicbrainzContact).toBe("b");
    expect(useSettingsStore.getState().settings.preferFullPlayback).toBe(true);
    // The failing write was actually attempted.
    expect(setItemSpy).toHaveBeenCalled();
    // The user was warned exactly once, not once per failed write.
    const errors = useUiStore
      .getState()
      .toasts.filter((t) => t.kind === "error");
    expect(errors.length).toBe(1);
  });
});

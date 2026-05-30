// @vitest-environment happy-dom
//
// SettingsDialog previously had no tests. Covers the open/closed gate, the
// settings-store write-through for the text/checkbox fields, the Connect
// flow (clears auto-reconnect suppression + begins auth), the connected
// Disconnect action, and the Clear-cache confirm gating. beginAuthFlow,
// clearMusicbrainzCache, and clearAutoReconnectSuppression are mocked (real
// redirect / IDB / sessionStorage side effects); the stores are real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as AuthFlowModule from "../spotify/authFlow";

vi.mock("../spotify/authFlow", async () => {
  const actual = await vi.importActual<typeof AuthFlowModule>(
    "../spotify/authFlow",
  );
  return { ...actual, beginAuthFlow: vi.fn(async () => undefined) };
});
vi.mock("../db/musicbrainzCache", () => ({
  clearMusicbrainzCache: vi.fn(async () => undefined),
}));
vi.mock("../services/spotifyBootstrap", () => ({
  clearAutoReconnectSuppression: vi.fn(),
}));

import { SettingsDialog } from "./SettingsDialog";
import { beginAuthFlow } from "../spotify/authFlow";
import { clearMusicbrainzCache } from "../db/musicbrainzCache";
import { clearAutoReconnectSuppression } from "../services/spotifyBootstrap";
import { useSettingsStore } from "../store/settingsStore";
import { useSpotifyStore } from "../store/spotifyStore";
import { useUiStore } from "../store/uiStore";

beforeEach(() => {
  useUiStore.setState({ showSettings: true });
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      spotifyClientId: undefined,
      musicbrainzContact: "",
      preferFullPlayback: false,
    },
  });
  useSpotifyStore.setState({ connected: false, user: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SettingsDialog — open/closed", () => {
  it("renders nothing when showSettings is false", () => {
    useUiStore.setState({ showSettings: false });
    const { container } = render(<SettingsDialog />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders the dialog when open", () => {
    render(<SettingsDialog />);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });
});

describe("SettingsDialog — settings write-through", () => {
  it("edits the MusicBrainz contact email", () => {
    render(<SettingsDialog />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "me@example.com" },
    });
    expect(useSettingsStore.getState().settings.musicbrainzContact).toBe(
      "me@example.com",
    );
  });

  it("edits the Spotify Client ID (empty trims to undefined)", () => {
    render(<SettingsDialog />);
    const input = screen.getByPlaceholderText("From developer.spotify.com");
    fireEvent.change(input, { target: { value: "my-client-id" } });
    expect(useSettingsStore.getState().settings.spotifyClientId).toBe(
      "my-client-id",
    );
    fireEvent.change(input, { target: { value: "   " } });
    expect(useSettingsStore.getState().settings.spotifyClientId).toBeUndefined();
  });

  it("toggles Full-track playback", () => {
    render(<SettingsDialog />);
    fireEvent.click(screen.getByLabelText(/Full-track playback/));
    expect(useSettingsStore.getState().settings.preferFullPlayback).toBe(true);
  });
});

describe("SettingsDialog — Spotify connect/disconnect", () => {
  it("Connect is disabled until a Client ID is set", () => {
    render(<SettingsDialog />);
    expect(
      (screen.getByRole("button", { name: "Connect to Spotify" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("Connect clears auto-reconnect suppression and begins the auth flow", () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, spotifyClientId: "cid" },
    });
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Connect to Spotify" }));
    expect(clearAutoReconnectSuppression).toHaveBeenCalledTimes(1);
    expect(beginAuthFlow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(beginAuthFlow).mock.calls[0]![0]).toBe("cid");
  });

  it("when connected, shows the account and Disconnect calls the store action", () => {
    const disconnect = vi.fn();
    useSpotifyStore.setState({
      connected: true,
      user: { id: "u1", displayName: "Ada" },
      disconnect,
    });
    render(<SettingsDialog />);
    expect(screen.getByText(/Connected as Ada/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsDialog — clear MusicBrainz cache", () => {
  it("clicking Clear opens a confirm; only confirming clears the cache", () => {
    render(<SettingsDialog />);
    fireEvent.click(
      screen.getByRole("button", { name: "Clear MusicBrainz cache" }),
    );
    // Confirm dialog is up but nothing cleared yet.
    expect(clearMusicbrainzCache).not.toHaveBeenCalled();
    expect(screen.getByText("Clear MusicBrainz cache?")).toBeTruthy();

    // Confirm (the danger ConfirmDialog button is labelled "Clear").
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(clearMusicbrainzCache).toHaveBeenCalledTimes(1);
  });

  it("cancelling the clear-cache confirm does nothing", () => {
    render(<SettingsDialog />);
    fireEvent.click(
      screen.getByRole("button", { name: "Clear MusicBrainz cache" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(clearMusicbrainzCache).not.toHaveBeenCalled();
    expect(screen.queryByText("Clear MusicBrainz cache?")).toBeNull();
  });
});

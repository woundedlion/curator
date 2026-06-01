// @vitest-environment happy-dom
//
// Catches the bug class my Player tests missed: the FakeBackend in
// player.test.ts sidesteps real DOM audio wiring, so an HtmlAudioBackend
// that's broken at the audio.play()/event-listener seam looks fine to
// the state-machine tests but ships broken in production.

import { afterEach, describe, expect, it, vi } from "vitest";
import { HtmlAudioBackend } from "./htmlAudioBackend";
import type { BackendEvent } from "./player";
import type { PlaybackSource } from "./playbackSource";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeBackend(): {
  backend: HtmlAudioBackend;
  audio: HTMLAudioElement;
  events: BackendEvent[];
} {
  const audio = new Audio();
  const backend = new HtmlAudioBackend(audio);
  const events: BackendEvent[] = [];
  backend.setObserver((e) => events.push(e));
  return { backend, audio, events };
}

// The backend now mints its own blob URL from the source's File inside
// load(). Stub createObjectURL so tests get a deterministic, assertable
// URL string, and spy revokeObjectURL so lifecycle tests can prove the
// backend revokes exactly the URL it minted. Pair the two so the stubbed
// URL is what flows through audio.src and back into revoke.
function stubObjectUrl(label = "blob:stub") {
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue(label);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { create, revoke };
}

function localSource(): PlaybackSource {
  return {
    kind: "local",
    file: new File(["bytes"], "song.mp3", { type: "audio/mpeg" }),
    label: "Local file",
  };
}

describe("HtmlAudioBackend — event wiring", () => {
  it("emits a {kind:'playing'} event when the audio element fires 'play'", () => {
    const { audio, events } = makeBackend();
    audio.dispatchEvent(new Event("play"));
    expect(events).toContainEqual({ kind: "playing" });
  });

  it("emits a {kind:'paused'} event when the audio element fires 'pause'", () => {
    const { audio, events } = makeBackend();
    audio.dispatchEvent(new Event("pause"));
    expect(events).toContainEqual({ kind: "paused" });
  });

  it("emits a {kind:'ended'} event when the audio element fires 'ended'", () => {
    const { audio, events } = makeBackend();
    audio.dispatchEvent(new Event("ended"));
    expect(events).toContainEqual({ kind: "ended" });
  });
});

describe("HtmlAudioBackend — load()", () => {
  it("mints a blob URL from the File, sets src, and returns true when audio.play() resolves", async () => {
    const { backend, audio } = makeBackend();
    const { create } = stubObjectUrl("blob:test");
    // happy-dom's audio.play() returns a resolved promise.
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    const ok = await backend.load(localSource());
    expect(ok).toBe(true);
    // The backend created the URL itself from the source File.
    expect(create).toHaveBeenCalledTimes(1);
    expect(audio.src).toContain("blob:test");
  });

  it("returns false when audio.play() rejects with AbortError (interrupted)", async () => {
    const { backend, audio } = makeBackend();
    stubObjectUrl("blob:x");
    vi.spyOn(audio, "play").mockRejectedValue(
      new DOMException("Aborted", "AbortError"),
    );
    const ok = await backend.load(localSource());
    expect(ok).toBe(false);
  });

  it("emits a NotAllowedError as a clear toast message and returns false", async () => {
    const { backend, audio, events } = makeBackend();
    stubObjectUrl("blob:x");
    vi.spyOn(audio, "play").mockRejectedValue(
      new DOMException("blocked", "NotAllowedError"),
    );
    const ok = await backend.load(localSource());
    expect(ok).toBe(false);
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });

  it("does NOT mint a blob URL for a spotify-preview source (uses the URL as-is)", async () => {
    const { backend, audio } = makeBackend();
    const { create } = stubObjectUrl();
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    const ok = await backend.load({
      kind: "spotify-preview",
      url: "https://p.scdn.co/x.mp3",
      label: "Spotify preview (30s)",
    });
    expect(ok).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(audio.src).toContain("https://p.scdn.co/x.mp3");
  });

  it("revokes the prior blob URL before minting a new one on a same-backend local replacement", async () => {
    // local → local in place: the old blob URL must be revoked when the
    // new src replaces it, or it leaks (the allocate-before-decision leak
    // this refactor exists to kill).
    const { backend, audio } = makeBackend();
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    await backend.load(localSource());
    await backend.load(localSource());
    expect(create).toHaveBeenCalledTimes(2);
    // The first URL was revoked when the second load replaced it.
    expect(revoke).toHaveBeenCalledWith("blob:first");
  });
});

describe("HtmlAudioBackend — stop()", () => {
  it("pauses the audio without clearing src — next load() supersedes by setting a fresh src", async () => {
    const { backend, audio } = makeBackend();
    stubObjectUrl("blob:abc");
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    await backend.load(localSource());
    expect(audio.src).toContain("blob:abc");
    await backend.stop();
    expect(audio.paused).toBe(true);
    // src is NOT cleared. Clearing it via audio.removeAttribute+load()
    // schedules an abort+error event that races with the next load()'s
    // audio.play() and causes the next play to reject with AbortError.
    // The next load() will set a fresh src; that supersedes.
    expect(audio.src).toContain("blob:abc");
  });

  it("revokes the blob URL it minted for a local file", async () => {
    // The backend owns the blob URL's lifecycle: stop() ends its use of
    // the current source, so it must revoke the URL it created in load().
    const { backend, audio } = makeBackend();
    const { revoke } = stubObjectUrl("blob:owned");
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    await backend.load(localSource());
    await backend.stop();
    expect(revoke).toHaveBeenCalledWith("blob:owned");
    // A second stop() finds nothing to revoke — no double-revoke.
    revoke.mockClear();
    await backend.stop();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("does not revoke anything for a preview source (no owned blob URL)", async () => {
    const { backend, audio } = makeBackend();
    const { revoke } = stubObjectUrl();
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    await backend.load({
      kind: "spotify-preview",
      url: "https://p.scdn.co/x.mp3",
      label: "Spotify preview (30s)",
    });
    await backend.stop();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("can be safely called when the audio has never been loaded", async () => {
    const { backend, audio } = makeBackend();
    await backend.stop();
    expect(audio.paused).toBe(true);
  });

  it("silently drops 'error' events that arrive with no MediaError attached", async () => {
    // After stop(), audio.error is null. A synthetic error event in
    // that state has no meaningful detail to surface — emitting a
    // bogus "unknown media error" toast would be noise. The listener
    // on line 103 of htmlAudioBackend.ts treats `code === undefined`
    // (the null-element case) the same as MEDIA_ERR_ABORTED: drop it.
    const { backend, audio, events } = makeBackend();
    stubObjectUrl("blob:x");
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    await backend.load(localSource());
    events.length = 0;
    await backend.stop();
    audio.dispatchEvent(new Event("error"));
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
  });
});

describe("HtmlAudioBackend — dispose() teardown (finding #4)", () => {
  it("removes the DOM listeners so post-dispose events no longer reach the observer", () => {
    const { backend, audio, events } = makeBackend();
    // Sanity: a 'play' event reaches the observer before dispose.
    audio.dispatchEvent(new Event("play"));
    expect(events).toContainEqual({ kind: "playing" });

    backend.dispose();
    events.length = 0;
    // After dispose, the same events must NOT reach the observer — the
    // listeners were detached, so a recycled <audio> element can't feed
    // a torn-down backend.
    audio.dispatchEvent(new Event("play"));
    audio.dispatchEvent(new Event("pause"));
    audio.dispatchEvent(new Event("ended"));
    expect(events).toEqual([]);
  });

  it("pauses the element and is idempotent", () => {
    const { backend, audio } = makeBackend();
    vi.spyOn(audio, "pause");
    backend.dispose();
    expect(audio.pause).toHaveBeenCalled();
    // Second call finds no bindings — must not throw.
    expect(() => backend.dispose()).not.toThrow();
  });

  it("revokes the owned blob URL on dispose so an unmount mid-playback doesn't leak", async () => {
    const { backend, audio } = makeBackend();
    const { revoke } = stubObjectUrl("blob:live");
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    await backend.load(localSource());
    backend.dispose();
    expect(revoke).toHaveBeenCalledWith("blob:live");
  });

  it("surfaces a real (non-aborted) media error via describeMediaError, drops null-error events", () => {
    // Guards finding #3's rewrite: a null audio.error early-returns; a
    // non-aborted MediaError surfaces. happy-dom has no global MediaError
    // constructor, so we stub the `error` property to drive both arms.
    const { audio, events } = makeBackend();

    // null error → dropped.
    audio.dispatchEvent(new Event("error"));
    expect(events.filter((e) => e.kind === "error")).toEqual([]);

    // A real decode error (code 3) → surfaced.
    Object.defineProperty(audio, "error", {
      configurable: true,
      get: () => ({
        code: 3,
        MEDIA_ERR_ABORTED: 1,
        MEDIA_ERR_NETWORK: 2,
        MEDIA_ERR_DECODE: 3,
        MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
      }),
    });
    audio.dispatchEvent(new Event("error"));
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });
});

describe("HtmlAudioBackend — load after stop is the critical real-world path", () => {
  it("load → stop → load works without the second load's play promise being aborted", async () => {
    const { backend, audio } = makeBackend();
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:A")
      .mockReturnValueOnce("blob:B");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);

    const okA = await backend.load(localSource());
    expect(okA).toBe(true);

    await backend.stop();

    const okB = await backend.load(localSource());
    expect(okB).toBe(true);
    expect(audio.src).toContain("blob:B");
    expect(playSpy).toHaveBeenCalledTimes(2);
  });

  it("a stale AbortError from the previous load does NOT contaminate the new load's outcome", async () => {
    // This is the regression test for the original bug: a delayed
    // AbortError from the first load was making the second load's
    // backend.load() return false, so the Player never transitioned
    // out of "loading" — UI looked like "playing doesn't work".
    const { backend, audio } = makeBackend();

    // First load: rejects with AbortError AFTER we've already started
    // the second load (simulates the real-browser race).
    let resolveAbort: (e: Error) => void = () => undefined;
    const abortPromise = new Promise<undefined>((_, reject) => {
      resolveAbort = reject;
    });
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:A")
      .mockReturnValueOnce("blob:B");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const playSpy = vi
      .spyOn(audio, "play")
      .mockReturnValueOnce(abortPromise)
      .mockResolvedValue(undefined);

    const firstLoad = backend.load(localSource());
    // Immediately stop + start a new load.
    await backend.stop();
    const secondLoad = backend.load(localSource());
    // NOW reject the first load with AbortError. The backend must
    // recognize this as a stale rejection and not propagate it as
    // the second load's outcome.
    resolveAbort(new DOMException("Aborted", "AbortError"));

    const [firstOk, secondOk] = await Promise.all([firstLoad, secondLoad]);
    expect(firstOk).toBe(false); // stale, ignored
    expect(secondOk).toBe(true); // the actual current load succeeded
    expect(playSpy).toHaveBeenCalledTimes(2);
  });
});

// @vitest-environment happy-dom
//
// Catches the bug class my Player tests missed: the FakeBackend in
// player.test.ts sidesteps real DOM audio wiring, so an HtmlAudioBackend
// that's broken at the audio.play()/event-listener seam looks fine to
// the state-machine tests but ships broken in production.

import { describe, expect, it, vi } from "vitest";
import { HtmlAudioBackend } from "./htmlAudioBackend";
import type { BackendEvent } from "./player";

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
  it("sets src and returns true when audio.play() resolves", async () => {
    const { backend, audio } = makeBackend();
    // happy-dom's audio.play() returns a resolved promise.
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    const ok = await backend.load({
      kind: "local",
      objectUrl: "blob:test",
      label: "Local file",
    });
    expect(ok).toBe(true);
    expect(audio.src).toContain("blob:test");
  });

  it("returns false when audio.play() rejects with AbortError (interrupted)", async () => {
    const { backend, audio } = makeBackend();
    vi.spyOn(audio, "play").mockRejectedValue(
      new DOMException("Aborted", "AbortError"),
    );
    const ok = await backend.load({
      kind: "local",
      objectUrl: "blob:x",
      label: "Local file",
    });
    expect(ok).toBe(false);
  });

  it("emits a NotAllowedError as a clear toast message and returns false", async () => {
    const { backend, audio, events } = makeBackend();
    vi.spyOn(audio, "play").mockRejectedValue(
      new DOMException("blocked", "NotAllowedError"),
    );
    const ok = await backend.load({
      kind: "local",
      objectUrl: "blob:x",
      label: "Local file",
    });
    expect(ok).toBe(false);
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });
});

describe("HtmlAudioBackend — stop()", () => {
  it("pauses the audio without clearing src — next load() supersedes by setting a fresh src", async () => {
    const { backend, audio } = makeBackend();
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    await backend.load({
      kind: "local",
      objectUrl: "blob:abc",
      label: "Local file",
    });
    expect(audio.src).toContain("blob:abc");
    await backend.stop();
    expect(audio.paused).toBe(true);
    // src is NOT cleared. Clearing it via audio.removeAttribute+load()
    // schedules an abort+error event that races with the next load()'s
    // audio.play() and causes the next play to reject with AbortError.
    // The next load() will set a fresh src; that supersedes.
    expect(audio.src).toContain("blob:abc");
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
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    await backend.load({
      kind: "local",
      objectUrl: "blob:x",
      label: "Local file",
    });
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
    const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);

    const okA = await backend.load({
      kind: "local",
      objectUrl: "blob:A",
      label: "Local file",
    });
    expect(okA).toBe(true);

    await backend.stop();

    const okB = await backend.load({
      kind: "local",
      objectUrl: "blob:B",
      label: "Local file",
    });
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
    const playSpy = vi
      .spyOn(audio, "play")
      .mockReturnValueOnce(abortPromise)
      .mockResolvedValue(undefined);

    const firstLoad = backend.load({
      kind: "local",
      objectUrl: "blob:A",
      label: "Local file",
    });
    // Immediately stop + start a new load.
    await backend.stop();
    const secondLoad = backend.load({
      kind: "local",
      objectUrl: "blob:B",
      label: "Local file",
    });
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

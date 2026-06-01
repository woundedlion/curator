import { DraftQuotaExceededError } from "../db/draftRepository";
import { useUiStore } from "./uiStore";

// Per-session latches. Persistence toasts can fire on every keystroke
// once writes are failing — latching once per kind means the user sees
// the warning but isn't drowned in duplicates. These are module-level
// state, so they reset to false ONLY on a full document reload (a fresh
// module evaluation) — NOT on an in-app "soft reset" (clear playlist,
// disconnect, etc.), which leaves the module instance intact. Once a
// kind has latched, that toast won't re-show again until the page is
// actually reloaded.
let quotaToastShown = false;
let genericPersistToastShown = false;
let settingsToastShown = false;

// Test-only: clear the per-session latches so a test can exercise the
// "first failure toasts" behavior in isolation without `vi.resetModules()`
// (which doesn't reliably re-evaluate this module's bindings across the
// store graph). No-ops outside test mode so production callers can't
// accidentally re-arm a toast storm.
export function __resetPersistNotificationLatchesForTests(): void {
  if (import.meta.env.MODE !== "test") return;
  quotaToastShown = false;
  genericPersistToastShown = false;
  settingsToastShown = false;
}

/**
 * Surface a draft-persist failure to the user. Quota errors get their
 * own message because the recovery path is different — the user has to
 * actively free storage (or accept the loss) rather than wait out a
 * transient hiccup. Other failures get a generic message and a console
 * trace.
 *
 * Owning this here keeps `playlistStore` from importing `useUiStore`
 * directly: persistence is a store-internal concern, but the user
 * notification surface lives in the UI store, and the boundary
 * deserves its own module rather than being threaded through the
 * playlist store's action implementations.
 */
export function notifyPersistFailure(error: unknown): void {
  if (error instanceof DraftQuotaExceededError) {
    if (quotaToastShown) return;
    quotaToastShown = true;
    useUiStore.getState().pushToast({
      kind: "error",
      message:
        "Browser storage is full — draft can't be saved. Export to .curator.txt to preserve your work.",
    });
    return;
  }
  console.error("schedulePersist: persist failed", error);
  if (genericPersistToastShown) return;
  genericPersistToastShown = true;
  useUiStore.getState().pushToast({
    kind: "error",
    message:
      "Couldn't save draft to browser storage. Recent edits may be lost on reload — export to .curator.txt to preserve your work.",
  });
}

/**
 * Surface a settings-persist failure to the user. `localStorage.setItem`
 * can throw on quota exhaustion or in Safari Private Browsing (quota
 * effectively zero); the settings store swallows the throw so the
 * in-memory commit still lands, and routes here for the notification.
 *
 * Latched once like the draft toasts above — settings writes fire on
 * every edit, and once writes are failing they'll keep failing, so a
 * single warning per session (until a full page reload re-evaluates this
 * module) keeps the user informed without spamming them. The recovery is
 * the same shape as the generic draft case: settings won't survive a
 * reload until storage is freed.
 */
export function notifySettingsPersistFailure(error: unknown): void {
  console.error("persistSettings: settings write failed", error);
  if (settingsToastShown) return;
  settingsToastShown = true;
  useUiStore.getState().pushToast({
    kind: "error",
    message:
      "Couldn't save settings to browser storage — changes may be lost on reload. Free up space and try again.",
  });
}

import { DraftQuotaExceededError } from "../db/draftRepository";
import { useUiStore } from "./uiStore";

// Per-session latches. Persistence toasts can fire on every keystroke
// once writes are failing — latching once per kind means the user sees
// the warning but isn't drowned in duplicates. The next reload resets
// these to false naturally because the module re-loads.
let quotaToastShown = false;
let genericPersistToastShown = false;

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

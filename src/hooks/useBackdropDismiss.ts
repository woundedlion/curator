import { useRef, type MouseEvent } from "react";

// Backdrop-click dismissal that survives a press-drag-release gesture.
//
// A modal that closes on the backdrop's bare `onClick` has a well-known
// footgun: when the user presses the mouse INSIDE the panel — most commonly
// to select text in an input to replace it — then drags OUTSIDE the panel
// (or off the window entirely) and releases, the browser synthesizes a
// `click` whose target is the nearest common ancestor of the press and the
// release. For an in-panel press + out-of-panel release that ancestor is the
// backdrop, so the panel's `onClick` stopPropagation never sees it and the
// backdrop's handler fires — dismissing the dialog the user was editing.
//
// Guard against it by remembering whether the press STARTED on the backdrop
// itself. Only a gesture that both begins and ends on the backdrop is a
// genuine "click outside to dismiss"; a press that began inside the panel is
// never a dismiss, no matter where it's released. Spread the returned props
// onto the backdrop element (NOT the panel).
//
// The panel must NOT stopPropagation on mousedown — the backdrop's
// onMouseDown has to observe in-panel presses so it can record
// `pressStartedOnBackdrop = false` for them; a panel onClick stopPropagation
// is fine (and redundant given the target check) but mousedown must bubble.
export function useBackdropDismiss(onDismiss: () => void): {
  onMouseDown: (event: MouseEvent) => void;
  onClick: (event: MouseEvent) => void;
} {
  const pressStartedOnBackdrop = useRef(false);
  return {
    onMouseDown: (event) => {
      pressStartedOnBackdrop.current = event.target === event.currentTarget;
    },
    onClick: (event) => {
      if (event.target === event.currentTarget && pressStartedOnBackdrop.current) {
        onDismiss();
      }
    },
  };
}

import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

type FallbackRender = (args: {
  error: Error;
  retry: () => void;
}) => ReactNode;

type Props = {
  children: ReactNode;
  // Optional region-scoped fallback. When provided, a caught error renders
  // this instead of the default full-screen fallback — used by NESTED
  // boundaries (around the table, the dialog host) so a localized crash
  // blanks only that region, not the whole app. Receives `retry` so the
  // compact fallback can offer its own Continue. Omitted → the top-level
  // full-screen fallback (the app shell boundary).
  fallback?: FallbackRender;
};
type State = { error: Error | null; resetKey: number };

// Top-level boundary. Without it, any render-phase throw in a row,
// dialog, or sidebar tears the whole app down to a blank page —
// React's default — and the user loses the in-memory draft +
// selection state (the IDB-persisted state survives, but only after
// the user reloads). With it, the user gets an actionable fallback
// and can either reload or click Continue to remount the tree.
//
// Continue genuinely REMOUNTS the subtree: it bumps `resetKey`, which
// is applied as the `key` on the children wrapper below. Clearing
// `error` alone would re-render the SAME element instances, so a
// deterministic render throw would immediately re-enter the boundary
// and loop with no visible progress. Changing the key forces React to
// unmount the old subtree and build a fresh one — fresh component
// state, fresh effects — which is what lets a transient render failure
// (a stale ref read, a race that has since resolved) actually clear
// without a full page reload.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("ErrorBoundary caught a render error", error, info);
  }

  private readonly retry = (): void => {
    this.setState((prev) => ({ error: null, resetKey: prev.resetKey + 1 }));
  };

  private readonly reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error, resetKey } = this.state;
    // Wrap children in a keyed Fragment so Continue's resetKey bump
    // remounts the whole subtree (see class comment). The key is stable
    // across normal renders, so this adds no remount in the happy path.
    if (!error)
      return <Fragment key={resetKey}>{this.props.children}</Fragment>;
    // Nested boundary: render the caller's region-scoped fallback so only
    // that subtree is replaced. `retry` is the same remount path as the
    // default fallback's Continue.
    if (this.props.fallback) {
      return this.props.fallback({ error, retry: this.retry });
    }
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <h2 className="text-lg font-semibold text-failed">
          Something went wrong
        </h2>
        <p className="max-w-md text-sm text-neutral-400">
          The app hit an unexpected error. Your saved draft is still on disk and
          should reload automatically. If Continue doesn't help, reload the tab.
        </p>
        <pre className="max-w-xl overflow-x-auto rounded bg-neutral-900 p-3 text-left text-xs text-neutral-400">
          {error.message}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.retry}
            className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800"
          >
            Continue
          </button>
          <button
            type="button"
            onClick={this.reload}
            className="rounded bg-matched px-3 py-1 text-sm font-semibold text-neutral-900 hover:opacity-90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

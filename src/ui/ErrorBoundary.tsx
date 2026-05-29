import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

// Top-level boundary. Without it, any render-phase throw in a row,
// dialog, or sidebar tears the whole app down to a blank page —
// React's default — and the user loses the in-memory draft +
// selection state (the IDB-persisted state survives, but only after
// the user reloads). With it, the user gets an actionable fallback
// and can either reload or click Continue to remount the tree (the
// retry path re-renders with a fresh key, which lets a transient
// render failure resolve without a full reload).
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("ErrorBoundary caught a render error", error, info);
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  private readonly reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
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
            className="rounded bg-matched px-3 py-1 text-sm font-semibold text-black hover:opacity-90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

type IconProps = { className?: string };

const BASE_SVG_CLASS = "h-4 w-4 fill-current";

function svgClass(extra?: string): string {
  return extra ? `${BASE_SVG_CLASS} ${extra}` : BASE_SVG_CLASS;
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={svgClass(className)}
      aria-hidden
    >
      <path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm3 2v8h2v-8H9zm4 0v8h2v-8h-2z" />
    </svg>
  );
}

export function FolderAddIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={svgClass(className)} aria-hidden>
      <path d="M10 4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6zm2 6h-2v3H9v2h1v3h2v-3h1v-2h-1v-3z" />
    </svg>
  );
}

export function UndoIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={svgClass(className)} aria-hidden>
      <path d="M7 7V3L1 9l6 6v-4h6a4 4 0 0 1 0 8H8v2h5a6 6 0 0 0 0-12H7z" />
    </svg>
  );
}

export function FilterIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={svgClass(className)} aria-hidden>
      <path d="M3 5h18l-7 9v6l-4-2v-4L3 5z" />
    </svg>
  );
}

export function TreeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={svgClass(className)} aria-hidden>
      <path d="M4 4h6v4H4V4zm10 5h6v4h-6V9zm0 7h6v4h-6v-4zM7 8v4h5v2H7v3h5v2H6V8h1z" />
    </svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={svgClass(className)} aria-hidden>
      <path d="M8 5v14l11-7-11-7z" />
    </svg>
  );
}

export function PauseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={svgClass(className)} aria-hidden>
      <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
    </svg>
  );
}

export function StopIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={svgClass(className)} aria-hidden>
      <path d="M6 6h12v12H6V6z" />
    </svg>
  );
}

export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={svgClass(className)} aria-hidden>
      <path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3zM5 5h6v2H7v10h10v-4h2v6H5V5z" />
    </svg>
  );
}

export function DownloadIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={svgClass(className)} aria-hidden>
      <path d="M11 3h2v10.59l3.3-3.3 1.4 1.42L12 17.41l-5.7-5.7 1.4-1.42 3.3 3.3V3zM5 19h14v2H5v-2z" />
    </svg>
  );
}

export function CloudUploadIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={svgClass(className)} aria-hidden>
      <path d="M19.35 10.04A7.5 7.5 0 0 0 5.08 9.5 4.5 4.5 0 0 0 6 18.5h13a4 4 0 0 0 .35-7.96zM13 13v4h-2v-4H8l4-4 4 4h-3z" />
    </svg>
  );
}

// Status circle used by StatusGlyph + EnrichmentGlyph. SVG (not unicode
// `○` / `●`) so all four states — idle hollow, matched/ambiguous/missing
// filled — render at identical pixel sizes regardless of the system
// font's glyph metrics. Color is `currentColor` so the parent's
// `text-matched` / `text-ambiguous` / `text-missing` class drives it.
export function CircleGlyphIcon({
  filled,
  className,
}: IconProps & { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={svgClass(className)} aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="6"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.5}
      />
    </svg>
  );
}

export function RefreshIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={svgClass(className)} aria-hidden>
      <path d="M12 5V2L7 6l5 4V7a5 5 0 0 1 5 5 5 5 0 0 1-5 5 5 5 0 0 1-5-5H5a7 7 0 0 0 7 7 7 7 0 0 0 7-7 7 7 0 0 0-7-7z" />
    </svg>
  );
}

export function GearIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={svgClass(className)}
      aria-hidden
    >
      <path d="M19.14 12.94a7.49 7.49 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.51 7.51 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.23-1.13.55-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88L2.83 14.5a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.49.39 1.03.71 1.62.94l.36 2.54c.06.24.27.42.5.42h3.84c.23 0 .44-.18.5-.42l.36-2.54c.59-.23 1.13-.55 1.62-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
    </svg>
  );
}

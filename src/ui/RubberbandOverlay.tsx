import type { RubberbandRect } from "./useRubberbandSelection";

type Props = {
  rect: RubberbandRect | null;
};

export function RubberbandOverlay({ rect }: Props) {
  if (!rect) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-50 rounded-sm border border-matched/60 bg-matched/15"
      style={{
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }}
    />
  );
}

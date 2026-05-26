import type { MouseEventHandler, ReactNode } from "react";

type Props = {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
};

export function ToggleIconButton({ label, icon, active, onClick }: Props) {
  const tone = active ? "text-matched" : "text-neutral-500";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center bg-transparent px-2 py-1 transition-opacity hover:opacity-80 ${tone}`}
    >
      {icon}
    </button>
  );
}

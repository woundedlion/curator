import type { MouseEventHandler, ReactNode } from "react";

type Props = {
  label: string;
  icon: ReactNode;
  onClick: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  className?: string;
};

export function IconButton({
  label,
  icon,
  onClick,
  disabled,
  className,
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center bg-transparent px-2 py-1 text-base leading-none text-matched transition-opacity hover:opacity-80 disabled:opacity-30 ${className ?? ""}`}
    >
      {icon}
    </button>
  );
}

type Props = {
  size?: "sm" | "md";
  label?: string;
};

const SIZE_CLASSES = {
  sm: "h-4 w-4 border-2",
  md: "h-6 w-6 border-[3px]",
};

export function Spinner({ size = "sm", label = "Loading" }: Props) {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
      className="inline-flex items-center"
    >
      <span
        className={`inline-block animate-spin rounded-full border-neutral-600 border-t-neutral-200 ${SIZE_CLASSES[size]}`}
      />
    </span>
  );
}

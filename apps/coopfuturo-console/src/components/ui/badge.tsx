import { cn } from "@/lib/utils";

export function Badge({
  children,
  tone = "default",
  className,
}: {
  children: React.ReactNode;
  tone?: "default" | "success" | "warning" | "danger" | "info" | "muted";
  className?: string;
}) {
  const tones = {
    default: "bg-[var(--accent-dim)] text-[var(--accent)]",
    success: "bg-[var(--accent-dim)] text-[var(--success)]",
    warning: "bg-[var(--warning)]/15 text-[var(--warning)]",
    danger: "bg-[var(--danger)]/15 text-[var(--danger)]",
    info: "bg-[var(--info)]/15 text-[var(--info)]",
    muted: "bg-white/5 text-[var(--muted)]",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

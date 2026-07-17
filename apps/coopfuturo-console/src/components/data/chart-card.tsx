import { cn } from "@/lib/utils";

export function ChartCard({
  title,
  children,
  toolbar,
  footer,
  className,
  loading,
}: {
  title: string;
  children: React.ReactNode;
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  loading?: boolean;
}) {
  return (
    <section
      className={cn(
        "flex flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4",
        className
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-[var(--text)]">{title}</h3>
        {toolbar}
      </div>
      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-full w-full animate-pulse rounded-lg bg-white/5" />
        </div>
      ) : (
        <div className="min-h-0 flex-1">{children}</div>
      )}
      {footer && <div className="mt-3 border-t border-[var(--border)] pt-3 text-xs text-[var(--muted)]">{footer}</div>}
    </section>
  );
}

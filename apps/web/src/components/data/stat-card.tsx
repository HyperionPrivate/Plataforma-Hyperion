"use client";

import { motion, useMotionValue, useTransform, animate } from "motion/react";
import { useEffect } from "react";
import { Info } from "lucide-react";
import { cn, formatNumber } from "@/lib/utils";
import { slide } from "@/lib/motion";
import { Sparkline } from "@/components/charts/Sparkline";

type StatCardProps = {
  label: string;
  value: number | string;
  unit?: string;
  delta?: number;
  deltaUnit?: string;
  sparkline?: number[];
  className?: string;
  loading?: boolean;
};

function AnimatedNumber({ value }: { value: number }) {
  const mv = useMotionValue(0);
  const rounded = useTransform(mv, (v) =>
    Number.isInteger(value) ? Math.round(v).toLocaleString("es-CO") : v.toFixed(1)
  );

  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.8, ease: [0.16, 1, 0.3, 1] });
    return controls.stop;
  }, [mv, value]);

  return <motion.span className="tabular">{rounded}</motion.span>;
}

export function StatCard({
  label,
  value,
  unit = "",
  delta,
  deltaUnit = "pp",
  sparkline,
  className,
  loading,
}: StatCardProps) {
  if (loading) {
    return (
      <div className={cn("rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4", className)}>
        <div className="h-3 w-24 animate-pulse rounded bg-white/5" />
        <div className="mt-3 h-8 w-16 animate-pulse rounded bg-white/5" />
      </div>
    );
  }

  const positive = typeof delta === "number" ? delta >= 0 : true;

  return (
    <motion.div
      variants={slide}
      className={cn(
        "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:bg-[var(--surface-2)]",
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-[var(--muted)]">{label}</p>
        <Info className="size-[14px] text-[var(--muted)]" strokeWidth={1.75} aria-hidden />
      </div>
      <div className="mt-2 flex items-baseline gap-1 text-2xl font-semibold text-[var(--accent)]">
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
        {unit && <span className="text-sm text-[var(--muted)]">{unit}</span>}
      </div>
      {typeof delta === "number" && (
        <p className={cn("mt-1 text-xs", positive ? "text-[var(--success)]" : "text-[var(--danger)]")}>
          {positive ? "+" : ""}
          {delta}
          {deltaUnit ? ` ${deltaUnit}` : ""} vs. periodo anterior
        </p>
      )}
      {sparkline && sparkline.length > 0 && (
        <div className="mt-3 h-10">
          <Sparkline data={sparkline} />
        </div>
      )}
    </motion.div>
  );
}

export function formatStatDisplay(n: number) {
  return formatNumber(n);
}

"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatNumber } from "@/lib/utils";

const COLORS: Record<string, string> = {
  success: "#34D399",
  muted: "#4B5563",
  warning: "#FBBF24",
  danger: "#F87171",
  info: "#9CA3AF",
};

export function DonutChart({
  slices,
  centerLabel = "Total",
  centerValue,
}: {
  slices: { key: string; label: string; count: number; pct: number; color: string }[];
  centerLabel?: string;
  centerValue?: number;
}) {
  const total = centerValue ?? slices.reduce((a, s) => a + s.count, 0);
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative mx-auto h-44 w-44 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="count"
              nameKey="label"
              innerRadius={55}
              outerRadius={75}
              paddingAngle={2}
              isAnimationActive
              animationDuration={700}
            >
              {slices.map((s) => (
                <Cell key={s.key} fill={COLORS[s.color] || COLORS.muted} stroke="transparent" />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular text-[var(--text)]">{formatNumber(total)}</span>
          <span className="text-[10px] text-[var(--muted)]">{centerLabel}</span>
        </div>
      </div>
      <ul className="flex flex-1 flex-col gap-1.5 text-xs">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[var(--muted)]">
              <span
                className="size-2 rounded-full"
                style={{ background: COLORS[s.color] || COLORS.muted }}
              />
              {s.label}
            </span>
            <span className="tabular text-[var(--text)]">
              {formatNumber(s.count)} · {s.pct}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

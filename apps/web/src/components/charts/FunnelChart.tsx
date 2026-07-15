"use client";

import { formatNumber } from "@/lib/utils";

export function FunnelChart({
  stages,
}: {
  stages: { key: string; label: string; count: number; pct: number }[];
}) {
  const max = stages[0]?.count || 1;
  return (
    <div className="flex flex-col gap-2 py-2">
      {stages.map((s, i) => {
        const width = Math.max(28, (s.count / max) * 100);
        return (
          <div key={s.key} className="flex items-center gap-3">
            <div className="w-24 shrink-0 text-right text-xs text-[var(--muted)]">{s.label}</div>
            <div className="relative h-9 flex-1">
              <div
                className="absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center justify-center rounded-md bg-[var(--accent)]/90 text-xs font-medium text-[#0A0F0D] transition-all duration-700"
                style={{ width: `${width}%`, opacity: 1 - i * 0.08 }}
              >
                <span className="tabular px-2">
                  {formatNumber(s.count)} · {s.pct}%
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

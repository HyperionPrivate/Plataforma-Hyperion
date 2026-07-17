"use client";

import { Area, AreaChart, ResponsiveContainer } from "recharts";

export function Sparkline({ data, color = "var(--accent)" }: { data: number[]; color?: string }) {
  const chartData = data.map((v, i) => ({ i, v }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="v"
          stroke={color}
          fill="url(#sparkFill)"
          strokeWidth={1.5}
          isAnimationActive
          animationDuration={700}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

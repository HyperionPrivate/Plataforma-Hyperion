"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatNumber } from "@/lib/utils";

export function DualSeriesChart({
  data,
}: {
  data: { date: string; voz: number; whatsapp: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="vozFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
        <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
        <Tooltip
          contentStyle={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(v) => formatNumber(Number(v))}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted)" }} />
        <Area
          type="monotone"
          dataKey="voz"
          name="Voz"
          stroke="var(--accent)"
          fill="url(#vozFill)"
          strokeWidth={2}
          isAnimationActive
          animationDuration={700}
        />
        <Area
          type="monotone"
          dataKey="whatsapp"
          name="WhatsApp"
          stroke="var(--accent)"
          fill="transparent"
          strokeWidth={2}
          strokeDasharray="4 4"
          isAnimationActive
          animationDuration={700}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

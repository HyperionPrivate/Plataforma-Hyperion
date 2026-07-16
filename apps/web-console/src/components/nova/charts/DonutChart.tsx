import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatNumber } from "../../../lib/format.js";

const COLORS: Record<string, string> = {
  success: "#34D399",
  muted: "#4B5563",
  warning: "#FBBF24",
  danger: "#F87171",
  info: "#9CA3AF",
  accent: "#2f9e6e"
};

export interface DonutSlice {
  key: string;
  label: string;
  count: number;
  pct: number;
  color: string;
}

export function DonutChart({
  slices,
  centerLabel = "Total",
  centerValue
}: {
  slices: DonutSlice[];
  centerLabel?: string;
  centerValue?: number;
}) {
  const total = centerValue ?? slices.reduce((sum, slice) => sum + slice.count, 0);
  return (
    <div className="row" style={{ gap: 16, flexWrap: "wrap", alignItems: "center" }}>
      <div style={{ position: "relative", width: 176, height: 176, margin: "0 auto" }}>
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
              {slices.map((slice) => (
                <Cell key={slice.key} fill={COLORS[slice.color] || COLORS.muted} stroke="transparent" />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
        <div
          style={{
            pointerEvents: "none",
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center"
          }}
        >
          <span style={{ fontSize: 18, fontWeight: 600 }}>{formatNumber(total)}</span>
          <span className="muted tiny">{centerLabel}</span>
        </div>
      </div>
      <ul className="col" style={{ gap: 6, flex: 1, minWidth: 160, listStyle: "none", margin: 0, padding: 0 }}>
        {slices.map((slice) => (
          <li key={slice.key} className="row" style={{ justifyContent: "space-between", gap: 8, fontSize: 12 }}>
            <span className="row muted" style={{ gap: 8, alignItems: "center" }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: COLORS[slice.color] || COLORS.muted
                }}
              />
              {slice.label}
            </span>
            <span className="tabular">
              {formatNumber(slice.count)} · {slice.pct}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

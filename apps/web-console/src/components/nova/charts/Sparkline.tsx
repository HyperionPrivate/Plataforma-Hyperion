import { Area, AreaChart, ResponsiveContainer } from "recharts";

export function Sparkline({
  data,
  color = "var(--accent, #2f9e6e)",
  height = 48
}: {
  data: number[];
  color?: string;
  height?: number;
}) {
  const chartData = data.map((value, index) => ({ i: index, v: value }));
  const gradientId = `nova-spark-${Math.abs(color.split("").reduce((a, c) => a + c.charCodeAt(0), 0))}`;

  if (chartData.length === 0) {
    return <div className="muted tiny" style={{ height }}>Sin serie</div>;
  }

  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            fill={`url(#${gradientId})`}
            strokeWidth={1.5}
            isAnimationActive
            animationDuration={700}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

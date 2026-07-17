"use client";

import {
  ScatterChart as RScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ZAxis,
  ReferenceLine,
  ReferenceArea,
} from "recharts";

export type ScatterPoint = {
  x: number;
  y: number;
  z?: number;
  segment?: "renovacion" | "reactivacion";
  name?: string;
};

const SEGMENT_COLOR = {
  renovacion: "var(--accent)",
  reactivacion: "#60A5FA",
} as const;

export function ScatterChart({ data }: { data: ScatterPoint[] }) {
  const renovacion = data.filter((d) => d.segment !== "reactivacion");
  const reactivacion = data.filter((d) => d.segment === "reactivacion");

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={300}>
        <RScatterChart margin={{ top: 28, right: 12, bottom: 20, left: 4 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" />
          <ReferenceArea x1={0} x2={50} y1={50} y2={100} fill="rgba(52,211,153,0.04)" />
          <ReferenceArea x1={50} x2={100} y1={50} y2={100} fill="rgba(96,165,250,0.04)" />
          <ReferenceArea x1={0} x2={50} y1={0} y2={50} fill="rgba(255,255,255,0.02)" />
          <ReferenceArea x1={50} x2={100} y1={0} y2={50} fill="rgba(255,255,255,0.015)" />
          <ReferenceLine x={50} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" />
          <ReferenceLine y={50} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" />
          <XAxis
            type="number"
            dataKey="x"
            name="Propensión"
            domain={[0, 100]}
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            label={{ value: "Propensión →", position: "insideBottom", offset: -8, fill: "var(--muted)", fontSize: 11 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="Urgencia"
            domain={[0, 100]}
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            label={{ value: "Urgencia →", angle: -90, position: "insideLeft", fill: "var(--muted)", fontSize: 11 }}
          />
          <ZAxis type="number" dataKey="z" range={[36, 36]} />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            contentStyle={{
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value, name) => [value, name === "x" ? "Propensión" : name === "y" ? "Urgencia" : name]}
            labelFormatter={() => "Contacto"}
          />
          <Scatter
            name="Renovación"
            data={renovacion}
            fill={SEGMENT_COLOR.renovacion}
            fillOpacity={0.75}
            isAnimationActive
            animationDuration={700}
          />
          <Scatter
            name="Reactivación"
            data={reactivacion}
            fill={SEGMENT_COLOR.reactivacion}
            fillOpacity={0.75}
            isAnimationActive
            animationDuration={700}
          />
        </RScatterChart>
      </ResponsiveContainer>

      <span className="pointer-events-none absolute left-10 top-2 rounded-md border border-[var(--accent)]/40 bg-[var(--accent-dim)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
        Contactar primero
      </span>
      <span className="pointer-events-none absolute right-3 top-2 rounded-md border border-[#60A5FA]/40 bg-[#60A5FA]/15 px-2 py-0.5 text-[10px] font-medium text-[#93C5FD]">
        Programar
      </span>
      <span className="pointer-events-none absolute bottom-10 left-10 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[10px] text-[var(--muted)]">
        Nutrir
      </span>
      <span className="pointer-events-none absolute bottom-10 right-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[10px] text-[var(--muted)]">
        Baja prioridad
      </span>
    </div>
  );
}

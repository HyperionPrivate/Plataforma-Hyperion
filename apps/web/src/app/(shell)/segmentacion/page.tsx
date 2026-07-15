"use client";

import { useMemo } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/data/chart-card";
import { Badge } from "@/components/ui/badge";
import { ScatterChart, ConversionHeatmap, type ScatterPoint } from "@/components/charts";
import { toast } from "sonner";

function buildPoints(): ScatterPoint[] {
  const points: ScatterPoint[] = [];
  // Contactar primero: baja propensión, alta urgencia
  for (let i = 0; i < 10; i++) {
    points.push({
      x: 8 + (i * 4) % 38,
      y: 58 + (i * 3) % 35,
      z: 40,
      segment: i % 2 === 0 ? "renovacion" : "reactivacion",
      name: `P-${i}`,
    });
  }
  // Programar: alta propensión, alta urgencia
  for (let i = 0; i < 12; i++) {
    points.push({
      x: 55 + (i * 3) % 40,
      y: 55 + (i * 4) % 40,
      z: 40,
      segment: i % 3 === 0 ? "reactivacion" : "renovacion",
    });
  }
  // Nutrir: baja propensión, baja urgencia
  for (let i = 0; i < 9; i++) {
    points.push({
      x: 10 + (i * 4) % 35,
      y: 8 + (i * 5) % 35,
      z: 40,
      segment: "reactivacion",
    });
  }
  // Baja prioridad: alta propensión, baja urgencia
  for (let i = 0; i < 9; i++) {
    points.push({
      x: 58 + (i * 4) % 38,
      y: 10 + (i * 4) % 32,
      z: 40,
      segment: "renovacion",
    });
  }
  return points;
}

const WAVES = [
  { ola: "Ola 1", registros: 5200, score: 82, cierre: "28 jun 2025", canal: "Voz" },
  { ola: "Ola 2", registros: 4800, score: 71, cierre: "5 jul 2025", canal: "WhatsApp" },
  { ola: "Ola 3", registros: 5000, score: 64, cierre: "12 jul 2025", canal: "Voz" },
];

const RETRIES = [
  "No contesta → WhatsApp en 2h",
  "WhatsApp sin leer 24h → llamada",
  "Máximo 4 intentos · ventana 8:00–20:00",
];

const HEATMAP = {
  days: ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"],
  hours: ["8–10", "10–12", "12–14", "14–16", "16–18", "18–20"],
  values: [
    [0.35, 0.55, 0.45, 0.70, 0.85, 0.60],
    [0.40, 0.62, 0.50, 0.78, 0.88, 0.55],
    [0.38, 0.58, 0.48, 0.80, 0.82, 0.50],
    [0.42, 0.65, 0.52, 0.85, 0.90, 0.58],
    [0.36, 0.50, 0.44, 0.72, 0.75, 0.48],
    [0.22, 0.30, 0.28, 0.35, 0.32, 0.20],
    [0.15, 0.22, 0.20, 0.25, 0.22, 0.12],
  ],
};

export default function SegmentacionPage() {
  const points = useMemo(() => buildPoints(), []);
  const renovCount = points.filter((p) => p.segment !== "reactivacion").length;
  const reactCount = points.filter((p) => p.segment === "reactivacion").length;

  return (
    <div>
      <PageHeader
        title="Segmentación con IA — Base 30.000"
        subtitle="Prioriza contactos por propensión y urgencia de matrícula."
        actions={
          <Button variant="outline" onClick={() => toast.message("Re-entrenamiento simulado")}>
            Re-entrenar modelo
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Propensión vs Urgencia">
          <ScatterChart data={points} />
          <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
            <Badge tone="success">Renovación · {renovCount * 456} contactos (ej.)</Badge>
            <Badge tone="info">Reactivación · {reactCount * 420} contactos (ej.)</Badge>
          </div>
          <p className="mt-2 text-[10px] text-[var(--muted)]">
            Ejes 0–100. Líneas al 50% dividen 4 cuadrantes: Contactar primero · Programar · Nutrir ·
            Baja prioridad. Verde = Renovación, azul = Reactivación.
          </p>
        </ChartCard>

        <ChartCard title="Priorización de olas">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-[var(--muted)]">
              <tr className="border-b border-[var(--border)]">
                <th className="py-2">Ola</th>
                <th className="py-2">Registros</th>
                <th className="py-2">Score</th>
                <th className="py-2">Cierre</th>
                <th className="py-2">Canal</th>
              </tr>
            </thead>
            <tbody>
              {WAVES.map((w) => (
                <tr key={w.ola} className="border-b border-[var(--border)]/50">
                  <td className="py-2 font-medium">{w.ola}</td>
                  <td className="py-2 tabular">{w.registros.toLocaleString("es-CO")}</td>
                  <td className="py-2">
                    <Badge tone="success">{w.score}</Badge>
                  </td>
                  <td className="py-2 text-[var(--muted)]">{w.cierre}</td>
                  <td className="py-2">{w.canal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ChartCard>

        <ChartCard title="Mejor horario por perfil">
          <ConversionHeatmap
            days={HEATMAP.days}
            hours={HEATMAP.hours}
            values={HEATMAP.values}
            unitLabel="Tasa de respuesta"
          />
        </ChartCard>

        <ChartCard title="Reintentos inteligentes">
          <ul className="space-y-3">
            {RETRIES.map((r) => (
              <li
                key={r}
                className="rounded-lg border border-[var(--border)] bg-[var(--bg)]/40 px-3 py-2 text-sm"
              >
                {r}
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => toast.message("Editor de reglas (mock)")}
          >
            Editar reglas
          </Button>
        </ChartCard>
      </div>
    </div>
  );
}

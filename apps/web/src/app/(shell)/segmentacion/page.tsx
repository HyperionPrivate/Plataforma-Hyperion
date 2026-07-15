"use client";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/data/chart-card";
import { Badge } from "@/components/ui/badge";
import { ScatterChart, ConversionHeatmap, type ScatterPoint } from "@/components/charts";
import { useSegmentation } from "@/hooks/use-pulso";
import { toast } from "sonner";

export default function SegmentacionPage() {
  const { data, isLoading, isError, refetch } = useSegmentation();
  const points = (data?.points ?? []) as ScatterPoint[];
  const waves = data?.waves ?? [];
  const retries = data?.retries ?? [];
  const heatmap = data?.heatmap;
  const renovCount = points.filter((p) => p.segment !== "reactivacion").length;
  const reactCount = points.filter((p) => p.segment === "reactivacion").length;

  if (isError) {
    return (
      <div className="py-24 text-center">
        <p className="text-[var(--muted)]">No fue posible cargar segmentación.</p>
        <Button className="mt-3" onClick={() => refetch()}>
          Reintentar
        </Button>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Segmentación con IA"
        subtitle={
          isLoading
            ? "Cargando scores…"
            : `Prioriza contactos por propensión y urgencia · ${points.length} puntos`
        }
        actions={
          <Button variant="outline" onClick={() => refetch()}>
            Refrescar scores
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Propensión vs Urgencia">
          <ScatterChart data={points} />
          <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
            <Badge tone="success">Renovación · {renovCount}</Badge>
            <Badge tone="info">Reactivación · {reactCount}</Badge>
          </div>
          <p className="mt-2 text-[10px] text-[var(--muted)]">
            Ejes 0–100. Líneas al 50% dividen 4 cuadrantes: Contactar primero · Programar · Nutrir ·
            Baja prioridad.
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
              {waves.map((w: { ola: string; registros: number; score: number; cierre: string; canal: string }) => (
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
          {heatmap?.days?.length ? (
            <ConversionHeatmap
              days={heatmap.days}
              hours={heatmap.hours}
              values={heatmap.values}
              unitLabel="Tasa de respuesta"
            />
          ) : (
            <p className="text-sm text-[var(--muted)]">Sin heatmap</p>
          )}
        </ChartCard>

        <ChartCard title="Reintentos inteligentes">
          <ul className="space-y-3">
            {retries.map((r: string) => (
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
            onClick={() => toast.message("Editor de reglas: siguiente iteración")}
          >
            Editar reglas
          </Button>
        </ChartCard>
      </div>
    </div>
  );
}

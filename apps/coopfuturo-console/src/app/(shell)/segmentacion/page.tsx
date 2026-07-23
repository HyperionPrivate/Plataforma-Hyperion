"use client";

import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/data/chart-card";
import { Badge } from "@/components/ui/badge";
import { ScatterChart, ConversionHeatmap, type ScatterPoint } from "@/components/charts";
import { useSegmentation } from "@/hooks/use-nova";

export default function SegmentacionPage() {
  const { data, isLoading, isError, refetch } = useSegmentation();
  const points = (data?.points ?? []) as ScatterPoint[];
  const waves = data?.waves ?? [];
  const retries = data?.retries ?? [];
  const heatmap = data?.heatmap;
  const renovCount = points.filter((p) => p.segment !== "reactivacion").length;
  const reactCount = points.filter((p) => p.segment === "reactivacion").length;
  const empty = !isLoading && points.length === 0;

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
        title="Segmentación"
        subtitle={
          isLoading
            ? "Cargando scores…"
            : empty
              ? "Sin contactos en scoreboard"
              : `Propensión vs urgencia · ${points.length} contactos (scores demo)`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="warning">Demo</Badge>
            <Button variant="outline" onClick={() => refetch()}>
              Refrescar scores
            </Button>
            <Button asChild variant="secondary">
              <Link href="/importar">Importar contactos</Link>
            </Button>
          </div>
        }
      />

      <div className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--muted)]">
        <Badge tone="warning" className="mb-2">
          Demo · scores heurísticos
        </Badge>
        <p>
          Se llena solo con contactos importados y confirmados (commit). Crear campaña o usar Laboratorio no agrega
          puntos aquí. Los scores actuales son heurísticos de demo; olas y heatmap aún no son operativos.
        </p>
      </div>

      {empty && (
        <div className="mb-6 rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg)]/40 px-4 py-10 text-center">
          <p className="text-sm font-medium">No hay puntos para graficar</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Ve a Importar, haz Preview y luego Importar contactos válidos.
          </p>
          <Button asChild className="mt-4">
            <Link href="/importar">Ir a Importar</Link>
          </Button>
        </div>
      )}

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
          {waves.length === 0 || waves.every((w: { registros: number }) => w.registros === 0) ? (
            <p className="text-sm text-[var(--muted)]">
              Sin olas con registros. Importa contactos para estimar buckets.
            </p>
          ) : (
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
                {waves.map(
                  (w: {
                    ola: string;
                    registros: number;
                    score: number;
                    cierre: string;
                    canal: string;
                  }) => (
                    <tr key={w.ola} className="border-b border-[var(--border)]/50">
                      <td className="py-2 font-medium">{w.ola}</td>
                      <td className="py-2 tabular">{w.registros.toLocaleString("es-CO")}</td>
                      <td className="py-2">
                        <Badge tone="success">{w.score}</Badge>
                      </td>
                      <td className="py-2 text-[var(--muted)]">{w.cierre}</td>
                      <td className="py-2">{w.canal}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
          <Button
            variant="outline"
            className="mt-4"
            disabled
            title="Se cableará cuando exista batch de olas en la API"
          >
            Ejecutar olas
          </Button>
        </ChartCard>

        <ChartCard title="Mejor horario por perfil">
          {heatmap?.days?.length ? (
            <>
              <ConversionHeatmap
                days={heatmap.days}
                hours={heatmap.hours}
                values={heatmap.values}
                unitLabel="Tasa de respuesta"
              />
              <p className="mt-2 text-[10px] text-[var(--muted)]">
                Heatmap aún no usa actividad real (valores en cero / placeholder).
              </p>
            </>
          ) : (
            <p className="text-sm text-[var(--muted)]">Sin heatmap</p>
          )}
        </ChartCard>

        <ChartCard title="Reintentos inteligentes">
          {retries.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">Sin reglas cargadas.</p>
          ) : (
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
          )}
          <Button
            variant="outline"
            className="mt-4"
            disabled
            title="Editor de reglas pendiente de API final"
          >
            Editar reglas
          </Button>
          <p className="mt-2 text-[10px] text-[var(--muted)]">
            Deshabilitado · disponible con la versión final de la API
          </p>
        </ChartCard>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/data/stat-card";
import { ChartCard } from "@/components/data/chart-card";
import { ConversionHeatmap } from "@/components/charts";
import { useCampaigns } from "@/hooks/use-pulso";
import { cn, formatNumber } from "@/lib/utils";
import { Plus, Phone, MessageCircle } from "lucide-react";
import { toast } from "sonner";

const statusTone = {
  activa: "success" as const,
  completada: "muted" as const,
  en_curso: "info" as const,
};

export default function CampanasPage() {
  const { data, isLoading, isError, refetch } = useCampaigns();
  const [selectedId, setSelectedId] = useState<string>("c1");
  const [retriesOn, setRetriesOn] = useState(true);

  if (isError) {
    return (
      <div className="py-24 text-center">
        <p className="text-[var(--muted)]">No fue posible cargar las campañas.</p>
        <Button className="mt-3" onClick={() => refetch()}>
          Reintentar
        </Button>
      </div>
    );
  }

  const chips = data?.dayChips;
  const selected = data?.campaigns.find((c) => c.id === selectedId) ?? data?.campaigns[0];
  const heatmap = data?.heatmap;

  return (
    <div>
      <PageHeader
        title="Campañas"
        subtitle="Gestiona y monitorea tus campañas outbound."
        actions={
          <Button
            onClick={() =>
              toast.message("Wizard de campaña (mock)", {
                description: "Conectaremos el backend después.",
              })
            }
          >
            <Plus className="size-[18px]" strokeWidth={1.75} />
            Nueva campaña
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Llamadas hoy"
          value={chips?.llamadasHoy ?? 0}
          delta={12.4}
          deltaUnit="%"
          loading={isLoading}
        />
        <StatCard
          label="Msgs WhatsApp hoy"
          value={chips?.whatsappHoy ?? 0}
          delta={8.7}
          deltaUnit="%"
          loading={isLoading}
        />
        <StatCard
          label="Reintentos programados"
          value={chips?.reintentos ?? 0}
          delta={5.3}
          deltaUnit="%"
          loading={isLoading}
        />
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--muted)]">Ventana horaria</p>
          <p className="mt-2 text-2xl font-semibold tabular text-[var(--accent)]">
            {chips?.ventana ?? "—"}
          </p>
          <Badge tone="success" className="mt-2">
            Activa
          </Badge>
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_360px]">
        <ChartCard title="Campañas outbound">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-[var(--muted)]">
                <tr className="border-b border-[var(--border)]">
                  <th className="py-2 font-medium">Campaña</th>
                  <th className="py-2 font-medium">Segmento</th>
                  <th className="py-2 font-medium">Canal</th>
                  <th className="py-2 font-medium">Progreso</th>
                  <th className="py-2 font-medium">Conversión</th>
                  <th className="py-2 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {(data?.campaigns ?? []).map((c) => {
                  const pct = c.continuous
                    ? null
                    : Math.round((c.contacted / Math.max(c.total, 1)) * 100);
                  const active = c.id === selected?.id;
                  return (
                    <tr
                      key={c.id}
                      className={cn(
                        "cursor-pointer border-b border-[var(--border)]/60 hover:bg-[var(--surface-2)]",
                        active && "bg-[var(--accent-dim)]"
                      )}
                      onClick={() => setSelectedId(c.id)}
                    >
                      <td className="py-3 font-medium">{c.name}</td>
                      <td className="py-3 text-[var(--muted)]">{c.segment}</td>
                      <td className="py-3">
                        <span className="flex gap-1 text-[var(--accent)]">
                          {c.channels.includes("voz") && (
                            <Phone className="size-4" strokeWidth={1.75} />
                          )}
                          {c.channels.includes("whatsapp") && (
                            <MessageCircle className="size-4" strokeWidth={1.75} />
                          )}
                        </span>
                      </td>
                      <td className="py-3">
                        {pct === null ? (
                          <span className="text-[var(--muted)]">continuo</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
                              <div
                                className="h-full bg-[var(--accent)]"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="tabular text-xs text-[var(--muted)]">
                              {formatNumber(c.contacted)}/{formatNumber(c.total)}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="py-3 tabular">{c.conversion}%</td>
                      <td className="py-3">
                        <Badge tone={statusTone[c.status as keyof typeof statusTone] ?? "muted"}>
                          {c.status.replace("_", " ")}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ChartCard>

        <div className="flex flex-col gap-4">
          {selected?.ab && (
            <ChartCard title={`Detalle: ${selected.name}`}>
              <p className="mb-3 text-xs text-[var(--muted)]">A/B de guiones</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-dim)] p-3">
                  <p className="text-xs text-[var(--muted)]">Guion A</p>
                  <p className="text-xl font-semibold text-[var(--accent)]">{selected.ab.a}%</p>
                </div>
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <p className="text-xs text-[var(--muted)]">Guion B</p>
                  <p className="text-xl font-semibold">{selected.ab.b}%</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-[var(--accent)]">
                Guion {selected.ab.winner} está ganando por +{selected.ab.a - selected.ab.b} pp
              </p>
            </ChartCard>
          )}

          {heatmap && (
            <ChartCard title="Mejor franja horaria">
              <ConversionHeatmap
                days={heatmap.days}
                hours={heatmap.hours}
                values={heatmap.values}
                unitLabel={heatmap.unitLabel ?? "Conversión"}
              />
            </ChartCard>
          )}

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Reintentos inteligentes</p>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Optimiza reintentos según probabilidad de contacto.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={retriesOn}
                onClick={() => {
                  setRetriesOn((v) => !v);
                  toast.success(retriesOn ? "Reintentos desactivados" : "Reintentos activados");
                }}
                className={cn(
                  "relative h-7 w-12 shrink-0 rounded-full transition-colors",
                  retriesOn ? "bg-[var(--accent)]" : "bg-white/15"
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-6 rounded-full bg-white transition-transform",
                    retriesOn ? "left-5" : "left-0.5"
                  )}
                />
              </button>
            </div>
            <p className="mt-2 text-[10px] text-[var(--muted)]">
              {retriesOn ? "Modelo activo · Última actualización: Hoy, 07:45" : "Modelo en pausa"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

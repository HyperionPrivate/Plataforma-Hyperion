"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/data/stat-card";
import { ChartCard } from "@/components/data/chart-card";
import { GaugeChart } from "@/components/charts";
import { useHandoff } from "@/hooks/use-nova";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Filter, RefreshCw, X } from "lucide-react";
import { claimConversation } from "@/services/ops-client";

const priorityTone = {
  inmediata: "danger" as const,
  alta: "success" as const,
  media: "muted" as const,
};

export default function HandoffPage() {
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useHandoff();
  const [expanded, setExpanded] = useState<string | null>("h1");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [attending, setAttending] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<string[]>([
    "inmediata",
    "alta",
    "media",
  ]);

  async function onAttend(row: {
    id: string;
    name: string;
    conversationId?: string;
  }) {
    const cid = row.conversationId || row.id;
    setAttending(row.id);
    try {
      await claimConversation({ conversation_id: cid });
      toast.success(`Atendiendo a ${row.name}`);
      router.push(`/conversaciones?id=${encodeURIComponent(cid)}`);
    } catch (err) {
      toast.error("No se pudo atender", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setAttending(null);
    }
  }

  const queue = useMemo(() => {
    return (data?.queue ?? []).filter((row) => priorityFilter.includes(row.priority));
  }, [data?.queue, priorityFilter]);

  if (isError) {
    return (
      <div className="py-24 text-center">
        <p className="text-[var(--muted)]">No fue posible cargar la bandeja de handoff.</p>
        <Button className="mt-3" onClick={() => refetch()}>
          Reintentar
        </Button>
      </div>
    );
  }

  const kpis = data?.kpis ?? [];

  return (
    <div>
      <PageHeader
        title="Bandeja de Handoff — Asesores Coopfuturo"
        actions={
          <div className="relative flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setFiltersOpen((o) => !o)}
            >
              <Filter className="size-[18px]" strokeWidth={1.75} /> Filtros
            </Button>
            <Button variant="ghost" size="icon" aria-label="Actualizar" onClick={() => refetch()}>
              <RefreshCw className="size-[18px]" strokeWidth={1.75} />
            </Button>
            <span className="text-xs text-[var(--muted)]">Actualizado: hace 1 min</span>

            {filtersOpen && (
              <div className="absolute right-0 top-full z-20 mt-2 w-64 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium">Prioridad</p>
                  <button type="button" onClick={() => setFiltersOpen(false)} aria-label="Cerrar">
                    <X className="size-4 text-[var(--muted)]" />
                  </button>
                </div>
                {(["inmediata", "alta", "media"] as const).map((p) => (
                  <label key={p} className="mb-2 flex items-center gap-2 text-sm capitalize">
                    <input
                      type="checkbox"
                      className="accent-[var(--accent)]"
                      checked={priorityFilter.includes(p)}
                      onChange={(e) => {
                        setPriorityFilter((prev) =>
                          e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)
                        );
                      }}
                    />
                    {p}
                  </label>
                ))}
              </div>
            )}
          </div>
        }
      />

      <p className="mb-3 text-xs text-[var(--muted)]">
        La cola usa las mismas personas del módulo Conversaciones (transferidas a asesor).
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <StatCard
            key={k.id}
            label={k.label}
            value={typeof k.value === "number" ? k.value : String(k.value)}
            unit={"unit" in k ? (k as { unit?: string }).unit : undefined}
            delta={typeof k.delta === "number" ? k.delta : undefined}
            deltaUnit={k.deltaUnit}
            loading={isLoading}
          />
        ))}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_300px]">
        <ChartCard title="Cola de handoff">
          <div className="space-y-2">
            {queue.map((row) => (
              <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg)]/40">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-3 p-3 text-left text-sm"
                  onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                >
                  <Badge tone={priorityTone[row.priority as keyof typeof priorityTone]}>
                    {row.priority}
                  </Badge>
                  <span className="font-medium">{row.name}</span>
                  <span className="text-[var(--muted)]">{row.segment}</span>
                  <span className="hidden text-[var(--muted)] md:inline">{row.motivo}</span>
                  <span className="ml-auto tabular text-xs text-[var(--muted)]">{row.tiempoCola}</span>
                  <div className="h-8 w-8 shrink-0">
                    <svg viewBox="0 0 36 36" className="size-8">
                      <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
                      <circle
                        cx="18"
                        cy="18"
                        r="14"
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth="4"
                        strokeDasharray={`${(row.expedientePct / 100) * 88} 88`}
                        strokeLinecap="round"
                        transform="rotate(-90 18 18)"
                      />
                    </svg>
                  </div>
                  <button
                    type="button"
                    disabled={attending === row.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onAttend(row);
                    }}
                    className={cn(
                      "rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[#0A0F0D] hover:brightness-110 disabled:opacity-60",
                    )}
                  >
                    {attending === row.id ? "…" : "Atender"}
                  </button>
                </button>
                {expanded === row.id && row.aiSummary && (
                  <div className="border-t border-[var(--border)] px-3 py-3 text-sm">
                    <p className="mb-1 text-xs font-medium text-[var(--accent)]">Resumen IA</p>
                    <p className="text-[var(--muted)]">{row.aiSummary}</p>
                    {row.info && (
                      <ul className="mt-2 grid gap-1 text-xs text-[var(--muted)] sm:grid-cols-3">
                        <li>Universidad: {row.info.universidad}</li>
                        <li>Programa: {row.info.programa}</li>
                        <li>Canal: {row.info.canal}</li>
                      </ul>
                    )}
                  </div>
                )}
              </div>
            ))}
            {!isLoading && queue.length === 0 && (
              <p className="py-8 text-center text-sm text-[var(--muted)]">
                No hay leads con esos filtros.
              </p>
            )}
          </div>
        </ChartCard>

        <div className="flex flex-col gap-4">
          <ChartCard title="Handoffs por asesor hoy">
            <div className="space-y-2">
              {(data?.byAdvisor ?? []).map((a) => (
                <div key={a.name} className="flex items-center gap-2 text-xs">
                  <span className="w-16 text-[var(--muted)]">{a.name}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full bg-[var(--accent)]"
                      style={{ width: `${(a.count / 18) * 100}%` }}
                    />
                  </div>
                  <span className="w-6 tabular">{a.count}</span>
                </div>
              ))}
            </div>
          </ChartCard>
          <ChartCard title="Calidad de handoff">
            <GaugeChart value={data?.quality.score ?? 0} label={data?.quality.label} />
            <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
              {(data?.quality.breakdown ?? []).map((b) => (
                <li key={b.label} className="flex justify-between">
                  <span>{b.label}</span>
                  <span className="tabular text-[var(--text)]">{b.value}%</span>
                </li>
              ))}
            </ul>
          </ChartCard>
        </div>
      </div>
    </div>
  );
}

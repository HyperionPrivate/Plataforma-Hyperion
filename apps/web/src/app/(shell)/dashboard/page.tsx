"use client";

import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { Filter, RefreshCw, X } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/data/stat-card";
import { ChartCard } from "@/components/data/chart-card";
import { DualSeriesChart, FunnelChart, DonutChart } from "@/components/charts";
import { LiveFeed, type LiveEvent } from "@/components/domain/live-feed";
import { useDashboard, useLiveFeed } from "@/hooks/use-pulso";
import { stagger } from "@/lib/motion";
import { cn, formatNumber } from "@/lib/utils";
import { Phone, MessageCircle, Clock, Users, Headphones, Percent, Timer, Activity } from "lucide-react";
import { toast } from "sonner";

const OPS_ICONS = [Phone, MessageCircle, Percent, Clock, Activity, Timer, Headphones, Users];

type Filters = {
  voz: boolean;
  whatsapp: boolean;
  renovacion: boolean;
  reactivacion: boolean;
};

const DEFAULT_FILTERS: Filters = {
  voz: true,
  whatsapp: true,
  renovacion: true,
  reactivacion: true,
};

export default function DashboardPage() {
  const { data, isLoading, isError, refetch } = useDashboard();
  const seed = useMemo(
    () => (data?.liveEvents ?? []) as LiveEvent[],
    [data?.liveEvents],
  );
  const live = useLiveFeed(seed);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);

  const filtered = useMemo(() => {
    if (!data) return null;
    const channelScale =
      ((filters.voz ? 1 : 0) + (filters.whatsapp ? 1 : 0)) / 2 || 0.01;
    const segmentScale =
      (filters.renovacion ? 0.55 : 0) + (filters.reactivacion ? 0.45 : 0) || 0.01;
    const scale = Math.max(0.25, channelScale * (0.55 + segmentScale * 0.45));

    return {
      contactsByDay: data.contactsByDay.map((d) => ({
        ...d,
        voz: filters.voz ? d.voz : 0,
        whatsapp: filters.whatsapp ? d.whatsapp : 0,
      })),
      kpis: data.kpis.map((k) => ({
        ...k,
        value: typeof k.value === "number" ? Math.round(k.value * scale * 10) / 10 : k.value,
      })),
      funnelRenovacion: filters.renovacion
        ? data.funnelRenovacion
        : data.funnelRenovacion.map((s) => ({
            ...s,
            count: Math.round(s.count * 0.2),
            pct: Math.round(s.pct * 0.2 * 10) / 10,
          })),
      scale,
    };
  }, [data, filters]);

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24">
        <p className="text-[var(--muted)]">No fue posible cargar el dashboard.</p>
        <Button onClick={() => refetch()}>Reintentar</Button>
      </div>
    );
  }

  const vozTotal = filtered?.contactsByDay.reduce((a, d) => a + d.voz, 0) ?? 0;
  const waTotal = filtered?.contactsByDay.reduce((a, d) => a + d.whatsapp, 0) ?? 0;
  const activeFilters =
    Object.values(filters).filter(Boolean).length < Object.keys(DEFAULT_FILTERS).length;

  return (
    <div>
      <PageHeader
        title="Dashboard del Piloto — Coopfuturo"
        actions={
          <div className="relative flex items-center gap-2">
            <Button variant="outline" size="sm">
              19 may. – 25 may. 2025
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((o) => !o)}
            >
              <Filter className="size-[18px]" strokeWidth={1.75} />
              Filtros
              {activeFilters && (
                <span className="ml-1 size-1.5 rounded-full bg-[var(--accent)]" aria-hidden />
              )}
            </Button>
            <Button variant="ghost" size="icon" aria-label="Actualizar" onClick={() => refetch()}>
              <RefreshCw className="size-[18px]" strokeWidth={1.75} />
            </Button>

            {filtersOpen && (
              <div
                className="absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl"
                role="dialog"
                aria-label="Filtros del dashboard"
              >
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-sm font-medium">Filtros</p>
                  <button
                    type="button"
                    className="rounded p-1 text-[var(--muted)] hover:bg-[var(--surface-2)]"
                    aria-label="Cerrar filtros"
                    onClick={() => setFiltersOpen(false)}
                  >
                    <X className="size-4" strokeWidth={1.75} />
                  </button>
                </div>
                <p className="mb-2 text-xs text-[var(--muted)]">Canales</p>
                <div className="mb-3 flex flex-col gap-2">
                  {(
                    [
                      ["voz", "Voz"],
                      ["whatsapp", "WhatsApp"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={filters[key]}
                        onChange={(e) => setFilters((f) => ({ ...f, [key]: e.target.checked }))}
                        className="accent-[var(--accent)]"
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <p className="mb-2 text-xs text-[var(--muted)]">Segmentos</p>
                <div className="mb-4 flex flex-col gap-2">
                  {(
                    [
                      ["renovacion", "Renovación"],
                      ["reactivacion", "Reactivación"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={filters[key]}
                        onChange={(e) => setFilters((f) => ({ ...f, [key]: e.target.checked }))}
                        className="accent-[var(--accent)]"
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      setFiltersOpen(false);
                      toast.success("Filtros aplicados");
                    }}
                  >
                    Aplicar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setFilters(DEFAULT_FILTERS);
                      toast.message("Filtros restablecidos");
                    }}
                  >
                    Limpiar
                  </Button>
                </div>
              </div>
            )}
          </div>
        }
      />

      {activeFilters && (
        <p className="mb-3 text-xs text-[var(--accent)]">
          Vista filtrada (mock) · escala ~{Math.round((filtered?.scale ?? 1) * 100)}%
        </p>
      )}

      <motion.div
        className="grid gap-[var(--page-gap)] sm:grid-cols-2 lg:grid-cols-5"
        variants={stagger}
        initial="hidden"
        animate="show"
      >
        {isLoading || !filtered
          ? Array.from({ length: 5 }, (_, i) => (
              <StatCard key={`sk-${i}`} label="…" value={0} loading />
            ))
          : filtered.kpis.map((k) => (
              <StatCard
                key={k.id}
                label={k.label}
                value={k.value}
                unit={k.unit}
                delta={k.delta}
                deltaUnit={k.deltaUnit}
                sparkline={k.sparkline}
              />
            ))}
      </motion.div>

      <div className="mt-[var(--page-gap)] grid gap-[var(--page-gap)] xl:grid-cols-[1fr_var(--panel-right-width)]">
        <div className="grid gap-[var(--page-gap)]">
          <div className="grid gap-[var(--page-gap)] lg:grid-cols-2">
            <ChartCard
              title="Contactos por día"
              loading={isLoading}
              footer={
                filtered
                  ? `Voz ${formatNumber(vozTotal)} · WhatsApp ${formatNumber(waTotal)} · Total ${formatNumber(vozTotal + waTotal)}`
                  : undefined
              }
            >
              {filtered && <DualSeriesChart data={filtered.contactsByDay} />}
            </ChartCard>
            <ChartCard
              title="Embudo Renovación"
              loading={isLoading}
              footer={
                filtered
                  ? `Conversión total: ${filtered.funnelRenovacion.at(-1)?.pct}%`
                  : undefined
              }
            >
              {filtered && <FunnelChart stages={filtered.funnelRenovacion} />}
            </ChartCard>
          </div>

          <div className="grid gap-[var(--page-gap)] lg:grid-cols-2">
            <ChartCard title="Estados de la base" loading={isLoading} footer="Última actualización: hace 2 min.">
              {data && <DonutChart slices={data.baseStatus} centerValue={30000} />}
            </ChartCard>
            <ChartCard title="Indicadores operacionales" loading={isLoading}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(data?.ops ?? []).map((op, i) => {
                  const Icon = OPS_ICONS[i % OPS_ICONS.length];
                  return (
                    <div
                      key={op.id}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg)]/40 p-3",
                        !filters.voz && op.label.toLowerCase().includes("voz") && "opacity-40",
                        !filters.whatsapp && op.label.toLowerCase().includes("whatsapp") && "opacity-40"
                      )}
                    >
                      <Icon className="size-[18px] text-[var(--accent)]" strokeWidth={1.75} />
                      <div>
                        <p className="text-xs text-[var(--muted)]">{op.label}</p>
                        <p className="text-sm font-semibold tabular">{op.value}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ChartCard>
          </div>
        </div>

        <div className="min-h-[420px]">
          <LiveFeed events={live} />
        </div>
      </div>
    </div>
  );
}

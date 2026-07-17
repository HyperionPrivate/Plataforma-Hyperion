"use client";

import { StatCard } from "@/components/data/stat-card";
import { ChartCard } from "@/components/data/chart-card";
import { DualSeriesChart, FunnelChart, DonutChart, GaugeChart, Sparkline } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";

export default function DevKitPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] p-8 text-[var(--text)]">
      <PageHeader title="Design kit" subtitle="/dev/kit — componentes PULSO" />
      <div className="mb-6 flex flex-wrap gap-2">
        <Button>Primario</Button>
        <Button variant="secondary">Secundario</Button>
        <Button variant="outline">Outline</Button>
        <Badge tone="success">Activa</Badge>
        <Badge tone="danger">Inmediata</Badge>
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Contactabilidad" value={62} unit="%" delta={6.3} sparkline={[40, 45, 50, 55, 58, 60, 62]} />
        <ChartCard title="Sparkline">
          <div className="h-16">
            <Sparkline data={[10, 20, 15, 30, 25, 40, 35]} />
          </div>
        </ChartCard>
        <GaugeChart value={88} label="Calidad" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Dual series">
          <DualSeriesChart
            data={[
              { date: "Lun", voz: 100, whatsapp: 80 },
              { date: "Mar", voz: 120, whatsapp: 90 },
              { date: "Mié", voz: 90, whatsapp: 110 },
            ]}
          />
        </ChartCard>
        <ChartCard title="Funnel">
          <FunnelChart
            stages={[
              { key: "a", label: "Contactado", count: 100, pct: 100 },
              { key: "b", label: "Interesado", count: 40, pct: 40 },
              { key: "c", label: "Cerrado", count: 12, pct: 12 },
            ]}
          />
        </ChartCard>
        <ChartCard title="Donut">
          <DonutChart
            slices={[
              { key: "a", label: "A", count: 40, pct: 40, color: "success" },
              { key: "b", label: "B", count: 35, pct: 35, color: "muted" },
              { key: "c", label: "C", count: 25, pct: 25, color: "warning" },
            ]}
          />
        </ChartCard>
      </div>
    </div>
  );
}

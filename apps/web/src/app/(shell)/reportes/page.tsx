"use client";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/data/chart-card";
import { toast } from "sonner";
import { FileSpreadsheet, FileText } from "lucide-react";

const TEMPLATES = [
  { id: "semanal", name: "Semanal piloto", desc: "KPIs + embudo + CSAT del periodo" },
  { id: "funnel", name: "Funnel Renovación", desc: "Conversión por etapa" },
  { id: "asesores", name: "Productividad asesores", desc: "SLA y cierres por asesor" },
  { id: "cumplimiento", name: "Cumplimiento", desc: "Opt-out, ventana, tipificaciones" },
];

export default function ReportesPage() {
  return (
    <div>
      <PageHeader
        title="Reportes"
        subtitle="Exporta lo que el dashboard muestra en vivo."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {TEMPLATES.map((t) => (
          <ChartCard key={t.id} title={t.name}>
            <p className="mb-4 text-sm text-[var(--muted)]">{t.desc}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => toast.success("Exportación Excel lista (mock)")}
              >
                <FileSpreadsheet className="size-[18px]" strokeWidth={1.75} />
                Excel
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => toast.message("PDF pendiente de backend", { description: "Stub listo para conectar." })}
              >
                <FileText className="size-[18px]" strokeWidth={1.75} />
                PDF
              </Button>
            </div>
          </ChartCard>
        ))}
      </div>
    </div>
  );
}

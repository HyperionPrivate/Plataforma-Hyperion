"use client";

import { useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/data/chart-card";
import { toast } from "sonner";
import { FileSpreadsheet, FileJson } from "lucide-react";
import { fetchReport } from "@/services/ops-client";

const TEMPLATES = [
  { id: "semanal", name: "Semanal piloto", desc: "KPIs + embudo + ops del store" },
  { id: "funnel", name: "Funnel Renovación", desc: "Conversión por etapa" },
  { id: "asesores", name: "Productividad asesores", desc: "Handoffs y claims" },
  { id: "cumplimiento", name: "Cumplimiento", desc: "Ventana, dispatches, tipificaciones" },
];

function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function flattenForCsv(obj: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (obj === null || obj === undefined) {
    out[prefix || "value"] = "";
    return out;
  }
  if (typeof obj !== "object") {
    out[prefix || "value"] = String(obj);
    return out;
  }
  if (Array.isArray(obj)) {
    out[prefix || "items"] = JSON.stringify(obj);
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") {
      Object.assign(out, flattenForCsv(v, key));
    } else {
      out[key] = v === null || v === undefined ? "" : String(v);
    }
  }
  return out;
}

export default function ReportesPage() {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function exportReport(id: string, format: "json" | "csv") {
    setBusyId(id);
    try {
      const res = await fetchReport(id);
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === "json") {
        downloadBlob(
          `nova-coopfuturo-${id}-${stamp}.json`,
          JSON.stringify(res.report, null, 2),
          "application/json",
        );
        toast.success("JSON descargado", { description: id });
      } else {
        const flat = flattenForCsv(res.report);
        const headers = Object.keys(flat);
        const row = headers.map((h) => `"${String(flat[h]).replace(/"/g, '""')}"`).join(",");
        downloadBlob(
          `nova-coopfuturo-${id}-${stamp}.csv`,
          `${headers.join(",")}\n${row}\n`,
          "text/csv;charset=utf-8",
        );
        toast.success("CSV descargado", { description: id });
      }
    } catch (err) {
      toast.error("No se pudo exportar", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Reportes"
        subtitle="Exporta KPIs y ops desde pilot-core (JSON / CSV)."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {TEMPLATES.map((t) => (
          <ChartCard key={t.id} title={t.name}>
            <p className="mb-4 text-sm text-[var(--muted)]">{t.desc}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busyId === t.id}
                onClick={() => exportReport(t.id, "csv")}
              >
                <FileSpreadsheet className="size-[18px]" strokeWidth={1.75} />
                CSV
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busyId === t.id}
                onClick={() => exportReport(t.id, "json")}
              >
                <FileJson className="size-[18px]" strokeWidth={1.75} />
                JSON
              </Button>
            </div>
          </ChartCard>
        ))}
      </div>
    </div>
  );
}

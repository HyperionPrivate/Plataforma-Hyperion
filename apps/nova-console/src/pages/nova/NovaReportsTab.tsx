import { useState } from "react";
import { Card, CardHead } from "../../components/ui.js";
import type { AnalyticsDailyRow, CampaignRow, DashboardSummary, HandoffRow, LeadRow } from "./types.js";

const TEMPLATES = [
  { id: "dashboard", name: "Dashboard KPIs", desc: "Resumen de contactos, campañas y colas" },
  { id: "funnel", name: "Funnel CRM", desc: "Conteos por etapa de leads" },
  { id: "analytics", name: "Analytics diario", desc: "Serie nova/analytics/daily" },
  { id: "asesores", name: "Handoffs / asesores", desc: "Cola y claims por sede" },
  { id: "campanas", name: "Campañas", desc: "Listado de campañas y estados" }
] as const;

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
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      Object.assign(out, flattenForCsv(value, path));
    } else {
      out[path] = value === null || value === undefined ? "" : String(value);
    }
  }
  return out;
}

export function NovaReportsTab({
  dashboard,
  analytics,
  leads,
  handoffs,
  campaigns
}: {
  dashboard?: DashboardSummary;
  analytics: AnalyticsDailyRow[];
  leads: LeadRow[];
  handoffs: HandoffRow[];
  campaigns: CampaignRow[];
}) {
  const [busyId, setBusyId] = useState<string>();

  function buildReport(id: (typeof TEMPLATES)[number]["id"]) {
    switch (id) {
      case "dashboard":
        return { generated_at: new Date().toISOString(), dashboard: dashboard ?? {} };
      case "funnel": {
        const stages: Record<string, number> = {};
        for (const lead of leads) {
          stages[lead.stage] = (stages[lead.stage] ?? 0) + 1;
        }
        return { generated_at: new Date().toISOString(), stages, leads_total: leads.length };
      }
      case "analytics":
        return { generated_at: new Date().toISOString(), rows: analytics };
      case "asesores":
        return { generated_at: new Date().toISOString(), handoffs };
      case "campanas":
        return { generated_at: new Date().toISOString(), campaigns };
      default:
        return {};
    }
  }

  function exportReport(id: (typeof TEMPLATES)[number]["id"], format: "json" | "csv") {
    setBusyId(id);
    try {
      const report = buildReport(id);
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === "json") {
        downloadBlob(`nova-${id}-${stamp}.json`, JSON.stringify(report, null, 2), "application/json");
      } else {
        const flat = flattenForCsv(report);
        const headers = Object.keys(flat);
        const row = headers.map((h) => `"${String(flat[h]).replace(/"/g, '""')}"`).join(",");
        downloadBlob(`nova-${id}-${stamp}.csv`, `${headers.join(",")}\n${row}\n`, "text/csv;charset=utf-8");
      }
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
      {TEMPLATES.map((template) => (
        <Card key={template.id}>
          <CardHead title={template.name} />
          <p className="muted tiny" style={{ marginBottom: 12 }}>
            {template.desc}
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn btn-sm"
              type="button"
              disabled={busyId === template.id}
              onClick={() => exportReport(template.id, "json")}
            >
              JSON
            </button>
            <button
              className="btn btn-sm"
              type="button"
              disabled={busyId === template.id}
              onClick={() => exportReport(template.id, "csv")}
            >
              CSV
            </button>
          </div>
        </Card>
      ))}
    </div>
  );
}

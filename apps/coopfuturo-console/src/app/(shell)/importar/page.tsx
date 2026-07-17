"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChartCard } from "@/components/data/chart-card";
import { StatCard } from "@/components/data/stat-card";
import { importContacts } from "@/services/ops-client";
import { Upload } from "lucide-react";
import { toast } from "sonner";

const FIELD_OPTIONS = [
  { key: "phone", label: "Teléfono (E.164)" },
  { key: "nombre", label: "Nombre" },
  { key: "segmento", label: "Segmento" },
  { key: "ignore", label: "Ignorar" },
] as const;

type PreviewRow = {
  phone?: string;
  first_name?: string;
  segment?: string;
  valid?: boolean;
  errors?: string[];
};

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (cols[i] ?? "").trim();
    });
    return row;
  });
  return { headers, rows };
}

function guessMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers) {
    const low = h.toLowerCase();
    if (/(phone|tel|celular|movil|móvil)/.test(low)) map[h] = "phone";
    else if (/(nombre|name|first)/.test(low)) map[h] = "nombre";
    else if (/(segment|flujo|tipo)/.test(low)) map[h] = "segmento";
    else map[h] = "ignore";
  }
  return map;
}

export default function ImportarContactosPage() {
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [lastPreview, setLastPreview] = useState<{
    valid?: number;
    invalid?: number;
    total?: number;
    committed?: number;
  } | null>(null);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);

  const mappedRows = useMemo(() => {
    return rawRows.map((row) => {
      const out: Record<string, string> = {};
      for (const [col, target] of Object.entries(mapping)) {
        if (target === "ignore") continue;
        out[target] = row[col] ?? "";
      }
      return out;
    });
  }, [rawRows, mapping]);

  async function onFile(file: File | null) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
      toast.error("Por ahora solo CSV", { description: "XLSX queda para una próxima iteración" });
      return;
    }
    const text = await file.text();
    const { headers: h, rows } = parseCsv(text);
    setFileName(file.name);
    setHeaders(h);
    setRawRows(rows);
    setMapping(guessMap(h));
    setLastPreview(null);
    setPreviewRows([]);
    toast.message("Archivo cargado", { description: `${rows.length} filas` });
  }

  async function runImport(commit: boolean) {
    if (!mappedRows.length) {
      toast.error("Carga un CSV primero");
      return;
    }
    setBusy(true);
    try {
      const res = await importContacts(mappedRows, commit);
      setLastPreview({
        valid: res.valid,
        invalid: res.invalid,
        total: res.total,
        committed: res.committed,
      });
      if (Array.isArray(res.rows)) {
        setPreviewRows(res.rows as PreviewRow[]);
      }
      toast.success(commit ? "Contactos importados" : "Preview listo", {
        description: commit
          ? `committed=${res.committed ?? 0} · ve a Segmentación`
          : `valid=${res.valid ?? 0} invalid=${res.invalid ?? 0}`,
      });
    } catch (err) {
      toast.error("Falló el import", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  const tableRows: PreviewRow[] =
    previewRows.length > 0
      ? previewRows.slice(0, 12)
      : mappedRows.slice(0, 8).map((r) => ({
          phone: r.phone,
          first_name: r.nombre,
          segment: r.segmento,
        }));

  return (
    <div>
      <PageHeader
        title="Importar contactos"
        subtitle="CSV → mapeo → preview → commit. Eso es lo que alimenta Segmentación."
        actions={
          <Button asChild variant="outline">
            <Link href="/segmentacion">Ver Segmentación</Link>
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Archivo">
          <div className="space-y-3 p-1">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg)] px-6 py-10 text-center hover:border-[var(--accent)]/40">
              <Upload className="size-8 text-[var(--accent)]" strokeWidth={1.5} />
              <span className="text-sm font-medium">Arrastra o selecciona CSV</span>
              <span className="text-xs text-[var(--muted)]">
                Solo CSV por ahora · teléfono en E.164 (+57…)
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              />
            </label>
            {fileName ? (
              <p className="text-xs text-[var(--muted)]">
                Archivo: <span className="text-[var(--text)]">{fileName}</span> · {rawRows.length}{" "}
                filas
              </p>
            ) : null}
          </div>
        </ChartCard>

        <ChartCard title="Mapeo de campos">
          <div className="space-y-2 p-1">
            {!headers.length ? (
              <p className="text-sm text-[var(--muted)]">Carga un archivo para mapear columnas.</p>
            ) : (
              headers.map((h) => (
                <label key={h} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-mono text-xs text-[var(--muted)]">{h}</span>
                  <select
                    className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
                    value={mapping[h] ?? "ignore"}
                    onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}
                  >
                    {FIELD_OPTIONS.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))
            )}
          </div>
        </ChartCard>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <StatCard label="Filas" value={rawRows.length} />
        <StatCard label="Válidos (último preview)" value={lastPreview?.valid ?? "—"} />
        <StatCard label="Inválidos" value={lastPreview?.invalid ?? "—"} />
      </div>

      <ChartCard title="Vista previa" className="mt-4">
        <div className="overflow-x-auto p-1">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-[var(--muted)]">
              <tr className="border-b border-[var(--border)]">
                <th className="py-2">phone</th>
                <th className="py-2">nombre</th>
                <th className="py-2">segmento</th>
                <th className="py-2">estado</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r, i) => {
                const invalid = r.valid === false;
                return (
                  <tr
                    key={i}
                    className={
                      invalid
                        ? "border-b border-[var(--border)]/60 bg-[var(--danger)]/5"
                        : "border-b border-[var(--border)]/60"
                    }
                  >
                    <td className="py-2 font-mono text-xs">{r.phone || "—"}</td>
                    <td className="py-2">{r.first_name || "—"}</td>
                    <td className="py-2">
                      {r.segment ? <Badge tone="muted">{r.segment}</Badge> : "—"}
                    </td>
                    <td className="py-2">
                      {r.valid === undefined ? (
                        <span className="text-xs text-[var(--muted)]">Sin preview</span>
                      ) : invalid ? (
                        <Badge tone="danger">{(r.errors ?? ["inválido"]).join(", ")}</Badge>
                      ) : (
                        <Badge tone="success">válido</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!tableRows.length ? (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-[var(--muted)]">
                    Sin filas
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => runImport(false)}>
            Preview
          </Button>
          <Button disabled={busy} onClick={() => runImport(true)}>
            Importar contactos válidos
          </Button>
          {lastPreview?.committed != null && lastPreview.committed > 0 ? (
            <Button asChild variant="outline">
              <Link href="/segmentacion">Ver en Segmentación</Link>
            </Button>
          ) : null}
        </div>
      </ChartCard>
    </div>
  );
}

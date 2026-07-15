"use client";

import { useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/data/chart-card";
import {
  createHandoff,
  importContacts,
  lookupAssociate,
  optOut,
  orchestrationAttempt,
  orchestrationBatch,
  registerDocument,
  sendWhatsApp,
} from "@/services/ops-client";
import { toast } from "sonner";

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (cols[i] ?? "").trim();
    });
    return row;
  });
}

export default function LaboratorioPage() {
  const [phone, setPhone] = useState("+573001112233");
  const [name, setName] = useState("Ana Demo");
  const [flow, setFlow] = useState<"A" | "B">("A");
  const [batchLimit, setBatchLimit] = useState(5);
  const [docId, setDocId] = useState("900123456");
  const [docFileName, setDocFileName] = useState("orden_matricula.pdf");
  const [waText, setWaText] = useState(
    "Hola, le saludamos de COOPFUTURO. Tiene un cupo preaprobado para renovar. ¿Conversamos?",
  );
  const [csv, setCsv] = useState(
    "phone,nombre,segmento\n+573001112233,Ana,Renovacion\n+573004445566,Luis,Reactivacion\n300,Bad,Renovacion",
  );
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string>("");

  async function onDispatch() {
    setBusy(true);
    try {
      const res = await orchestrationAttempt({ phone, first_name: name, flow });
      setLastResult(JSON.stringify(res, null, 2));
      toast.success(res.mock_commercial ? "Orquestación mock OK" : "Orquestación live OK", {
        description: String(res.dispatch?.id ?? "ok"),
      });
    } catch (err) {
      toast.error("Falló la orquestación", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onBatch() {
    setBusy(true);
    try {
      const res = await orchestrationBatch({ flow, limit: batchLimit });
      setLastResult(JSON.stringify(res, null, 2));
      toast.success("Batch terminado", {
        description: `ok=${res.sent_or_queued} bloqueados=${res.blocked} total=${res.total}`,
      });
    } catch (err) {
      toast.error("Falló el batch", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onWhatsApp() {
    setBusy(true);
    try {
      const res = await sendWhatsApp({ phone, text: waText });
      setLastResult(JSON.stringify(res, null, 2));
      toast.success("WhatsApp mock encolado", {
        description: String(res.message?.id ?? "ok"),
      });
    } catch (err) {
      toast.error("Falló WhatsApp", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onHandoff() {
    setBusy(true);
    try {
      const res = await createHandoff({
        name,
        phone,
        segment: flow === "A" ? "Renovacion" : "Reactivacion",
        motivo: "Calificado en laboratorio",
      });
      setLastResult(JSON.stringify(res, null, 2));
      toast.success("Handoff creado", { description: String(res.id) });
    } catch (err) {
      toast.error("Falló handoff", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onOptOut() {
    setBusy(true);
    try {
      const res = await optOut(phone);
      setLastResult(JSON.stringify(res, null, 2));
      toast.message("Opt-out registrado", { description: phone });
    } catch (err) {
      toast.error("Falló opt-out", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onImport(commit: boolean) {
    setBusy(true);
    try {
      const rows = parseCsv(csv);
      const res = await importContacts(rows, commit);
      setLastResult(JSON.stringify(res, null, 2));
      toast.success(commit ? "Import commit" : "Import preview", {
        description: commit
          ? `committed=${res.committed ?? 0}`
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

  async function onFile(file: File | null) {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    toast.message("CSV cargado", { description: file.name });
  }

  async function onDocument(file: File | null) {
    if (!file) return;
    setBusy(true);
    try {
      const res = await registerDocument({
        filename: file.name,
        content_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        contact_phone: phone,
        kind: "orden_matricula",
      });
      setDocFileName(file.name);
      setLastResult(JSON.stringify(res, null, 2));
      if (res.status === "validated") {
        toast.success("Documento validado (mock)", { description: res.id });
      } else {
        toast.error("Documento rechazado", {
          description: (res.errors || []).join(", ") || res.status,
        });
      }
    } catch (err) {
      toast.error("Falló registro documento", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onCoreLookup() {
    setBusy(true);
    try {
      const res = await lookupAssociate(docId);
      setLastResult(JSON.stringify(res, null, 2));
      toast.message("Core lookup (mock)", { description: docId });
    } catch (err) {
      toast.error("Falló lookup core", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Laboratorio"
        subtitle="Import, voz, batch, documentos, WhatsApp mock, handoff y opt-out contra pilot-core."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Voz · orquestación">
          <div className="space-y-3 p-1">
            <label className="block text-sm">
              Teléfono E.164
              <input
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              Nombre
              <input
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              Flujo
              <select
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                value={flow}
                onChange={(e) => setFlow(e.target.value as "A" | "B")}
              >
                <option value="A">Flujo A · Renovación</option>
                <option value="B">Flujo B · Reactivación</option>
              </select>
            </label>
            <label className="block text-sm">
              Límite batch
              <input
                type="number"
                min={1}
                max={200}
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                value={batchLimit}
                onChange={(e) => setBatchLimit(Number(e.target.value) || 1)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button onClick={onDispatch} disabled={busy}>
                Disparar llamada
              </Button>
              <Button variant="secondary" onClick={onBatch} disabled={busy}>
                Batch contactos
              </Button>
              <Button variant="secondary" onClick={onHandoff} disabled={busy}>
                Crear handoff
              </Button>
              <Button variant="outline" onClick={onOptOut} disabled={busy}>
                Opt-out
              </Button>
            </div>
          </div>
        </ChartCard>

        <ChartCard title="WhatsApp mock (LIWA pendiente)">
          <div className="space-y-3 p-1">
            <textarea
              className="min-h-28 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
              value={waText}
              onChange={(e) => setWaText(e.target.value)}
            />
            <Button onClick={onWhatsApp} disabled={busy}>
              Enviar WhatsApp mock
            </Button>
            <p className="text-xs text-[var(--muted)]">
              No usa credenciales LIWA reales. Modo mock obligatorio hasta rotación.
            </p>
          </div>
        </ChartCard>

        <ChartCard title="Import contactos CSV">
          <div className="space-y-3 p-1">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            />
            <textarea
              className="min-h-40 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-xs"
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
            />
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => onImport(false)} disabled={busy}>
                Preview
              </Button>
              <Button onClick={() => onImport(true)} disabled={busy}>
                Commit válidos
              </Button>
            </div>
          </div>
        </ChartCard>

        <ChartCard title="Documentos · validación mock">
          <div className="space-y-3 p-1">
            <p className="text-xs text-[var(--muted)]">
              PDF/JPG/PNG · máx 10 MB · antivirus mock (nombre con &quot;virus&quot; rechaza). MinIO real pendiente.
            </p>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={(e) => onDocument(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-[var(--muted)]">Último: {docFileName}</p>
            <label className="block text-sm">
              Documento ID (core stub)
              <input
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                value={docId}
                onChange={(e) => setDocId(e.target.value)}
              />
            </label>
            <Button variant="outline" onClick={onCoreLookup} disabled={busy}>
              Lookup core mock
            </Button>
          </div>
        </ChartCard>
      </div>

      {lastResult ? (
        <pre className="mt-4 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-xs">
          {lastResult}
        </pre>
      ) : null}
    </div>
  );
}

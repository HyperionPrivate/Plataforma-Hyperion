"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/data/chart-card";
import {
  completeCall,
  createHandoff,
  fetchSettings,
  fetchWhatsAppFlows,
  importContacts,
  lookupAssociate,
  optOut,
  orchestrationAttempt,
  orchestrationBatch,
  runE2ERenovacion,
  sendWhatsApp,
  uploadDocument,
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
  const [waLive, setWaLive] = useState(false);
  const [waKind, setWaKind] = useState<"flow" | "text">("flow");
  const [waFlowId, setWaFlowId] = useState("1782399915832");
  const [waFlowIdA, setWaFlowIdA] = useState("1782399915832");
  const [waFlowIdB, setWaFlowIdB] = useState("");
  const [waFlows, setWaFlows] = useState<{ id: string; name: string }[]>([]);
  const [agencyTag, setAgencyTag] = useState("RENOVACION_VIP");
  const [skipVoiceE2E, setSkipVoiceE2E] = useState(true);
  const [postIntent, setPostIntent] = useState("interesado");

  useEffect(() => {
    setAgencyTag(flow === "B" ? "REACTIVACION_VIP" : "RENOVACION_VIP");
    // Keep WhatsApp flow_id aligned with product flow A/B.
    const next = flow === "B" ? waFlowIdB || waFlowIdA : waFlowIdA;
    if (next) setWaFlowId(next);
  }, [flow, waFlowIdA, waFlowIdB]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await fetchSettings();
        if (cancelled) return;
        setWaLive(s.whatsapp?.mode === "real");
        const flowA = s.whatsapp?.default_flow_id || "1782399915832";
        const flowB = s.whatsapp?.flow_id_b || "";
        setWaFlowIdA(flowA);
        setWaFlowIdB(flowB);
        if (s.whatsapp?.default_kind === "text") setWaKind("text");
        try {
          const flows = await fetchWhatsAppFlows();
          if (!cancelled && Array.isArray(flows.items)) {
            setWaFlows(flows.items.map((f) => ({ id: String(f.id), name: f.name })));
            if (flows.default_flow_id) {
              setWaFlowIdA(String(flows.default_flow_id));
            }
          }
        } catch {
          /* ignore flows fetch */
        }
      } catch {
        /* API offline — default mock copy */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      const res = await sendWhatsApp({
        phone,
        text: waText,
        kind: waKind,
        flow_id: waKind === "flow" ? waFlowId : undefined,
        first_name: name,
      });
      setLastResult(JSON.stringify(res, null, 2));
      const live = !res.mock_commercial;
      const kindLabel = res.message?.kind === "flow" ? "flujo" : "texto";
      toast.success(live ? `WhatsApp LIWA (${kindLabel})` : "WhatsApp mock encolado", {
        description: String(res.message?.id ?? res.message?.status ?? "ok"),
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
        agency_tag: agencyTag || undefined,
      });
      setLastResult(JSON.stringify(res, null, 2));
      const liwa = res.liwa as Record<string, unknown> | undefined;
      toast.success("Handoff creado", {
        description: liwa?.synced ? `LIWA tag ${String(liwa.tag_name ?? agencyTag)}` : String(res.id),
      });
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
      const res = await uploadDocument({
        file,
        contact_phone: phone,
        kind: "orden_matricula",
      });
      setDocFileName(file.name);
      setLastResult(JSON.stringify(res, null, 2));
      if (res.status === "validated") {
        toast.success("Documento guardado", {
          description: `${res.id} · ${res.storage ?? "storage"}`,
        });
      } else {
        toast.error("Documento rechazado", {
          description: (res.errors || []).join(", ") || res.status,
        });
      }
    } catch (err) {
      toast.error("Falló upload documento", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onPostCall() {
    setBusy(true);
    try {
      const res = await completeCall({
        phone,
        first_name: name,
        intent: postIntent,
        flow,
      });
      setLastResult(JSON.stringify(res, null, 2));
      toast.success(
        res.whatsapp_sent
          ? `Post-llamada ${res.flow ?? flow} → WhatsApp`
          : `Post-llamada ${res.flow ?? flow}: ${res.intent} (sin WA)`,
        { description: res.wants_whatsapp ? "Intención continuar" : "Sin seguimiento WA" },
      );
    } catch (err) {
      toast.error("Falló post-llamada", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onE2E() {
    setBusy(true);
    try {
      // Flujo B: omit flow_id so backend uses product B (do not force A's id).
      const res = await runE2ERenovacion({
        phone,
        first_name: name,
        flow,
        skip_voice: skipVoiceE2E,
        skip_whatsapp: false,
        flow_id: flow === "B" ? waFlowIdB || undefined : waFlowId,
        agency_tag: agencyTag || undefined,
      });
      setLastResult(JSON.stringify(res, null, 2));
      const ok = res.ok !== false;
      if (ok) {
        toast.success(`E2E Flujo ${res.flow ?? flow} OK`, { description: phone });
      } else {
        toast.error(`E2E Flujo ${res.flow ?? flow} con fallos`, { description: phone });
      }
    } catch (err) {
      toast.error("Falló E2E", {
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
      toast.message(res.mock_commercial ? "Core lookup (stub)" : "Core lookup (HTTP)", {
        description: docId,
      });
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
        subtitle="Import, voz, batch, documentos, WhatsApp LIWA, handoff y opt-out contra pilot-core."
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
            <label className="block text-sm">
              Intent post-llamada
              <select
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                value={postIntent}
                onChange={(e) => setPostIntent(e.target.value)}
              >
                <option value="interesado">interesado → envía WA</option>
                <option value="renovar">renovar → envía WA (A)</option>
                <option value="reactivar">reactivar → envía WA (B)</option>
                <option value="no_interes">no_interes → sin WA</option>
                <option value="voicemail">voicemail → sin WA</option>
                <option value="unknown">unknown → sin WA</option>
              </select>
            </label>
            <Button variant="secondary" onClick={onPostCall} disabled={busy}>
              Simular post-llamada → WA
            </Button>
            <label className="block text-sm">
              Tag LIWA handoff
              <input
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                value={agencyTag}
                onChange={(e) => setAgencyTag(e.target.value)}
                placeholder="RENOVACION_VIP"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={skipVoiceE2E}
                onChange={(e) => setSkipVoiceE2E(e.target.checked)}
              />
              E2E sin llamada de voz
            </label>
            <Button onClick={onE2E} disabled={busy}>
              E2E Flujo {flow} (voz→WA→doc→handoff→CRM)
            </Button>
          </div>
        </ChartCard>

        <ChartCard title={waLive ? "WhatsApp LIWA (live)" : "WhatsApp mock"}>
          <div className="space-y-3 p-1">
            <div className="flex flex-wrap gap-2">
              <Button
                variant={waKind === "flow" ? "default" : "outline"}
                size="sm"
                onClick={() => setWaKind("flow")}
              >
                Flujo / plantilla
              </Button>
              <Button
                variant={waKind === "text" ? "default" : "outline"}
                size="sm"
                onClick={() => setWaKind("text")}
              >
                Texto (24h)
              </Button>
            </div>
            {waKind === "flow" ? (
              <select
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
                value={waFlowId}
                onChange={(e) => setWaFlowId(e.target.value)}
              >
                {(waFlows.length
                  ? waFlows
                  : [{ id: waFlowId, name: `Flujo ${waFlowId}` }]
                ).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            ) : (
              <textarea
                className="min-h-28 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
                value={waText}
                onChange={(e) => setWaText(e.target.value)}
              />
            )}
            <Button onClick={onWhatsApp} disabled={busy}>
              {waLive
                ? waKind === "flow"
                  ? "Enviar flujo LIWA"
                  : "Enviar texto LIWA"
                : "Enviar WhatsApp mock"}
            </Button>
            <p className="text-xs text-[var(--muted)]">
              {waLive
                ? waKind === "flow"
                  ? "Outbound frío: usa flujo con plantilla Meta (recomendado)."
                  : "Texto libre solo si el contacto escribió en las últimas 24h."
                : "Modo mock: define LIWA_MODE=real y LIWA_API_TOKEN en el entorno de la API."}
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

        <ChartCard title="Documentos · upload real">
          <div className="space-y-3 p-1">
            <p className="text-xs text-[var(--muted)]">
              PDF/JPG/PNG · máx 10 MB · guarda en filesystem (o MinIO si DOCUMENTS_STORAGE_BACKEND=minio).
            </p>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={(e) => onDocument(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-[var(--muted)]">Último: {docFileName}</p>
            <label className="block text-sm">
              Documento ID (core)
              <input
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                value={docId}
                onChange={(e) => setDocId(e.target.value)}
              />
            </label>
            <Button variant="outline" onClick={onCoreLookup} disabled={busy}>
              Lookup core
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

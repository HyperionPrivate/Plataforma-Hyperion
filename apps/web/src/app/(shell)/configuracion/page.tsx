"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/data/chart-card";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { fetchSettings, saveSettings } from "@/services/ops-client";

const TABS = ["Canales", "Dialer", "Agentes", "Cumplimiento", "Privacidad"];

type Channels = {
  voz_enabled: boolean;
  whatsapp_enabled: boolean;
  ventana_8_20: boolean;
  grabacion: boolean;
  identificacion: boolean;
};

type Dialer = {
  base_url: string;
  default_phone_number_id: string;
};

type AgentFlow = {
  name?: string;
  segment?: string;
  agent_id?: string;
  phone_number_id?: string;
  channel?: string;
};

export default function ConfiguracionPage() {
  const [tab, setTab] = useState("Canales");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [channels, setChannels] = useState<Channels>({
    voz_enabled: true,
    whatsapp_enabled: true,
    ventana_8_20: true,
    grabacion: true,
    identificacion: true,
  });
  const [dialer, setDialer] = useState<Dialer>({
    base_url: "",
    default_phone_number_id: "",
  });
  const [flujoA, setFlujoA] = useState<AgentFlow>({});
  const [flujoB, setFlujoB] = useState<AgentFlow>({});
  const [piiMasking, setPiiMasking] = useState(true);
  const [waMode, setWaMode] = useState<"mock" | "real">("mock");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await fetchSettings();
        if (cancelled) return;
        if (s.channels) {
          setChannels((c) => ({
            ...c,
            ...s.channels,
          }));
        }
        if (s.dialer) {
          setDialer({
            base_url: s.dialer.base_url ?? "",
            default_phone_number_id: s.dialer.default_phone_number_id ?? "",
          });
        }
        const ac = s.agent_config || {};
        if (ac.flujo_a && typeof ac.flujo_a === "object") {
          setFlujoA(ac.flujo_a as AgentFlow);
        }
        if (ac.flujo_b && typeof ac.flujo_b === "object") {
          setFlujoB(ac.flujo_b as AgentFlow);
        }
        if (s.ui && typeof s.ui.pii_masking === "boolean") {
          setPiiMasking(s.ui.pii_masking);
        }
        if (s.whatsapp?.mode === "real") setWaMode("real");
        else setWaMode("mock");
      } catch (err) {
        toast.error("No se pudo cargar configuración", {
          description: err instanceof Error ? err.message : "¿API en :8201?",
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave() {
    setSaving(true);
    try {
      await saveSettings({
        channels,
        dialer,
        agent_config: {
          flujo_a: flujoA,
          flujo_b: flujoB,
        },
        ui: { pii_masking: piiMasking },
      });
      toast.success("Configuración guardada en SQLite");
    } catch (err) {
      toast.error("No se pudo guardar", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Configuración de la plataforma"
        subtitle="Canales, dialer HTTP y agentes — persistido en pilot-core."
      />

      <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-[var(--border)] pb-3">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm",
              tab === t ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--muted)]",
            )}
          >
            {t}
          </button>
        ))}
        <div className="ml-auto">
          <Button size="sm" onClick={onSave} disabled={saving || loading}>
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--muted)]">Cargando desde /ops/settings…</p>
      ) : null}

      {tab === "Canales" && !loading && (
        <div className="grid gap-4 md:grid-cols-2">
          <ChartCard title="Canales activos">
            <ul className="space-y-4">
              {(
                [
                  ["voz_enabled", "Línea de voz"],
                  [
                    "whatsapp_enabled",
                    waMode === "real" ? "WhatsApp (LIWA live)" : "WhatsApp (mock)",
                  ],
                ] as const
              ).map(([key, label]) => (
                <li key={key} className="flex items-center justify-between gap-4">
                  <span className="text-sm">{label}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={channels[key]}
                    onClick={() => setChannels((c) => ({ ...c, [key]: !c[key] }))}
                    className={cn(
                      "relative h-6 w-11 rounded-full transition-colors",
                      channels[key] ? "bg-[var(--accent)]" : "bg-white/15",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 size-5 rounded-full bg-white transition-transform",
                        channels[key] ? "left-5" : "left-0.5",
                      )}
                    />
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-[var(--muted)]">
              {waMode === "real"
                ? "WhatsApp LIWA live activo (LIWA_MODE=real). Voz live vía ElevenLabs SIP o Dialer URL."
                : "WhatsApp en mock hasta LIWA_MODE=real + LIWA_API_TOKEN. Voz live requiere Dialer/ElevenLabs."}
            </p>
          </ChartCard>
          <ChartCard title="Estado">
            <ul className="space-y-2 text-sm text-[var(--muted)]">
              <li className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-[var(--accent)]" />
                Dialer: {dialer.base_url ? "URL configurada" : "vacío → ElevenLabs SIP / mock"}
              </li>
              <li className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-[var(--accent)]" />
                WhatsApp: {waMode === "real" ? "LIWA live" : "modo mock"}
              </li>
              <li className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-[var(--accent)]" />
                Auth: deshabilitada en development
              </li>
            </ul>
          </ChartCard>
        </div>
      )}

      {tab === "Dialer" && !loading && (
        <ChartCard title="Microservicio dialer">
          <div className="space-y-3 p-1">
            <label className="block text-sm">
              Base URL (vacío = orquestación mock)
              <input
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-sm"
                placeholder="http://127.0.0.1:8080"
                value={dialer.base_url}
                onChange={(e) => setDialer((d) => ({ ...d, base_url: e.target.value }))}
              />
            </label>
            <label className="block text-sm">
              Phone number ID por defecto
              <input
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-sm"
                value={dialer.default_phone_number_id}
                onChange={(e) =>
                  setDialer((d) => ({ ...d, default_phone_number_id: e.target.value }))
                }
              />
            </label>
            <p className="text-xs text-[var(--muted)]">
              Al guardar, pilot-core hace hot-patch y llama{" "}
              <code className="text-[var(--accent)]">POST /internal/dialer/calls/dispatch</code> si
              hay URL.
            </p>
          </div>
        </ChartCard>
      )}

      {tab === "Agentes" && !loading && (
        <div className="grid gap-4 lg:grid-cols-2">
          {(
            [
              ["Flujo A · Renovación", flujoA, setFlujoA],
              ["Flujo B · Reactivación", flujoB, setFlujoB],
            ] as const
          ).map(([title, flow, setFlow]) => (
            <ChartCard
              key={title}
              title={title}
              toolbar={<Badge tone="muted">{flow.segment || "—"}</Badge>}
            >
              <div className="space-y-3">
                <label className="block text-sm">
                  Nombre
                  <input
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                    value={flow.name ?? ""}
                    onChange={(e) => setFlow({ ...flow, name: e.target.value })}
                  />
                </label>
                <label className="block text-sm">
                  Agent ID (ElevenLabs)
                  <input
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-xs"
                    value={flow.agent_id ?? ""}
                    onChange={(e) => setFlow({ ...flow, agent_id: e.target.value })}
                  />
                </label>
                <label className="block text-sm">
                  Phone number ID
                  <input
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-xs"
                    value={flow.phone_number_id ?? ""}
                    onChange={(e) => setFlow({ ...flow, phone_number_id: e.target.value })}
                  />
                </label>
              </div>
            </ChartCard>
          ))}
        </div>
      )}

      {tab === "Cumplimiento" && !loading && (
        <ChartCard title="Ley 1581 — Habeas Data">
          <ul className="space-y-4">
            {(
              [
                ["ventana_8_20", "Ventana horaria 8:00–20:00 COT"],
                ["grabacion", "Grabación y trazabilidad"],
                ["identificacion", "Identificación como asistente virtual"],
              ] as const
            ).map(([key, label]) => (
              <li key={key} className="flex items-center justify-between gap-4">
                <span className="text-sm">{label}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={channels[key]}
                  onClick={() => setChannels((c) => ({ ...c, [key]: !c[key] }))}
                  className={cn(
                    "relative h-6 w-11 rounded-full transition-colors",
                    channels[key] ? "bg-[var(--accent)]" : "bg-white/15",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 size-5 rounded-full bg-white transition-transform",
                      channels[key] ? "left-5" : "left-0.5",
                    )}
                  />
                </button>
              </li>
            ))}
            <li className="flex items-center justify-between text-sm">
              <span>Lista de exclusión (opt-out)</span>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    const { listOptOuts } = await import("@/services/ops-client");
                    const res = await listOptOuts();
                    toast.message(`${res.total} números en exclusión`, {
                      description: res.items.slice(0, 5).join(", ") || "vacía",
                    });
                  } catch (err) {
                    toast.error("No se pudo cargar opt-outs", {
                      description: err instanceof Error ? err.message : "Error",
                    });
                  }
                }}
              >
                Ver lista
              </Button>
            </li>
          </ul>
          <p className="mt-4 text-xs text-[var(--muted)]">
            Desactivar la ventana permite orquestar fuera de 8–20 (solo demo local). Opt-outs
            persisten en SQLite.
          </p>
        </ChartCard>
      )}

      {tab === "Privacidad" && !loading && (
        <ChartCard title="Enmascarado de PII">
          <ul className="space-y-4">
            <li className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm">Enmascarar PII en lecturas Ops</p>
                <p className="text-xs text-[var(--muted)]">
                  Teléfonos, cédulas y nombres en GET /ops (CRM, handoff, conversaciones,
                  contactos). Laboratorio sigue usando valores crudos para pruebas.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={piiMasking}
                onClick={() => setPiiMasking((v) => !v)}
                className={cn(
                  "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                  piiMasking ? "bg-[var(--accent)]" : "bg-white/15",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-5 rounded-full bg-white transition-transform",
                    piiMasking ? "left-5" : "left-0.5",
                  )}
                />
              </button>
            </li>
          </ul>
        </ChartCard>
      )}
    </div>
  );
}

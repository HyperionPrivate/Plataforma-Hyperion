"use client";

import { useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChartCard } from "@/components/data/chart-card";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const TABS = ["Canales", "Guiones", "Usuarios y roles", "Cumplimiento"];

export default function ConfiguracionPage() {
  const [tab, setTab] = useState("Canales");
  const [toggles, setToggles] = useState({
    ventana: true,
    grabacion: true,
    identificacion: true,
  });

  return (
    <div>
      <PageHeader title="Configuración de la plataforma" subtitle="Canales, guiones y cumplimiento Ley 1581" />

      <div className="mb-6 flex flex-wrap gap-2 border-b border-[var(--border)] pb-3">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm",
              tab === t ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--muted)]"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Canales" && (
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { title: "Línea de voz", lines: ["Troncal conectada", "12 líneas simultáneas", "Estado: Operativa"] },
            { title: "WhatsApp Business", lines: ["Línea verificada", "Calidad: Alta", "Plantillas aprobadas: 8/10"] },
            { title: "Motor de voz", lines: ["Latencia promedio: 380 ms", "Voz: Femenina Valentina", "Idioma: es-CO"] },
          ].map((c) => (
            <ChartCard key={c.title} title={c.title}>
              <ul className="space-y-2 text-sm text-[var(--muted)]">
                {c.lines.map((l) => (
                  <li key={l} className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full bg-[var(--accent)]" />
                    {l}
                  </li>
                ))}
              </ul>
            </ChartCard>
          ))}
        </div>
      )}

      {tab === "Guiones" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard
            title="Guion activo — Renovación v2"
            toolbar={<Badge tone="success">Activo</Badge>}
          >
            <pre className="max-h-64 overflow-auto rounded-lg bg-[var(--bg)] p-3 font-mono text-xs text-[var(--muted)]">
{`# Personality
Eres asesora de COOPFUTURO.
Hablas con {{nombre}} de {{universidad}}.

# Goal
Anunciar cupo preaprobado y pedir orden de matrícula.`}
            </pre>
            <div className="mt-2 flex flex-wrap gap-1">
              {["{{nombre}}", "{{universidad}}", "{{cupo}}"].map((v) => (
                <Badge key={v} tone="muted">
                  {v}
                </Badge>
              ))}
            </div>
            <Button className="mt-3" size="sm" onClick={() => toast.success("Cambios del guion guardados")}>
              Guardar cambios
            </Button>
          </ChartCard>
          <ChartCard title="Historial de versiones">
            <ul className="space-y-3 text-sm">
              {["v2 · Hoy 09:42 · Cambios menores", "v1 · Ayer · Aprobación Coopfuturo", "v0 · Borrador inicial"].map(
                (v) => (
                  <li key={v} className="border-l-2 border-[var(--accent)] pl-3 text-[var(--muted)]">
                    {v}
                  </li>
                )
              )}
            </ul>
          </ChartCard>
        </div>
      )}

      {tab === "Usuarios y roles" && (
        <ChartCard title="Usuarios">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-[var(--muted)]">
              <tr className="border-b border-[var(--border)]">
                <th className="py-2">Nombre</th>
                <th className="py-2">Rol</th>
                <th className="py-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Admin Coopfuturo", "Administrador", "Activo"],
                ["Laura Mendoza", "Asesor", "Activo"],
                ["Carlos Restrepo", "Supervisor", "Activo"],
              ].map(([n, r, e]) => (
                <tr key={n} className="border-b border-[var(--border)]/50">
                  <td className="py-2">{n}</td>
                  <td className="py-2 text-[var(--muted)]">{r}</td>
                  <td className="py-2">
                    <Badge tone="success">{e}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ChartCard>
      )}

      {tab === "Cumplimiento" && (
        <ChartCard title="Ley 1581 de 2012 — Habeas Data">
          <ul className="space-y-4">
            {(
              [
                ["ventana", "Ventana horaria 8:00–20:00"],
                ["grabacion", "Grabación y trazabilidad"],
                ["identificacion", "Identificación como asistente virtual"],
              ] as const
            ).map(([key, label]) => (
              <li key={key} className="flex items-center justify-between gap-4">
                <span className="text-sm">{label}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={toggles[key]}
                  onClick={() => setToggles((t) => ({ ...t, [key]: !t[key] }))}
                  className={cn(
                    "relative h-6 w-11 rounded-full transition-colors",
                    toggles[key] ? "bg-[var(--accent)]" : "bg-white/15"
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 size-5 rounded-full bg-white transition-transform",
                      toggles[key] ? "left-5" : "left-0.5"
                    )}
                  />
                </button>
              </li>
            ))}
            <li className="flex items-center justify-between text-sm">
              <span>Lista de exclusión</span>
              <Button variant="outline" size="sm" onClick={() => toast.message("214 números en exclusión")}>
                214 números
              </Button>
            </li>
          </ul>
        </ChartCard>
      )}
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChartCard } from "@/components/data/chart-card";
import { createCampaign } from "@/services/ops-client";
import { cn } from "@/lib/utils";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";

const STEPS = [
  "Información básica",
  "Audiencia",
  "Canales",
  "Guion y reintentos",
  "Revisar y lanzar",
] as const;

export default function NuevaCampanaPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("VIP Renovación · II Temporada");
  const [flow, setFlow] = useState<"A" | "B">("A");
  const [total, setTotal] = useState(500);
  const [segmentFilter, setSegmentFilter] = useState("score>=70");
  const [channelVoz, setChannelVoz] = useState(true);
  const [channelWa, setChannelWa] = useState(true);
  const [retries, setRetries] = useState(2);
  const [scriptNote, setScriptNote] = useState(
    "Saludo CoopFuturo → cupo preaprobado → agendar o enviar WhatsApp.",
  );

  const segment = flow === "A" ? "Renovacion" : "Reactivacion";
  const channels = useMemo(() => {
    const c: string[] = [];
    if (channelVoz) c.push("voz");
    if (channelWa) c.push("whatsapp");
    return c.length ? c : ["voz"];
  }, [channelVoz, channelWa]);

  async function launch() {
    setBusy(true);
    try {
      const created = await createCampaign({
        name,
        segment,
        channels,
        total,
      });
      toast.success("Campaña lanzada", {
        description: `${created.name} · ${created.id}`,
      });
      router.push("/campanas");
    } catch (err) {
      toast.error("No se pudo lanzar", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Nueva campaña"
        subtitle="Asistente de 5 pasos para outbound voz y WhatsApp."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => router.push("/campanas")}>
              Cancelar
            </Button>
            {step === STEPS.length - 1 ? (
              <Button onClick={launch} disabled={busy || !name.trim()}>
                {busy ? "Lanzando…" : "Lanzar campaña"}
              </Button>
            ) : (
              <Button onClick={() => setStep((s) => Math.min(s + 1, STEPS.length - 1))}>
                Continuar
                <ChevronRight className="size-4" strokeWidth={1.75} />
              </Button>
            )}
          </div>
        }
      />

      <ol className="mb-6 flex flex-wrap gap-2">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => setStep(i)}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition",
                i === step
                  ? "border-[var(--accent)]/40 bg-[var(--accent-dim)] text-[var(--accent)]"
                  : i < step
                    ? "border-[var(--border)] text-[var(--text)]"
                    : "border-[var(--border)] text-[var(--muted)]",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full text-[10px] font-semibold",
                  i <= step ? "bg-[var(--accent)] text-[#0A0F0D]" : "bg-[var(--surface-2)]",
                )}
              >
                {i < step ? <Check className="size-3" strokeWidth={2.5} /> : i + 1}
              </span>
              {label}
            </button>
          </li>
        ))}
      </ol>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <ChartCard title={`${step + 1}. ${STEPS[step]}`}>
          <div className="space-y-4 p-1">
            {step === 0 && (
              <>
                <label className="block text-sm">
                  Nombre
                  <input
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <div>
                  <p className="mb-2 text-sm text-[var(--muted)]">Flujo producto</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(
                      [
                        ["A", "Flujo A · Renovación"],
                        ["B", "Flujo B · Reactivación"],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setFlow(id)}
                        className={cn(
                          "rounded-xl border p-3 text-left text-sm",
                          flow === id
                            ? "border-[var(--accent)]/50 bg-[var(--accent-dim)]"
                            : "border-[var(--border)] bg-[var(--bg)]",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <label className="block text-sm">
                  Tamaño estimado de audiencia
                  <input
                    type="number"
                    min={1}
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                    value={total}
                    onChange={(e) => setTotal(Number(e.target.value) || 1)}
                  />
                </label>
                <label className="block text-sm">
                  Filtro / regla (solo preview en UI)
                  <input
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-xs"
                    value={segmentFilter}
                    onChange={(e) => setSegmentFilter(e.target.value)}
                  />
                </label>
                <p className="text-xs text-[var(--muted)]">
                  Segmento efectivo al lanzar: <Badge tone="info">{segment}</Badge>. El filtro no se
                  persiste aún — la audiencia real sale de Importar + Segmentación.
                </p>
              </>
            )}

            {step === 2 && (
              <div className="space-y-3">
                <label className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={channelVoz}
                    onChange={(e) => setChannelVoz(e.target.checked)}
                  />
                  Canal voz (SIP / dialer)
                </label>
                <label className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={channelWa}
                    onChange={(e) => setChannelWa(e.target.checked)}
                  />
                  Canal WhatsApp (flujo / texto)
                </label>
              </div>
            )}

            {step === 3 && (
              <>
                <label className="block text-sm">
                  Notas de guion (solo preview)
                  <textarea
                    className="mt-1 min-h-28 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                    value={scriptNote}
                    onChange={(e) => setScriptNote(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  Reintentos máximos (solo preview)
                  <input
                    type="number"
                    min={0}
                    max={5}
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                    value={retries}
                    onChange={(e) => setRetries(Number(e.target.value) || 0)}
                  />
                </label>
                <p className="text-xs text-[var(--muted)]">
                  Al lanzar se guardan nombre, segmento, canales y tamaño. Guion/reintentos quedan
                  como referencia en esta pantalla.
                </p>
              </>
            )}

            {step === 4 && (
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between gap-4 border-b border-[var(--border)] pb-2">
                  <dt className="text-[var(--muted)]">Nombre</dt>
                  <dd className="font-medium">{name}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-[var(--border)] pb-2">
                  <dt className="text-[var(--muted)]">Flujo</dt>
                  <dd>{flow === "A" ? "Renovación" : "Reactivación"}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-[var(--border)] pb-2">
                  <dt className="text-[var(--muted)]">Audiencia</dt>
                  <dd className="tabular">{total}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-[var(--border)] pb-2">
                  <dt className="text-[var(--muted)]">Canales</dt>
                  <dd>{channels.join(" · ")}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-[var(--border)] pb-2">
                  <dt className="text-[var(--muted)]">Reintentos (preview)</dt>
                  <dd className="tabular">{retries}</dd>
                </div>
                <p className="text-xs text-[var(--muted)]">{scriptNote}</p>
                <p className="rounded-lg border border-[var(--border)] bg-[var(--bg)]/50 px-3 py-2 text-xs text-[var(--muted)]">
                  Se persisten: nombre, segmento, canales, total. El resto es preview de UI.
                </p>
              </dl>
            )}
          </div>
        </ChartCard>

        <aside className="space-y-4">
          <ChartCard title="Resumen">
            <div className="space-y-2 p-1 text-sm">
              <p>
                <span className="text-[var(--muted)]">Segmento · </span>
                {segment}
              </p>
              <p>
                <span className="text-[var(--muted)]">Filtro · </span>
                <code className="text-xs text-[var(--accent)]">{segmentFilter}</code>
              </p>
              <p className="tabular">
                <span className="text-[var(--muted)]">Contactos · </span>
                {total}
              </p>
            </div>
          </ChartCard>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={step === 0}
              onClick={() => setStep((s) => Math.max(0, s - 1))}
            >
              <ChevronLeft className="size-4" strokeWidth={1.75} />
              Atrás
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}

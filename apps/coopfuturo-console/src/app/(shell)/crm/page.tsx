"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCrm } from "@/hooks/use-nova";
import { moveCrmLead } from "@/services/ops-client";
import { cn } from "@/lib/utils";
import { Phone, MessageCircle, X, ArrowRight } from "lucide-react";
import { toast } from "sonner";

const TABS = ["Renovación", "Reactivación", "Nuevos", "Microcrédito"] as const;
type Tab = (typeof TABS)[number];

const DEFAULT_NEXT: Record<string, string> = {
  pendiente: "contactado",
  contactado: "interesado",
  interesado: "documento",
  documento: "transferido",
  transferido: "renovado",
};

const COLUMN_LABELS: Record<string, string> = {
  pendiente: "Pendiente",
  contactado: "Contactado",
  interesado: "Interesado",
  documento: "Documento",
  transferido: "Transferido",
  renovado: "Renovado",
  no_interes: "No interés",
};

type Card = {
  id: string;
  name: string;
  universidad: string;
  score: number;
  channel: string;
  urgency: string;
  phone?: string;
  allowed_next?: string[];
};

type SelectedLead = Card & { columnId: string; columnLabel: string };

export default function CrmPage() {
  const { data, isLoading, isError, refetch } = useCrm();
  const [tab, setTab] = useState<Tab>("Renovación");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedLead | null>(null);
  const [tipificacion, setTipificacion] = useState("");

  useEffect(() => {
    setSelected(null);
    setTipificacion("");
  }, [tab]);

  async function move(cardId: string, to: string, tip?: string) {
    setBusyId(cardId);
    try {
      await moveCrmLead({
        lead_id: cardId,
        to_column: to,
        funnel: tab,
        tipificacion: tip,
      });
      toast.success(`Movido a ${COLUMN_LABELS[to] ?? to}`);
      setSelected(null);
      setTipificacion("");
      await refetch();
    } catch (err) {
      toast.error("Transición bloqueada", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusyId(null);
    }
  }

  function nextFor(card: Card, columnId: string): string | undefined {
    const allowed = card.allowed_next ?? [];
    const preferred = DEFAULT_NEXT[columnId];
    if (preferred && allowed.includes(preferred)) return preferred;
    return allowed.find((x) => x !== "no_interes") ?? allowed[0];
  }

  async function advance(card: Card, columnId: string, tip?: string) {
    const to = nextFor(card, columnId);
    if (!to) {
      toast.message("Lead ya en etapa final");
      return;
    }
    if ((to === "renovado" || to === "no_interes") && !String(tip ?? "").trim()) {
      toast.error("Tipificación requerida", {
        description: "Selecciona una tipificación para cerrar el lead.",
      });
      return;
    }
    const resolvedTip =
      tip ||
      (to === "renovado"
        ? "renovado_ok"
        : to === "documento"
          ? "doc_solicitado"
          : undefined);
    await move(card.id, to, resolvedTip);
  }

  if (isError) {
    return (
      <div className="py-24 text-center">
        <p className="text-[var(--muted)]">No fue posible cargar el CRM.</p>
        <Button className="mt-3" onClick={() => refetch()}>
          Reintentar
        </Button>
      </div>
    );
  }

  const funnel = data?.funnels?.[tab];
  const columns = funnel?.columns ?? [];
  const tipificaciones = funnel?.tipificaciones ?? [];
  const nextStep = selected ? nextFor(selected, selected.columnId) : undefined;

  return (
    <div>
      <PageHeader
        title={funnel?.title ?? "CRM Operativo"}
        subtitle="Pipeline estricto: solo transiciones permitidas + tipificación en cierre."
      />

      <div className="mb-4 flex flex-wrap gap-2 border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "border-b-2 px-1 pb-2 text-sm transition-colors",
              tab === t
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--text)]",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        {tipificaciones.map((t: { key: string; label: string; count: number }) => (
          <Badge key={t.key} tone="muted">
            {t.label}: {t.count}
          </Badge>
        ))}
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-xl bg-white/5" />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {columns.map(
            (col: { id: string; label: string; count: number; cards: Card[] }) => (
              <div
                key={`${tab}-${col.id}`}
                className="flex w-64 shrink-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)]"
              >
                <div className="border-b border-[var(--border)] px-3 py-2">
                  <p className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
                    {col.label}{" "}
                    <span className="tabular">({col.count.toLocaleString("es-CO")})</span>
                  </p>
                </div>
                <div className="flex flex-col gap-2 p-2">
                  {col.cards.map((card) => (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() =>
                        setSelected({
                          ...card,
                          columnId: col.id,
                          columnLabel: col.label,
                        })
                      }
                      className={cn(
                        "rounded-lg border border-[var(--border)] bg-[var(--bg)]/50 p-3 text-left transition hover:border-[var(--accent)]/40 hover:bg-[var(--surface-2)]",
                        selected?.id === card.id &&
                          "border-[var(--accent)]/50 bg-[var(--accent-dim)]",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">{card.name}</p>
                          <p className="text-xs text-[var(--muted)]">{card.universidad}</p>
                          {card.phone ? (
                            <p className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">
                              {card.phone}
                            </p>
                          ) : null}
                        </div>
                        <span className="rounded bg-[var(--accent-dim)] px-1.5 py-0.5 text-xs font-semibold text-[var(--accent)]">
                          {card.score}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-[var(--muted)]">
                        {card.channel === "voz" ? (
                          <Phone className="size-3.5" strokeWidth={1.75} />
                        ) : (
                          <MessageCircle className="size-3.5" strokeWidth={1.75} />
                        )}
                        <span className="tabular text-[var(--warning)]">{card.urgency}</span>
                      </div>
                    </button>
                  ))}
                  <p className="px-1 text-xs text-[var(--muted)]">
                    + {Math.max(0, col.count - col.cards.length).toLocaleString("es-CO")} más
                  </p>
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {/* Overlay + drawer 360° */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/40 transition-opacity",
          selected ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setSelected(null)}
        aria-hidden={!selected}
      />
      <aside
        className={cn(
          "fixed right-0 top-0 z-50 flex h-screen w-full max-w-[440px] flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-[-4px_0_24px_rgba(0,0,0,0.45)] transition-transform duration-300",
          selected ? "translate-x-0" : "translate-x-full",
        )}
        aria-hidden={!selected}
        aria-label="Detalle 360 del lead"
      >
        {selected && (
          <>
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--bg)] px-5 py-4">
              <div>
                <h2 className="text-lg font-medium">{selected.name}</h2>
                <p className="text-xs text-[var(--muted)]">ID: {selected.id}</p>
              </div>
              <button
                type="button"
                className="rounded-full p-1.5 text-[var(--muted)] hover:bg-[var(--surface-2)]"
                aria-label="Cerrar drawer"
                onClick={() => setSelected(null)}
              >
                <X className="size-5" strokeWidth={1.75} />
              </button>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto p-5">
              <div className="relative flex items-center gap-4 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]/60 p-4">
                <div className="pointer-events-none absolute inset-0 bg-[var(--accent)]/5" />
                <div className="relative flex size-16 shrink-0 items-center justify-center rounded-full border-4 border-[var(--accent)] text-2xl font-bold text-[var(--accent)]">
                  {selected.score}
                </div>
                <div className="relative">
                  <h4 className="font-medium">Propensión a renovación</h4>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Score basado en historial y canal ({selected.channel}).
                  </p>
                </div>
              </div>

              <div>
                <h4 className="mb-2 border-b border-[var(--border)] pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                  Perfil
                </h4>
                <div className="grid grid-cols-2 gap-y-3 text-sm">
                  <div>
                    <span className="block text-xs text-[var(--muted)]">Institución</span>
                    {selected.universidad}
                  </div>
                  <div>
                    <span className="block text-xs text-[var(--muted)]">Etapa actual</span>
                    {selected.columnLabel}
                  </div>
                  <div>
                    <span className="block text-xs text-[var(--muted)]">Teléfono</span>
                    <span className="font-mono text-xs">{selected.phone ?? "—"}</span>
                  </div>
                  <div>
                    <span className="block text-xs text-[var(--muted)]">Urgencia</span>
                    <span className="tabular text-[var(--warning)]">{selected.urgency}</span>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="mb-2 border-b border-[var(--border)] pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                  Canal
                </h4>
                <div className="flex items-center gap-2 text-sm">
                  {selected.channel === "voz" ? (
                    <Phone className="size-4 text-[var(--accent)]" strokeWidth={1.75} />
                  ) : (
                    <MessageCircle className="size-4 text-[var(--accent)]" strokeWidth={1.75} />
                  )}
                  {selected.channel === "voz" ? "Voz" : "WhatsApp"}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 flex-col gap-2 border-t border-[var(--border)] bg-[var(--bg)] p-5">
              <label className="text-xs text-[var(--muted)]" htmlFor="crm-tip">
                Tipificación (requerida al cerrar en Renovado / No interés)
              </label>
              <select
                id="crm-tip"
                className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                value={tipificacion}
                onChange={(e) => setTipificacion(e.target.value)}
              >
                <option value="">Sin tipificación</option>
                {tipificaciones.map((t: { key: string; label: string }) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
                <option value="renovado_ok">Renovado OK</option>
                <option value="doc_solicitado">Documento solicitado</option>
                <option value="no_interes">No interés</option>
              </select>

              {nextStep ? (
                <Button
                  className="w-full"
                  disabled={busyId === selected.id}
                  onClick={() =>
                    void advance(selected, selected.columnId, tipificacion || undefined)
                  }
                >
                  Avanzar a {COLUMN_LABELS[nextStep] ?? nextStep}
                  <ArrowRight className="ml-1 size-4" strokeWidth={1.75} />
                </Button>
              ) : (
                <p className="text-center text-sm text-[var(--muted)]">Etapa final</p>
              )}

              {(selected.allowed_next ?? []).includes("no_interes") ? (
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={busyId === selected.id}
                  onClick={() => void move(selected.id, "no_interes", "no_interes")}
                >
                  No interés
                </Button>
              ) : null}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

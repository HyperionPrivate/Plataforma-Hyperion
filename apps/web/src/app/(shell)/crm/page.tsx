"use client";

import { useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCrm } from "@/hooks/use-pulso";
import { moveCrmLead } from "@/services/ops-client";
import { cn } from "@/lib/utils";
import { Phone, MessageCircle } from "lucide-react";
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

export default function CrmPage() {
  const { data, isLoading, isError, refetch } = useCrm();
  const [tab, setTab] = useState<Tab>("Renovación");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function move(
    cardId: string,
    to: string,
    tipificacion?: string,
  ) {
    setBusyId(cardId);
    try {
      await moveCrmLead({
        lead_id: cardId,
        to_column: to,
        funnel: tab,
        tipificacion,
      });
      toast.success(`Movido a ${to}`);
      await refetch();
    } catch (err) {
      toast.error("Transición bloqueada", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function advance(card: Card, columnId: string) {
    const allowed = card.allowed_next ?? [];
    const preferred = DEFAULT_NEXT[columnId];
    const to =
      preferred && allowed.includes(preferred)
        ? preferred
        : allowed.find((x) => x !== "no_interes") ?? allowed[0];
    if (!to) {
      toast.message("Lead ya en etapa final");
      return;
    }
    const tip =
      to === "renovado"
        ? "renovado_ok"
        : to === "documento"
          ? "doc_solicitado"
          : undefined;
    await move(card.id, to, tip);
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

  return (
    <div>
      <PageHeader
        title={funnel?.title ?? "CRM"}
        subtitle="Pipeline estricto: solo transiciones permitidas + tipificación en cierre."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded-full px-3 py-1.5 text-sm transition-colors",
              tab === t
                ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                : "bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)]",
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
                  <p className="text-sm font-medium">
                    {col.label}{" "}
                    <span className="text-[var(--muted)]">
                      ({col.count.toLocaleString("es-CO")})
                    </span>
                  </p>
                </div>
                <div className="flex flex-col gap-2 p-2">
                  {col.cards.map((card) => (
                    <div
                      key={card.id}
                      className="rounded-lg border border-[var(--border)] bg-[var(--bg)]/50 p-3 text-left"
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
                      <div className="mt-2 flex flex-col gap-1">
                        {(card.allowed_next ?? []).includes(DEFAULT_NEXT[col.id] ?? "") ||
                        (card.allowed_next ?? []).some((x) => x !== "no_interes") ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="w-full"
                            disabled={busyId === card.id}
                            onClick={() => void advance(card, col.id)}
                          >
                            Avanzar
                            {DEFAULT_NEXT[col.id] ? ` → ${DEFAULT_NEXT[col.id]}` : ""}
                          </Button>
                        ) : null}
                        {(card.allowed_next ?? []).includes("no_interes") ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            disabled={busyId === card.id}
                            onClick={() =>
                              void move(card.id, "no_interes", "no_interes")
                            }
                          >
                            No interés
                          </Button>
                        ) : null}
                      </div>
                    </div>
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
    </div>
  );
}

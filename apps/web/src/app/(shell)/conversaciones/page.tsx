"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GaugeChart } from "@/components/charts";
import { useConversations } from "@/hooks/use-pulso";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Search, Bot, CheckCircle2, Send } from "lucide-react";
import {
  claimConversation,
  createHandoff,
  releaseConversation,
  sendConversationMessage,
} from "@/services/ops-client";

type Msg = {
  id: string;
  role: string;
  text: string;
  at?: string;
  source?: string;
  attachment?: { name: string; size: string; validated?: boolean };
};

function ConversacionesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data, isLoading, isError, refetch } = useConversations();
  const list = useMemo(() => data?.conversations ?? [], [data?.conversations]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [botActive, setBotActive] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const fromUrl = searchParams.get("id");
    if (fromUrl) {
      setSelectedId(fromUrl);
      return;
    }
    if (!selectedId && list[0]?.id) setSelectedId(list[0].id);
  }, [list, selectedId, searchParams]);

  const selected = useMemo(
    () => list.find((c) => c.id === selectedId) ?? list[0],
    [list, selectedId],
  );

  useEffect(() => {
    if (selected) {
      const paused = Boolean(selected.botPaused || selected.claimedBy);
      setBotActive(!paused && (selected.botActive ?? true));
    }
  }, [selected?.id, selected?.botPaused, selected?.claimedBy]); // eslint-disable-line react-hooks/exhaustive-deps

  const messages = useMemo(() => {
    if (!selected) return [];
    return (selected.messages ?? []) as Msg[];
  }, [selected]);

  const filteredList = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.topic.toLowerCase().includes(q) ||
        c.snippet.toLowerCase().includes(q),
    );
  }, [list, query]);

  const exp = selected?.expediente;
  const ai = selected?.aiSummary;

  async function sendMessage() {
    if (!selected || botActive || !draft.trim() || busy) return;
    setBusy(true);
    try {
      await sendConversationMessage({
        conversation_id: selected.id,
        text: draft.trim(),
        role: "advisor",
      });
      setDraft("");
      toast.success("Mensaje enviado");
      await refetch();
    } catch (err) {
      toast.error("No se pudo enviar", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function toggleControl() {
    if (!selected?.id || busy) return;
    setBusy(true);
    try {
      if (botActive) {
        await claimConversation({ conversation_id: selected.id });
        setBotActive(false);
        toast.success("Tomaste el control de la conversación");
      } else {
        await releaseConversation({ conversation_id: selected.id });
        setBotActive(true);
        toast.message("Control devuelto al bot");
      }
      await refetch();
    } catch (err) {
      toast.error("No se pudo cambiar el control", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function transferToHandoff() {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const res = await createHandoff({
        name: selected.name,
        segment: selected.topic || "Renovacion",
        motivo: "Transferido desde Conversaciones",
      });
      toast.success("En cola de handoff", { description: String(res.id) });
      router.push("/handoff");
    } catch (err) {
      toast.error("No se pudo transferir", {
        description: err instanceof Error ? err.message : "Error",
      });
    } finally {
      setBusy(false);
    }
  }

  if (isError) {
    return (
      <div className="py-24 text-center">
        <p className="text-[var(--muted)]">No fue posible cargar las conversaciones.</p>
        <Button className="mt-3" onClick={() => refetch()}>
          Reintentar
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      <PageHeader title="Conversaciones" subtitle="Inbox del contact center" />

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[280px_1fr_320px]">
        <section className="flex min-h-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="border-b border-[var(--border)] p-3">
            <p className="mb-2 text-sm font-medium">
              Conversaciones activas{" "}
              <Badge tone="success">{data?.activeCount ?? 0}</Badge>
            </p>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 size-4 text-[var(--muted)]" strokeWidth={1.75} />
              <input
                className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                placeholder="Buscar conversaciones..."
                aria-label="Buscar conversaciones"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <ul className="flex-1 overflow-y-auto p-2">
            {isLoading && <li className="p-4 text-sm text-[var(--muted)]">Cargando…</li>}
            {filteredList.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(c.id);
                    router.replace(`/conversaciones?id=${c.id}`);
                  }}
                  className={cn(
                    "mb-1 w-full cursor-pointer rounded-lg border border-transparent p-2.5 text-left hover:bg-[var(--surface-2)]",
                    c.id === selected?.id && "border-[var(--accent)]/40 bg-[var(--accent-dim)]",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex gap-2">
                      <span className="flex size-8 items-center justify-center rounded-full bg-white/5 text-xs font-medium">
                        {c.name
                          .split(" ")
                          .slice(0, 2)
                          .map((p) => p[0])
                          .join("")}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{c.name}</p>
                        <p className="text-xs text-[var(--muted)]">{c.topic}</p>
                        <p className="truncate text-xs text-[var(--muted)]">{c.snippet}</p>
                      </div>
                    </div>
                    <span
                      className={cn(
                        "mt-1 size-2 shrink-0 rounded-full",
                        c.sentiment === "positive" && "bg-[var(--success)]",
                        c.sentiment === "neutral" && "bg-[var(--warning)]",
                        c.sentiment === "negative" && "bg-[var(--danger)]",
                      )}
                    />
                  </div>
                </button>
              </li>
            ))}
            {!isLoading && filteredList.length === 0 && (
              <li className="p-6 text-center text-sm text-[var(--muted)]">
                No hay resultados para esa búsqueda.
              </li>
            )}
          </ul>
        </section>

        <section className="flex min-h-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <div>
              <p className="font-medium">
                {selected ? `${selected.name} — ${selected.topic}` : "—"}
              </p>
              <div className="mt-1 flex gap-1">
                {(selected?.tags ?? []).map((t) => (
                  <Badge key={t} tone={t.includes("Documento") ? "info" : "success"}>
                    {t}
                  </Badge>
                ))}
                {selected?.claimedBy ? (
                  <Badge tone="warning">Asesor: {selected.claimedBy}</Badge>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.map((m) => (
              <div
                key={m.id}
                className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[80%] rounded-2xl px-3 py-2 text-sm",
                    m.role === "user"
                      ? "bg-[var(--accent)] text-[#0A0F0D]"
                      : "bg-[var(--surface-2)] text-[var(--text)]",
                  )}
                >
                  {m.role === "bot" && (
                    <span className="mb-1 flex items-center gap-1 text-[10px] text-[var(--muted)]">
                      <Bot className="size-3" strokeWidth={1.75} />{" "}
                      {!botActive || m.source === "advisor" ? "Asesor" : "Asistente"}
                    </span>
                  )}
                  <p>{m.text}</p>
                  {"attachment" in m && m.attachment && (
                    <div className="mt-2 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)]/50 p-2 text-xs">
                      <span className="font-medium">{m.attachment.name}</span>
                      <span className="text-[var(--muted)]">{m.attachment.size}</span>
                      {m.attachment.validated && (
                        <span className="flex items-center gap-1 text-[var(--success)]">
                          <CheckCircle2 className="size-3.5" strokeWidth={1.75} /> Validado
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-[var(--border)] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm text-[var(--muted)]">
                {botActive
                  ? "Bot activo — Tomar control para escribir"
                  : "Asesor al mando — puedes escribir"}
              </p>
              <Button
                size="sm"
                variant={botActive ? "default" : "secondary"}
                disabled={busy}
                onClick={toggleControl}
              >
                {botActive ? "Tomar control" : "Devolver al bot"}
              </Button>
            </div>
            <div className="flex gap-2">
              <input
                className={cn(
                  "h-10 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]",
                  botActive && "cursor-not-allowed opacity-50",
                )}
                placeholder={botActive ? "Tomar control para escribir…" : "Escribe un mensaje…"}
                disabled={botActive || busy}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void sendMessage();
                }}
                aria-label="Mensaje al asociado"
              />
              <Button
                size="icon"
                disabled={botActive || !draft.trim() || busy}
                onClick={() => void sendMessage()}
                aria-label="Enviar mensaje"
              >
                <Send className="size-4" strokeWidth={1.75} />
              </Button>
            </div>
          </div>
        </section>

        <section className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="mb-3 text-sm font-medium">Expediente del asociado</h3>
            {exp && (
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--muted)]">Cédula</dt>
                  <dd className="tabular">{exp.cedula}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--muted)]">Universidad</dt>
                  <dd>{exp.universidad}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--muted)]">Programa</dt>
                  <dd>{exp.programa}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--muted)]">Semestre</dt>
                  <dd>{exp.semestre}</dd>
                </div>
                <div>
                  <div className="mb-1 flex justify-between text-xs text-[var(--muted)]">
                    <span>Cuotas pagadas</span>
                    <span>
                      {exp.cuotasPagadas}/{exp.cuotasTotal}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full bg-[var(--accent)]"
                      style={{ width: `${(exp.cuotasPagadas / exp.cuotasTotal) * 100}%` }}
                    />
                  </div>
                </div>
                <Badge tone="info">{exp.estadoCrm}</Badge>
              </dl>
            )}
            <div className="mt-4">
              <p className="mb-1 text-center text-xs text-[var(--muted)]">
                Score de propensión a renovar
              </p>
              <GaugeChart value={exp?.score ?? 0} label={exp?.scoreLabel} />
            </div>
            <Button className="mt-2 w-full" disabled={busy} onClick={() => void transferToHandoff()}>
              Transferir a asesor
            </Button>
          </div>
          {ai && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <h3 className="mb-2 text-sm font-medium">Resumen IA de la conversación</h3>
              <p className="text-sm text-[var(--muted)]">{ai.text}</p>
              <div className="mt-3 flex flex-wrap gap-1">
                <Badge tone="success">Intención: {ai.intencion}</Badge>
                <Badge tone="info">Etapa: {ai.etapa}</Badge>
                <Badge tone="success">Sentimiento: {ai.sentimiento}</Badge>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function ConversacionesPage() {
  return (
    <Suspense
      fallback={
        <div className="py-24 text-center text-sm text-[var(--muted)]">
          Cargando conversaciones…
        </div>
      }
    >
      <ConversacionesContent />
    </Suspense>
  );
}

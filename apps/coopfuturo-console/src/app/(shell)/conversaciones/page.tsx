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
import {
  Search,
  Bot,
  CheckCircle2,
  Send,
  Phone,
  MessageCircle,
  Filter,
  Smile,
  ExternalLink,
} from "lucide-react";
import {
  claimConversation,
  createHandoff,
  fetchConversationLiwaStatus,
  releaseConversation,
  sendConversationMessage,
  type LiwaConversationStatus,
} from "@/services/ops-client";
import { sanitizeOpsCopy, sanitizeTags } from "@/lib/sanitize-ops-copy";

type Msg = {
  id: string;
  role: string;
  text: string;
  at?: string;
  source?: string;
  attachment?: { name: string; size: string; validated?: boolean };
};

type ChannelFilter = "all" | "voz" | "whatsapp";
type SentimentFilter = "all" | "positive" | "neutral" | "negative";

function ConversacionesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data, isLoading, isError, refetch } = useConversations();
  const list = useMemo(() => data?.conversations ?? [], [data?.conversations]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [botActive, setBotActive] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingMsgs, setPendingMsgs] = useState<Msg[]>([]);
  const [query, setQuery] = useState("");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>("all");
  const [liwaStatus, setLiwaStatus] = useState<LiwaConversationStatus | null>(null);

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
    if (!selected?.id) {
      setLiwaStatus(null);
      return;
    }
    let cancelled = false;
    async function pollLiwa() {
      try {
        const status = await fetchConversationLiwaStatus(selected!.id);
        if (cancelled) return;
        setLiwaStatus(status);
        if (status.synced || status.handoff_detected) {
          await refetch();
        }
      } catch {
        if (!cancelled) {
          setLiwaStatus(null);
        }
      }
    }
    void pollLiwa();
    const timer = window.setInterval(() => void pollLiwa(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selected?.id, refetch]);

  useEffect(() => {
    if (selected) {
      const paused = Boolean(selected.botPaused || selected.claimedBy);
      setBotActive(!paused && (selected.botActive ?? true));
    }
  }, [selected?.id, selected?.botPaused, selected?.claimedBy]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPendingMsgs([]);
    setDraft("");
  }, [selected?.id]);

  const messages = useMemo(() => {
    if (!selected) return [];
    const base = ((selected.messages ?? []) as Msg[]).map((m) => ({
      ...m,
      text: sanitizeOpsCopy(m.text),
    }));
    return [...base, ...pendingMsgs];
  }, [selected, pendingMsgs]);

  const displayTags = useMemo(
    () => sanitizeTags(selected?.tags),
    [selected?.tags],
  );

  const filteredList = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((c) => {
      if (channelFilter !== "all" && (c.channel ?? "whatsapp") !== channelFilter) {
        return false;
      }
      if (sentimentFilter !== "all" && (c.sentiment ?? "neutral") !== sentimentFilter) {
        return false;
      }
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.topic.toLowerCase().includes(q) ||
        c.snippet.toLowerCase().includes(q)
      );
    });
  }, [list, query, channelFilter, sentimentFilter]);

  const exp = selected?.expediente;
  const ai = selected?.aiSummary;

  async function sendMessage() {
    if (!selected || botActive || !draft.trim() || busy) return;
    const text = draft.trim();
    const tempId = `tmp_${Date.now()}`;
    // Optimistic: clear draft immediately so it doesn't look stuck.
    setDraft("");
    setPendingMsgs((prev) => [
      ...prev,
      { id: tempId, role: "bot", text, at: "enviando…", source: "advisor" },
    ]);
    setBusy(true);
    try {
      const res = await sendConversationMessage({
        conversation_id: selected.id,
        text,
        role: "advisor",
      });
      setPendingMsgs((prev) => prev.filter((m) => m.id !== tempId));
      if (res?.channel_acked) {
        toast.success("WhatsApp enviado");
      } else if (res?.delivery === "liwa_whatsapp") {
        toast.success("WhatsApp aceptado por LIWA", {
          description: "Entrega pendiente de confirmación",
        });
      } else {
        toast.message("Mensaje guardado", {
          description: res?.delivery || "local",
        });
      }
      await refetch();
    } catch (err) {
      setPendingMsgs((prev) => prev.filter((m) => m.id !== tempId));
      setDraft(text);
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
      const exp = selected.expediente as { phone?: string } | undefined;
      const expPhone = typeof exp?.phone === "string" ? exp.phone.trim() : "";
      const idDigits = selected.id.replace(/\D/g, "");
      const phoneFromId =
        idDigits.length >= 10
          ? idDigits.startsWith("57")
            ? `+${idDigits}`
            : `+57${idDigits.slice(-10)}`
          : "";
      const phone = expPhone || liwaStatus?.phone || phoneFromId || undefined;
      const agencyTag =
        (selected.tags ?? []).find(
          (t) =>
            typeof t === "string" &&
            (t.startsWith("AG_") ||
              t.startsWith("RENOVACION_") ||
              t.startsWith("REACTIVACION_")),
        ) ||
        liwaStatus?.handoff_tags?.[0] ||
        undefined;

      const res = await createHandoff({
        name: selected.name,
        segment: selected.topic || "Renovacion",
        motivo: "Transferido desde Conversaciones",
        conversation_id: selected.id,
        phone,
        agency_tag: agencyTag,
        idempotency_key: `handoff:${selected.id}`,
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
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-2.5 size-4 text-[var(--muted)]" strokeWidth={1.75} />
              <input
                className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                placeholder="Buscar conversaciones..."
                aria-label="Buscar conversaciones"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <label className="relative flex-1">
                <span className="sr-only">Canal</span>
                <Filter
                  className="pointer-events-none absolute left-2 top-2 size-3.5 text-[var(--muted)]"
                  strokeWidth={1.75}
                />
                <select
                  className="h-8 w-full appearance-none rounded-md border border-[var(--border)] bg-[var(--bg)] pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  value={channelFilter}
                  onChange={(e) => setChannelFilter(e.target.value as ChannelFilter)}
                >
                  <option value="all">Todos los canales</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="voz">Voz</option>
                </select>
              </label>
              <label className="relative flex-1">
                <span className="sr-only">Sentimiento</span>
                <Smile
                  className="pointer-events-none absolute left-2 top-2 size-3.5 text-[var(--muted)]"
                  strokeWidth={1.75}
                />
                <select
                  className="h-8 w-full appearance-none rounded-md border border-[var(--border)] bg-[var(--bg)] pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  value={sentimentFilter}
                  onChange={(e) => setSentimentFilter(e.target.value as SentimentFilter)}
                >
                  <option value="all">Sentimiento</option>
                  <option value="positive">Positivo</option>
                  <option value="neutral">Neutral</option>
                  <option value="negative">Negativo</option>
                </select>
              </label>
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
                    "mb-1 w-full cursor-pointer rounded-lg border border-transparent border-l-2 p-2.5 text-left hover:bg-[var(--surface-2)]",
                    c.id === selected?.id
                      ? "border-l-[var(--accent)] bg-[var(--accent-dim)]"
                      : "border-l-transparent",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex gap-2">
                      <span className="mt-0.5 text-[var(--muted)]">
                        {(c.channel ?? "whatsapp") === "voz" ? (
                          <Phone className="size-4" strokeWidth={1.75} />
                        ) : (
                          <MessageCircle className="size-4" strokeWidth={1.75} />
                        )}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{c.name}</p>
                        <p className="text-xs text-[var(--muted)]">{sanitizeOpsCopy(c.topic)}</p>
                        <p className="truncate text-xs text-[var(--muted)]">
                          {sanitizeOpsCopy(c.snippet)}
                        </p>
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
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <p className="text-sm font-medium">Sin conversación seleccionada</p>
              <p className="max-w-sm text-xs text-[var(--muted)]">
                No hay hilos activos. Genera actividad desde Laboratorio (voz/WhatsApp) o espera
                inbound. Aquí no hay bot que tomar.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {selected.name} — {sanitizeOpsCopy(selected.topic)}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {displayTags.map((t) => (
                      <Badge key={t} tone={t.includes("Documento") ? "info" : "success"}>
                        {t}
                      </Badge>
                    ))}
                    {selected.claimedBy ? (
                      <Badge tone="warning">Asesor: {selected.claimedBy}</Badge>
                    ) : null}
                    {liwaStatus?.handoff_detected ? (
                      <Badge tone="warning">
                        Live chat LIWA
                        {liwaStatus.agency_hint ? ` · ${liwaStatus.agency_hint}` : ""}
                      </Badge>
                    ) : liwaStatus?.ok ? (
                      <Badge tone="info">Bot LIWA</Badge>
                    ) : null}
                    {(liwaStatus?.handoff_tags ?? []).slice(0, 2).map((t) => (
                      <Badge key={t} tone="info">
                        {t}
                      </Badge>
                    ))}
                  </div>
                  {liwaStatus?.handoff_detected ? (
                    <p className="mt-2 text-xs text-[var(--muted)]">
                      Chat humano en LIWA — aquí ves el estado; el historial completo del bot/usuario
                      está en la bandeja LIWA. Puedes responder por API si tomas control.
                    </p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => {
                    const base =
                      process.env.NEXT_PUBLIC_LIWA_INBOX_URL ||
                      liwaStatus?.inbox_url ||
                      "https://chat.liwa.co/?acc=1656233";
                    window.open(base, "_blank", "noopener,noreferrer");
                  }}
                >
                  <ExternalLink className="mr-1.5 size-3.5" strokeWidth={1.75} />
                  Abrir en LIWA
                </Button>
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
                          {m.source === "advisor"
                            ? "Asesor"
                            : m.source === "voz"
                              ? "Sistema"
                              : m.source === "liwa_bot" || m.source === "whatsapp"
                                ? "Bot WhatsApp"
                                : "Asistente"}
                        </span>
                      )}
                      {m.role === "user" && (
                        <span className="mb-1 block text-[10px] text-[var(--muted)]">Asociado</span>
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
              <div className="relative border-t border-[var(--border)] p-3">
                {botActive && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--surface)]/70 backdrop-blur-[2px]">
                    <div className="flex items-center gap-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--surface-2)] px-4 py-2 shadow-[0_0_15px_rgba(52,211,153,0.08)]">
                      <Bot
                        className="size-4 animate-pulse text-[var(--accent)]"
                        strokeWidth={1.75}
                      />
                      <span className="text-sm font-medium">Bot activo procesando</span>
                      <Button size="sm" disabled={busy} onClick={() => void toggleControl()}>
                        Tomar control
                      </Button>
                    </div>
                  </div>
                )}
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-sm text-[var(--muted)]">
                    {botActive
                      ? "Bot activo — Tomar control para escribir"
                      : "Asesor al mando — puedes escribir"}
                  </p>
                  {!botActive && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void toggleControl()}
                    >
                      Devolver al bot
                    </Button>
                  )}
                </div>
                <div className={cn("flex gap-2", botActive && "pointer-events-none opacity-40")}>
                  <input
                    className="h-10 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                    placeholder={
                      botActive ? "Tomar control para escribir…" : "Escribe un mensaje…"
                    }
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
            </>
          )}
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
            <Button
              className="mt-2 w-full"
              disabled={busy || !selected}
              onClick={() => void transferToHandoff()}
            >
              Transferir a asesor
            </Button>
            {liwaStatus?.contact_id ? (
              <dl className="mt-3 space-y-1 border-t border-[var(--border)] pt-3 text-xs text-[var(--muted)]">
                <div className="flex justify-between gap-2">
                  <dt>LIWA contact</dt>
                  <dd className="font-mono text-[var(--text)]">{liwaStatus.contact_id}</dd>
                </div>
                {liwaStatus.phone ? (
                  <div className="flex justify-between gap-2">
                    <dt>Teléfono</dt>
                    <dd className="tabular text-[var(--text)]">{liwaStatus.phone}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-2">
                  <dt>Modo LIWA</dt>
                  <dd className="text-[var(--text)]">
                    {liwaStatus.handoff_detected ? "live_chat" : liwaStatus.mode || "bot"}
                  </dd>
                </div>
              </dl>
            ) : null}
            {!selected ? (
              <p className="mt-2 text-center text-xs text-[var(--muted)]">
                Selecciona una conversación para ver expediente.
              </p>
            ) : null}
          </div>
          {ai && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <h3 className="mb-2 text-sm font-medium">Resumen IA de la conversación</h3>
              <p className="text-sm text-[var(--muted)]">{sanitizeOpsCopy(ai.text)}</p>
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

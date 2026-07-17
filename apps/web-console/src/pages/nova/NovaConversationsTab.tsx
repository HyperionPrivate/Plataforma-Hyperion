import { useMemo, useState } from "react";
import { Card, CardHead, EmptyState } from "../../components/ui.js";
import type { ConversationRow } from "./types.js";

export function NovaConversationsTab({
  conversations,
  onClaim,
  onReply
}: {
  conversations: ConversationRow[];
  onClaim: (conversationId: string) => Promise<void>;
  onReply: (conversationId: string, text: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState<"all" | string>("all");
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    return conversations.filter((row) => {
      if (channel !== "all" && row.channel !== channel) return false;
      if (!query.trim()) return true;
      const hay = `${row.conversation_id} ${row.agency_code ?? ""} ${row.status}`.toLowerCase();
      return hay.includes(query.trim().toLowerCase());
    });
  }, [channel, conversations, query]);

  const selected = filtered.find((row) => row.conversation_id === selectedId) ?? filtered[0] ?? undefined;

  async function claim() {
    if (!selected) return;
    setBusy(true);
    try {
      await onClaim(selected.conversation_id);
      setSelectedId(selected.conversation_id);
    } finally {
      setBusy(false);
    }
  }

  async function reply() {
    if (!selected || !draft.trim()) return;
    setBusy(true);
    try {
      await onReply(selected.conversation_id, draft.trim());
      setDraft("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(240px, 320px) 1fr", gap: 16 }}>
      <Card>
        <CardHead title="Bandeja" />
        <div className="col" style={{ gap: 8, marginBottom: 12 }}>
          <input className="input" placeholder="Buscar…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="all">Todos los canales</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="voice">Voz</option>
          </select>
        </div>
        {filtered.length === 0 ? (
          <EmptyState label="Sin conversaciones. Los webhooks LIWA crearán entradas aquí." />
        ) : (
          <ul
            className="col"
            style={{ gap: 6, listStyle: "none", padding: 0, margin: 0, maxHeight: 480, overflow: "auto" }}
          >
            {filtered.map((conversation) => (
              <li key={conversation.conversation_id}>
                <button
                  type="button"
                  className={`chip${selected?.conversation_id === conversation.conversation_id ? " active" : ""}`}
                  style={{ width: "100%", justifyContent: "flex-start", textAlign: "left" }}
                  onClick={() => setSelectedId(conversation.conversation_id)}
                >
                  {conversation.conversation_id.slice(0, 8)} · {conversation.channel} ·{" "}
                  {conversation.agency_code ?? "—"} · {conversation.status}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHead title="Detalle" />
        {!selected ? (
          <EmptyState label="Selecciona una conversación." />
        ) : (
          <div className="col" style={{ gap: 12 }}>
            <p>
              <strong>{selected.conversation_id}</strong>
            </p>
            <p className="muted tiny">
              Canal {selected.channel} · sede {selected.agency_code ?? "—"} · estado {selected.status}
              {selected.claimed_by ? ` · claimed ${selected.claimed_by.slice(0, 8)}` : ""}
            </p>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" type="button" disabled={busy} onClick={() => void claim()}>
                Claim
              </button>
            </div>
            <label className="col" style={{ gap: 4 }}>
              <span className="tiny muted">Responder (ventana 24h / LIWA)</span>
              <textarea className="input" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} />
            </label>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || !draft.trim()}
              onClick={() => void reply()}
            >
              Enviar reply
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

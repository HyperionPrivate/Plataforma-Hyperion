import { useState } from "react";
import { Card, CardHead, EmptyState } from "../../components/ui.js";
import type { CallRow } from "./types.js";

const LIWA_SIM_EVENTS = [
  "document_received",
  "prequal_completed",
  "handoff_requested",
  "csat",
  "opt_out",
  "tipificacion",
  "message"
] as const;

export function NovaLabTab({
  calls,
  canWriteOps,
  onPlaceCall,
  onEligibility,
  onScore,
  onLookupAssociate,
  onSimulateLiwa
}: {
  calls: CallRow[];
  canWriteOps: boolean;
  onPlaceCall: (phone: string) => Promise<void>;
  onEligibility: (contactId: string) => Promise<unknown>;
  onScore: (contactId: string) => Promise<unknown>;
  onLookupAssociate: (documentId: string) => Promise<unknown>;
  onSimulateLiwa: (input: {
    event: (typeof LIWA_SIM_EVENTS)[number];
    phone: string;
    ciudad?: string;
    score?: number;
    tipificacion?: string;
  }) => Promise<unknown>;
}) {
  const [callPhone, setCallPhone] = useState("+573001112233");
  const [contactId, setContactId] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState("");
  const [liwaEvent, setLiwaEvent] = useState<(typeof LIWA_SIM_EVENTS)[number]>("document_received");
  const [liwaPhone, setLiwaPhone] = useState("+573001112233");
  const [liwaCiudad, setLiwaCiudad] = useState("Barranquilla");
  const [liwaScore, setLiwaScore] = useState(5);
  const [liwaTipificacion, setLiwaTipificacion] = useState("interesado_wa");

  async function run(action: () => Promise<unknown>) {
    if (!canWriteOps) return;
    setBusy(true);
    try {
      const result = await action();
      setLastResult(JSON.stringify(result ?? { ok: true }, null, 2));
    } catch (err) {
      setLastResult(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        <Card>
          <CardHead title="Llamada individual" />
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="input" value={callPhone} onChange={(e) => setCallPhone(e.target.value)} />
            <button
              className="btn btn-primary"
              type="button"
              disabled={!canWriteOps || busy}
              onClick={() => void run(() => onPlaceCall(callPhone))}
            >
              Llamar (mock/dialer)
            </button>
          </div>
        </Card>

        <Card>
          <CardHead title="Elegibilidad / score" />
          <input
            className="input"
            placeholder="contact_id UUID"
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn"
              type="button"
              disabled={!canWriteOps || busy || !contactId.trim()}
              onClick={() => void run(() => onEligibility(contactId.trim()))}
            >
              Elegibilidad
            </button>
            <button
              className="btn"
              type="button"
              disabled={!canWriteOps || busy || !contactId.trim()}
              onClick={() => void run(() => onScore(contactId.trim()))}
            >
              Score
            </button>
          </div>
        </Card>

        <Card>
          <CardHead title="Lookup core (asociado)" />
          <input
            className="input"
            placeholder="documentId UUID"
            value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <button
            className="btn"
            type="button"
            disabled={busy || !documentId.trim()}
            onClick={() => void run(() => onLookupAssociate(documentId.trim()))}
          >
            Consultar
          </button>
        </Card>
      </div>

      <Card>
        <CardHead title="Simular evento LIWA" />
        <p className="tiny muted" style={{ marginBottom: 8 }}>
          Reenvía el mismo path que producción (`/v1/liwa/webhooks/simulate`) con secret server-side. Requiere
          LIWA_WEBHOOK_SECRET o LIWA_WEBHOOK_ALLOW_INSECURE=1 en local.
        </p>
        <div className="grid two" style={{ gap: 8 }}>
          <label>
            Evento
            <select
              className="input"
              value={liwaEvent}
              onChange={(e) => setLiwaEvent(e.target.value as (typeof LIWA_SIM_EVENTS)[number])}
            >
              {LIWA_SIM_EVENTS.map((ev) => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </select>
          </label>
          <label>
            Teléfono E.164
            <input className="input" value={liwaPhone} onChange={(e) => setLiwaPhone(e.target.value)} />
          </label>
          <label>
            Ciudad (→ AG_*)
            <input className="input" value={liwaCiudad} onChange={(e) => setLiwaCiudad(e.target.value)} />
          </label>
          <label>
            CSAT score
            <input
              className="input"
              type="number"
              min={1}
              max={5}
              value={liwaScore}
              onChange={(e) => setLiwaScore(Number(e.target.value) || 5)}
            />
          </label>
          <label>
            Tipificación
            <input className="input" value={liwaTipificacion} onChange={(e) => setLiwaTipificacion(e.target.value)} />
          </label>
        </div>
        <button
          className="btn btn-primary"
          style={{ marginTop: 12 }}
          type="button"
          disabled={!canWriteOps || busy || !liwaPhone.trim()}
          onClick={() =>
            void run(() =>
              onSimulateLiwa({
                event: liwaEvent,
                phone: liwaPhone.trim(),
                ciudad: liwaCiudad.trim() || undefined,
                score: liwaEvent === "csat" ? liwaScore : undefined,
                tipificacion: liwaEvent === "tipificacion" ? liwaTipificacion : undefined
              })
            )
          }
        >
          Simular evento LIWA
        </button>
      </Card>

      <Card>
        <CardHead title="Reconciliación de llamadas" />
        {calls.length === 0 ? (
          <EmptyState label="Sin llamadas ambiguas en cuarentena." />
        ) : (
          <ul>
            {calls.map((call) => (
              <li key={call.call_id}>
                {call.call_id} · {call.status} · {call.transport} · {call.contact_phone_e164}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {lastResult ? (
        <Card>
          <CardHead title="Último resultado" />
          <pre className="tiny" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {lastResult}
          </pre>
        </Card>
      ) : null}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { DonutChart } from "../../components/nova/charts/index.js";
import { Card, CardHead, EmptyState, LoadingState } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { novaPath } from "../../lib/context.js";
import type { LeadRow } from "./types.js";

interface ScoreResult {
  contact_id: string;
  segment?: string;
  score?: number;
  propensity?: number;
  urgency?: number;
  wave?: string;
}

interface ContactRow {
  contact_id: string;
  phone_e164: string;
  full_name?: string;
  agency_code?: string;
  segment?: string;
  score?: number;
}

export function NovaSegmentationTab({
  tenantId,
  leads,
  canWriteOps,
  onScore
}: {
  tenantId: string;
  leads: LeadRow[];
  canWriteOps: boolean;
  onScore: (contactId: string) => Promise<ScoreResult>;
}) {
  const [contactId, setContactId] = useState("");
  const [query, setQuery] = useState("");
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [results, setResults] = useState<ScoreResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingContacts(true);
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (query.trim()) params.set("q", query.trim());
        const data = await api.get<{ items: ContactRow[] }>(
          `${novaPath(tenantId, "contacts")}?${params.toString()}`
        );
        if (!cancelled) setContacts(data.items ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoadingContacts(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, query]);

  const contactSuggestions = useMemo(() => {
    const ids = new Set<string>();
    for (const c of contacts) ids.add(c.contact_id);
    for (const lead of leads) {
      if (lead.contact_id) ids.add(lead.contact_id);
    }
    return [...ids].slice(0, 40);
  }, [contacts, leads]);

  const slices = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of results) {
      const key = row.segment || "sin_segmento";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const total = results.length || 1;
    const colors = ["success", "info", "warning", "muted", "danger"];
    return [...counts.entries()].map(([key, count], index) => ({
      key,
      label: key,
      count,
      pct: Math.round((count / total) * 100),
      color: colors[index % colors.length]!
    }));
  }, [results]);

  async function scoreOne(id: string) {
    if (!canWriteOps || !id.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const scored = await onScore(id.trim());
      setResults((prev) => {
        const next = prev.filter((row) => row.contact_id !== scored.contact_id);
        return [scored, ...next];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function scoreListed() {
    if (!canWriteOps) return;
    setBusy(true);
    setError(undefined);
    try {
      for (const row of contacts.slice(0, 10)) {
        const scored = await onScore(row.contact_id);
        setResults((prev) => {
          const next = prev.filter((r) => r.contact_id !== scored.contact_id);
          return [scored, ...next];
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card>
        <CardHead title="Contactos" />
        <div className="row" style={{ gap: 8, marginBottom: 8 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="Buscar teléfono, nombre o UUID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {loadingContacts ? (
          <LoadingState label="Cargando contactos…" />
        ) : contacts.length === 0 ? (
          <EmptyState label="Sin contactos. Importa CSV/JSON primero." />
        ) : (
          <ul className="col tiny" style={{ gap: 4, listStyle: "none", padding: 0, margin: 0, maxHeight: 220, overflow: "auto" }}>
            {contacts.map((c) => (
              <li key={c.contact_id}>
                <button
                  type="button"
                  className="btn"
                  style={{ width: "100%", textAlign: "left" }}
                  onClick={() => setContactId(c.contact_id)}
                >
                  {c.phone_e164} · {c.full_name ?? "—"} · {c.agency_code ?? "—"} · {c.segment ?? "—"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHead title="Scoring de contactos" />
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ minWidth: 280, flex: 1 }}
            placeholder="contact_id (UUID)"
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            list="nova-contact-suggestions"
          />
          <datalist id="nova-contact-suggestions">
            {contactSuggestions.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          <button className="btn btn-primary" type="button" disabled={!canWriteOps || busy} onClick={() => void scoreOne(contactId)}>
            Score
          </button>
          <button
            className="btn"
            type="button"
            disabled={!canWriteOps || busy || contacts.length === 0}
            onClick={() => void scoreListed()}
          >
            Score listado (máx. 10)
          </button>
        </div>
        {error ? <div className="banner" style={{ marginTop: 8 }}>{error}</div> : null}
      </Card>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        <Card>
          <CardHead title="Distribución de segmentos (sesión)" />
          {results.length === 0 ? (
            <EmptyState label="Ejecuta scoring para ver el donut." />
          ) : (
            <DonutChart slices={slices} centerLabel="Scored" />
          )}
        </Card>
        <Card>
          <CardHead title="Resultados" />
          {results.length === 0 ? (
            <EmptyState label="Sin scores en esta sesión." />
          ) : (
            <ul className="col" style={{ gap: 6, listStyle: "none", padding: 0, margin: 0 }}>
              {results.map((row) => (
                <li key={row.contact_id} className="tiny">
                  {row.contact_id.slice(0, 8)} · {row.segment ?? "—"} · score {row.score ?? "—"} · wave{" "}
                  {row.wave ?? "—"}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

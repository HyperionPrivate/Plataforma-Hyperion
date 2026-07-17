import { useMemo, useState } from "react";
import { Card, CardHead, EmptyState } from "../../components/ui.js";
import type { LeadRow } from "./types.js";
import { CRM_STAGE_LABELS, CRM_STAGES, DEFAULT_NEXT_STAGE } from "./types.js";

export function NovaCrmTab({
  leads,
  canWriteOps,
  onPatchLead
}: {
  leads: LeadRow[];
  canWriteOps: boolean;
  onPatchLead: (leadId: string, body: { stage?: string; tipification?: string }) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [tipification, setTipification] = useState("");
  const [busyId, setBusyId] = useState<string>();

  const columns = useMemo(() => {
    return CRM_STAGES.map((stage) => ({
      id: stage,
      label: CRM_STAGE_LABELS[stage] ?? stage,
      items: leads.filter((lead) => lead.stage === stage)
    }));
  }, [leads]);

  const selected = leads.find((lead) => lead.lead_id === selectedId);

  async function move(lead: LeadRow, to: string, tip?: string) {
    if (!canWriteOps) return;
    setBusyId(lead.lead_id);
    try {
      await onPatchLead(lead.lead_id, {
        stage: to,
        tipification: tip || tipification || undefined
      });
      setTipification("");
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 12, overflowX: "auto", alignItems: "stretch", paddingBottom: 4 }}>
        {columns.map((column) => (
          <div key={column.id} style={{ minWidth: 200, flex: "0 0 220px" }}>
            <Card>
              <CardHead title={`${column.label} (${column.items.length})`} />
              {column.items.length === 0 ? (
                <p className="muted tiny">Vacío</p>
              ) : (
                <ul className="col" style={{ gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
                  {column.items.map((lead) => (
                    <li key={lead.lead_id}>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        style={{ width: "100%", textAlign: "left" }}
                        onClick={() => setSelectedId(lead.lead_id)}
                      >
                        {lead.lead_id.slice(0, 8)}
                        <br />
                        <span className="muted tiny">
                          {lead.agency_code ?? "—"} · {lead.tipification ?? "sin tipificar"}
                        </span>
                      </button>
                      {DEFAULT_NEXT_STAGE[lead.stage] ? (
                        <button
                          className="btn btn-sm"
                          type="button"
                          style={{ width: "100%", marginTop: 4 }}
                          disabled={!canWriteOps || busyId === lead.lead_id}
                          onClick={() => void move(lead, DEFAULT_NEXT_STAGE[lead.stage]!)}
                        >
                          Avanzar →
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        ))}
      </div>

      <Card>
        <CardHead title="Tipificación" />
        {!selected ? (
          <EmptyState label="Selecciona un lead del kanban." />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            <p>
              Lead <strong>{selected.lead_id}</strong> · etapa {CRM_STAGE_LABELS[selected.stage] ?? selected.stage}
            </p>
            <input
              className="input"
              placeholder="Tipificación (ej. renovado_ok)"
              value={tipification}
              onChange={(e) => setTipification(e.target.value)}
            />
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button
                className="btn"
                type="button"
                disabled={!canWriteOps || !tipification.trim()}
                onClick={() => void move(selected, selected.stage, tipification.trim())}
              >
                Guardar tipificación
              </button>
              <button
                className="btn"
                type="button"
                disabled={!canWriteOps}
                onClick={() => void move(selected, "no_interes", tipification.trim() || "no_interes")}
              >
                Marcar no interés
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

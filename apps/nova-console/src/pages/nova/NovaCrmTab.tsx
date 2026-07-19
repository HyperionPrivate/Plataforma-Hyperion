import { useEffect, useMemo, useState } from "react";
import { Card, CardHead, EmptyState } from "../../components/ui.js";
import type { LeadRow } from "./types.js";
import { CRM_STAGE_LABELS, CRM_STAGES, DEFAULT_NEXT_STAGE, productLineLabel } from "./types.js";

const GENERIC_TIPIFICATIONS = [
  { value: "qualified", label: "Calificado" },
  { value: "document_requested", label: "Documento solicitado" },
  { value: "callback", label: "Volver a contactar" },
  { value: "unreachable", label: "No fue posible contactar" },
  { value: "not_interested", label: "Sin interés" }
] as const;

const UNASSIGNED_FLOW = "unassigned";

export function NovaCrmTab({
  leads,
  canWriteOps,
  onPatchLead
}: {
  leads: LeadRow[];
  canWriteOps: boolean;
  onPatchLead: (
    leadId: string,
    body: { stage?: string; tipification?: string; product_line?: string }
  ) => Promise<void>;
}) {
  const flowIds = useMemo(
    () => [...new Set(leads.map((lead) => lead.product_line?.trim() || UNASSIGNED_FLOW))].sort(),
    [leads]
  );
  const [productLine, setProductLine] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [tipification, setTipification] = useState("");
  const [busyId, setBusyId] = useState<string>();

  useEffect(() => {
    if (!flowIds.includes(productLine)) setProductLine(flowIds[0] ?? "");
  }, [flowIds, productLine]);

  const filteredLeads = useMemo(
    () => leads.filter((lead) => (lead.product_line?.trim() || UNASSIGNED_FLOW) === productLine),
    [leads, productLine]
  );
  const columns = useMemo(() => {
    const stageIds = [...new Set([...CRM_STAGES, ...filteredLeads.map((lead) => lead.stage).filter(Boolean)])];
    return stageIds.map((stage) => ({
      id: stage,
      label: CRM_STAGE_LABELS[stage] ?? stage,
      items: filteredLeads.filter((lead) => lead.stage === stage)
    }));
  }, [filteredLeads]);
  const selected = filteredLeads.find((lead) => lead.lead_id === selectedId);

  async function move(lead: LeadRow, to: string, tip?: string) {
    if (!canWriteOps) return;
    setBusyId(lead.lead_id);
    try {
      await onPatchLead(lead.lead_id, { stage: to, tipification: tip || tipification || undefined });
      setTipification("");
    } finally {
      setBusyId(undefined);
    }
  }

  if (flowIds.length === 0) return <EmptyState label="No hay leads asociados a flujos del tenant." />;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }} aria-label="Flujos de producto del tenant">
        {flowIds.map((flowId) => {
          const count = leads.filter((lead) => (lead.product_line?.trim() || UNASSIGNED_FLOW) === flowId).length;
          return (
            <button
              key={flowId}
              type="button"
              className={`chip${productLine === flowId ? " active" : ""}`}
              onClick={() => {
                setProductLine(flowId);
                setSelectedId(undefined);
                setTipification("");
              }}
            >
              {productLineLabel(flowId)} ({count})
            </button>
          );
        })}
      </div>

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
        <CardHead title={`Tipificación · ${productLineLabel(productLine)}`} />
        {!selected ? (
          <EmptyState label="Selecciona un lead del tablero." />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            <p>
              Lead <strong>{selected.lead_id}</strong> · etapa {CRM_STAGE_LABELS[selected.stage] ?? selected.stage}
            </p>
            <label className="col" style={{ gap: 4 }}>
              <span className="tiny muted">Tipificación</span>
              <select className="input" value={tipification} onChange={(event) => setTipification(event.target.value)}>
                <option value="">Elegir tipificación…</option>
                {GENERIC_TIPIFICATIONS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <input
              className="input"
              placeholder="O texto libre (opcional)"
              value={tipification}
              onChange={(event) => setTipification(event.target.value)}
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
                onClick={() => void move(selected, "lost", tipification.trim() || "not_interested")}
              >
                Marcar sin interés
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

import { useMemo, useState } from "react";
import { Card, CardHead, EmptyState } from "../../components/ui.js";
import type { LeadRow, NovaProductLine } from "./types.js";
import { CRM_STAGE_LABELS, CRM_STAGES, DEFAULT_NEXT_STAGE, PRODUCT_LINE_LABELS, PRODUCT_LINES } from "./types.js";

const TIPIFICATION_PRESETS: Record<NovaProductLine, Array<{ value: string; label: string }>> = {
  renovacion: [
    { value: "renovado_ok", label: "Renovado OK" },
    { value: "doc_solicitado", label: "Documento solicitado" },
    { value: "callback", label: "Callback" },
    { value: "ocupado", label: "Ocupado / no contesta" },
    { value: "no_interes", label: "No interés" }
  ],
  reactivacion: [
    { value: "reactivado_ok", label: "Reactivado OK" },
    { value: "doc_solicitado", label: "Documento solicitado" },
    { value: "callback", label: "Callback" },
    { value: "ocupado", label: "Ocupado / no contesta" },
    { value: "no_interes", label: "No interés" }
  ],
  nuevos: [
    { value: "precalificado", label: "Precalificado" },
    { value: "doc_solicitado", label: "Documento solicitado" },
    { value: "no_califica", label: "No califica" },
    { value: "callback", label: "Callback" },
    { value: "no_interes", label: "No interés" }
  ],
  microcredito: [
    { value: "aprobado", label: "Aprobado" },
    { value: "rechazado", label: "Rechazado" },
    { value: "doc_solicitado", label: "Documento solicitado" },
    { value: "callback", label: "Callback" },
    { value: "no_interes", label: "No interés" }
  ]
};

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
  const [productLine, setProductLine] = useState<NovaProductLine>("renovacion");
  const [selectedId, setSelectedId] = useState<string>();
  const [tipification, setTipification] = useState("");
  const [busyId, setBusyId] = useState<string>();

  const filteredLeads = useMemo(
    () => leads.filter((lead) => (lead.product_line ?? "renovacion") === productLine),
    [leads, productLine]
  );

  const columns = useMemo(() => {
    return CRM_STAGES.map((stage) => ({
      id: stage,
      label: CRM_STAGE_LABELS[stage] ?? stage,
      items: filteredLeads.filter((lead) => lead.stage === stage)
    }));
  }, [filteredLeads]);

  const selected = filteredLeads.find((lead) => lead.lead_id === selectedId);
  const presets = TIPIFICATION_PRESETS[productLine];

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
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {PRODUCT_LINES.map((line) => {
          const count = leads.filter((lead) => (lead.product_line ?? "renovacion") === line).length;
          return (
            <button
              key={line}
              type="button"
              className={`chip${productLine === line ? " active" : ""}`}
              onClick={() => {
                setProductLine(line);
                setSelectedId(undefined);
                setTipification("");
              }}
            >
              {PRODUCT_LINE_LABELS[line]} ({count})
            </button>
          );
        })}
      </div>

      {(productLine === "nuevos" || productLine === "microcredito") && filteredLeads.length === 0 ? (
        <p className="muted tiny">
          Tablero listo (Alcances). Sin leads aún — el import puede setear <code>product_line</code> más adelante.
        </p>
      ) : null}

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
        <CardHead title={`Tipificación · ${PRODUCT_LINE_LABELS[productLine]}`} />
        {!selected ? (
          <EmptyState label="Selecciona un lead del kanban." />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            <p>
              Lead <strong>{selected.lead_id}</strong> · etapa {CRM_STAGE_LABELS[selected.stage] ?? selected.stage}
            </p>
            <label className="col" style={{ gap: 4 }}>
              <span className="tiny muted">Preset</span>
              <select
                className="input"
                value={presets.some((p) => p.value === tipification) ? tipification : ""}
                onChange={(e) => setTipification(e.target.value)}
              >
                <option value="">Elegir tipificación…</option>
                {presets.map((preset) => (
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

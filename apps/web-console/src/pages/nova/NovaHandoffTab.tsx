import { useMemo, useState } from "react";
import { GaugeChart } from "../../components/nova/charts/index.js";
import { Card, CardHead, EmptyState, Kpi } from "../../components/ui.js";
import { novaAgencyCodes } from "@hyperion/contracts";
import type { HandoffRow } from "./types.js";

export function NovaHandoffTab({
  handoffs,
  onClaim
}: {
  handoffs: HandoffRow[];
  onClaim: (handoffId: string) => Promise<void>;
}) {
  const [agency, setAgency] = useState<string>("all");
  const [busyId, setBusyId] = useState<string>();

  const filtered = useMemo(() => {
    if (agency === "all") return handoffs;
    return handoffs.filter((row) => row.agency_code === agency);
  }, [agency, handoffs]);

  const queued = filtered.filter((row) => row.status === "queued").length;
  const claimed = filtered.filter((row) => row.status === "claimed").length;
  const claimRate = filtered.length > 0 ? Math.round((claimed / filtered.length) * 100) : 0;

  async function claim(id: string) {
    setBusyId(id);
    try {
      await onClaim(id);
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid kpi-row">
        <Kpi label="En cola" value={queued} />
        <Kpi label="Reclamados" value={claimed} />
        <Kpi label="Total filtro" value={filtered.length} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        <Card>
          <CardHead title="Filtro por sede" />
          <select className="input" value={agency} onChange={(e) => setAgency(e.target.value)}>
            <option value="all">Todas las sedes</option>
            {novaAgencyCodes.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
          <div style={{ marginTop: 16 }}>
            <GaugeChart value={claimRate} label="% reclamados en filtro" />
          </div>
        </Card>

        <Card>
          <CardHead title="Cola handoff" />
          {filtered.length === 0 ? (
            <EmptyState label="Cola vacía. Los handoff_requested aparecen filtrados por sede." />
          ) : (
            <ul className="col" style={{ gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
              {filtered.map((handoff) => (
                <li key={handoff.handoff_id} className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                  <span>
                    {handoff.agency_code} · {handoff.status} · {handoff.reason ?? "—"}
                  </span>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={handoff.status !== "queued" || busyId === handoff.handoff_id}
                    onClick={() => void claim(handoff.handoff_id)}
                  >
                    Claim
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

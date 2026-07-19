import { formatNumber } from "../../../lib/format.js";

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  pct: number;
}

export function FunnelChart({ stages }: { stages: FunnelStage[] }) {
  const max = stages[0]?.count || 1;
  return (
    <div className="col" style={{ gap: 8, padding: "4px 0" }}>
      {stages.map((stage, index) => {
        const width = Math.max(28, (stage.count / max) * 100);
        return (
          <div key={stage.key} className="row" style={{ alignItems: "center", gap: 12 }}>
            <div className="muted tiny" style={{ width: 96, textAlign: "right", flexShrink: 0 }}>
              {stage.label}
            </div>
            <div style={{ position: "relative", height: 36, flex: 1 }}>
              <div
                style={{
                  position: "absolute",
                  inset: "0 auto 0 50%",
                  transform: "translateX(-50%)",
                  width: `${width}%`,
                  borderRadius: 8,
                  background: `color-mix(in srgb, var(--accent, #2f9e6e) ${Math.max(40, 100 - index * 10)}%, transparent)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--text, #0a0f0d)",
                  transition: "width 0.6s ease"
                }}
              >
                <span className="tabular">
                  {formatNumber(stage.count)} · {stage.pct}%
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

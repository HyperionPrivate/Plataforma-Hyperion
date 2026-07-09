import { Bot, CalendarCheck, Clock, DollarSign, Smile, TrendingDown } from "lucide-react";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { Layout } from "../components/Layout.js";
import { Card, CardHead, EmptyState, Kpi, LoadingState } from "../components/ui.js";
import { tenantPath, useConsole } from "../lib/context.js";
import { formatCop, formatNumber, GREEN, GREEN_SOFT, INK_2, LINE } from "../lib/format.js";
import { usePolling } from "../lib/hooks.js";

interface BiResponse {
  totals: {
    interactions: number;
    resolved: number;
    transferred: number;
    avgResponseSeconds: number | null;
    absorptionPct: number | null;
  };
  weeklyAppointments: Array<{ week: string; whatsapp: number; voice: number; total: number }>;
  funnel: {
    interactions: number;
    appointmentIntent: number;
    availabilityChecked: number;
    registered: number;
    verified: number;
    confirmed: number;
  };
  payerDistribution: Array<{ payerGroup: string; total: number }>;
  noShowWeekly: Array<{ week: string; noShowPct: number }>;
  baseline: { noShowPct: number; costPerInteractionCop: number };
  savings: {
    interactionsAbsorbed: number;
    hoursFreed: number;
    savingsCop: number;
    platformCostPerInteractionCop: number;
  };
}

const PAYER_LABELS: Record<string, string> = {
  eps: "EPS",
  private_prepaid: "Prepagada",
  policy: "Polizas",
  particular: "Particular",
  other: "Otros"
};

const PAYER_COLORS = ["#2f9e6e", "#1e6b4a", "#7cc4a4", "#b7e0cd", "#c9d3ce"];

export function BiPage() {
  const { tenant, logout } = useConsole();
  const { data, loading, error } = usePolling<BiResponse>(tenantPath(tenant.id, "bi/monthly"), 60_000, logout);

  const funnelRows = useMemo(() => {
    if (!data) return [];
    const f = data.funnel;
    return [
      { label: "Interacciones", value: f.interactions },
      { label: "Intencion de cita", value: f.appointmentIntent },
      { label: "Disponibilidad consultada", value: f.availabilityChecked },
      { label: "Cita registrada (RPA)", value: f.registered },
      { label: "Verificadas", value: f.verified },
      { label: "Confirmadas", value: f.confirmed }
    ];
  }, [data]);

  return (
    <Layout title="BI y Reportes" subtitle="Resultados del mes en curso">
      {error ? (
        <div className="banner">{error}</div>
      ) : !data && loading ? (
        <LoadingState />
      ) : data ? (
        <>
          <div className="grid kpi-row">
            <Kpi
              label="Absorcion IA"
              value={data.totals.absorptionPct == null ? "-" : `${data.totals.absorptionPct}%`}
              icon={<Bot size={16} />}
            />
            <Kpi
              label="Citas agendadas"
              value={formatNumber(data.funnel.registered)}
              icon={<CalendarCheck size={16} />}
            />
            <Kpi
              label="Tiempo medio respuesta"
              value={data.totals.avgResponseSeconds == null ? "-" : `${data.totals.avgResponseSeconds} s`}
              icon={<Clock size={16} />}
            />
            <Kpi
              label="Interacciones absorbidas"
              value={formatNumber(data.savings.interactionsAbsorbed)}
              icon={<Smile size={16} />}
            />
            <Kpi
              label="Ahorro estimado"
              value={`${formatCop(data.savings.savingsCop)}/mes`}
              icon={<DollarSign size={16} />}
            />
          </div>

          <div className="grid" style={{ gridTemplateColumns: "1.3fr 1fr" }}>
            <Card>
              <CardHead title="Citas agendadas por canal por semana" icon={<CalendarCheck size={18} />} />
              <div className="card-pad" style={{ height: 260 }}>
                {data.weeklyAppointments.length === 0 ? (
                  <EmptyState label="Sin citas en el periodo" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={data.weeklyAppointments.map((w, i) => ({
                        semana: `Sem ${i + 1}`,
                        WhatsApp: w.whatsapp,
                        Voz: w.voice
                      }))}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke={LINE} vertical={false} />
                      <XAxis dataKey="semana" tick={{ fontSize: 11, fill: INK_2 }} stroke={LINE} />
                      <YAxis tick={{ fontSize: 11, fill: INK_2 }} stroke={LINE} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="WhatsApp" stackId="a" fill={GREEN_SOFT} radius={[0, 0, 0, 0]} />
                      <Bar dataKey="Voz" stackId="a" fill={GREEN} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>

            <Card>
              <CardHead title="Distribucion por convenio" icon={<Bot size={18} />} />
              <div className="card-pad row" style={{ gap: 12, alignItems: "center" }}>
                <div style={{ width: 150, height: 180 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={data.payerDistribution}
                        dataKey="total"
                        nameKey="payerGroup"
                        innerRadius={46}
                        outerRadius={72}
                        paddingAngle={2}
                      >
                        {data.payerDistribution.map((entry, index) => (
                          <Cell key={entry.payerGroup} fill={PAYER_COLORS[index % PAYER_COLORS.length]} stroke="none" />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="col" style={{ gap: 8, flex: 1 }}>
                  {data.payerDistribution.map((entry, index) => {
                    const total = data.payerDistribution.reduce((sum, e) => sum + e.total, 0);
                    return (
                      <div key={entry.payerGroup} className="row between">
                        <span className="row small" style={{ gap: 8 }}>
                          <span className="dot" style={{ background: PAYER_COLORS[index % PAYER_COLORS.length] }} />
                          {PAYER_LABELS[entry.payerGroup] ?? entry.payerGroup}
                        </span>
                        <strong className="small">{total > 0 ? Math.round((100 * entry.total) / total) : 0}%</strong>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Card>
          </div>

          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Card>
              <CardHead title="Embudo de agendamiento" icon={<CalendarCheck size={18} />} />
              <div className="card-pad col" style={{ gap: 6 }}>
                {funnelRows.map((row, index) => {
                  const max = funnelRows[0].value || 1;
                  const width = Math.max(12, Math.round((100 * row.value) / max));
                  return (
                    <div key={row.label} className="col" style={{ gap: 2 }}>
                      <div className="row between tiny muted">
                        <span>
                          {index + 1}. {row.label}
                        </span>
                        <span>{formatNumber(row.value)}</span>
                      </div>
                      <div style={{ height: 26, background: "var(--surface-2)", borderRadius: 6 }}>
                        <div
                          style={{
                            width: `${width}%`,
                            height: "100%",
                            background: index === 0 ? "#1e6b4a" : GREEN,
                            opacity: 1 - index * 0.12,
                            borderRadius: 6
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            <Card>
              <CardHead title="No-show: antes vs. despues" icon={<TrendingDown size={18} />} />
              <div className="card-pad" style={{ height: 240 }}>
                {data.noShowWeekly.length === 0 ? (
                  <EmptyState label="Sin datos de no-show" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={data.noShowWeekly.map((w, i) => ({
                        semana: `Sem ${i + 1}`,
                        "Con IA": w.noShowPct,
                        "Linea base": data.baseline.noShowPct
                      }))}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke={LINE} vertical={false} />
                      <XAxis dataKey="semana" tick={{ fontSize: 11, fill: INK_2 }} stroke={LINE} />
                      <YAxis tick={{ fontSize: 11, fill: INK_2 }} stroke={LINE} unit="%" />
                      <Tooltip />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="Linea base"
                        stroke="#c9d3ce"
                        strokeDasharray="5 4"
                        strokeWidth={2}
                        dot={false}
                      />
                      <Line type="monotone" dataKey="Con IA" stroke={GREEN} strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>
          </div>

          <Card>
            <CardHead title="Ahorro operativo" icon={<DollarSign size={18} />} />
            <div className="card-pad grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              <div className="col">
                <span className="kpi-value">{formatNumber(data.savings.interactionsAbsorbed)}</span>
                <span className="tiny muted">Interacciones absorbidas por IA</span>
              </div>
              <div className="col">
                <span className="kpi-value">{formatNumber(data.savings.hoursFreed)} h</span>
                <span className="tiny muted">Horas de call center liberadas</span>
              </div>
              <div className="col">
                <span className="kpi-value" style={{ color: GREEN }}>
                  {formatCop(data.savings.savingsCop)}/mes
                </span>
                <span className="tiny muted">
                  Ahorro estimado ({formatCop(data.savings.platformCostPerInteractionCop)} vs{" "}
                  {formatCop(data.baseline.costPerInteractionCop)} por interaccion*)
                </span>
              </div>
            </div>
            <div className="card-pad tiny muted" style={{ paddingTop: 0 }}>
              *Linea base segun supuestos S6/S9 del requerimiento, a contrastar en Fase 0.
            </div>
          </Card>
        </>
      ) : (
        <EmptyState label="Sin datos de BI" />
      )}
    </Layout>
  );
}

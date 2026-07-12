import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  FileCheck2,
  Mic2,
  ReceiptText,
  Stethoscope,
  UsersRound
} from "lucide-react";
import { useMemo, useState } from "react";
import { LUMEN_ADOPTION_TREND, LUMEN_DOCUMENTATION_TREND, LUMEN_PROFESSIONALS } from "../../../lib/lumen-demo-data.js";
import { LumenDemoHeading, LumenDemoNotice, LumenMetricCard } from "./LumenDemoShared.js";

type DashboardPeriod = "month" | "quarter" | "year";

const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  month: "Septiembre 2026",
  quarter: "Último trimestre",
  year: "Últimos 12 meses"
};

export function LumenDashboardView() {
  const [period, setPeriod] = useState<DashboardPeriod>("quarter");
  const [selectedProfessional, setSelectedProfessional] = useState("Dra. Camacho");
  const professional = LUMEN_PROFESSIONALS.find((item) => item.name === selectedProfessional) ?? LUMEN_PROFESSIONALS[0];
  const maxConsultations = Math.max(...LUMEN_PROFESSIONALS.map((item) => item.consultations));

  const metrics = useMemo(() => {
    if (period === "month") return { consultations: "1.486", revenue: "$537 M", hours: "226 h" };
    if (period === "year") return { consultations: "17.920", revenue: "$6.448 M", hours: "2.720 h" };
    return { consultations: "4.480", revenue: "$1.612 M", hours: "680 h" };
  }, [period]);

  return (
    <section className="lumen-demo-view lumen-dashboard-view" aria-labelledby="lumen-dashboard-title">
      <LumenDemoHeading
        id="lumen-dashboard-title"
        eyebrow="Inteligencia operativa"
        title="Dashboard gerencial"
        description="Productividad clínica, adopción y ciclo financiero · métricas sintéticas"
        actions={
          <label className="lumen-period-control">
            <CalendarDays size={17} aria-hidden="true" />
            <span className="visually-hidden">Periodo del dashboard</span>
            <select value={period} onChange={(event) => setPeriod(event.target.value as DashboardPeriod)}>
              {Object.entries(PERIOD_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <div className="lumen-demo-metrics lumen-dashboard-metrics">
        <LumenMetricCard
          icon={<Stethoscope size={21} />}
          label="Consultas documentadas"
          value={metrics.consultations}
          detail="Cohorte demo"
        />
        <LumenMetricCard
          icon={<Clock3 size={21} />}
          label="Documentación promedio"
          value="3,67 min"
          detail="Antes: 11 min"
        />
        <LumenMetricCard
          icon={<FileCheck2 size={21} />}
          label="HC completas al firmar"
          value="98,7 %"
          detail="+4,2 pp"
        />
        <LumenMetricCard
          icon={<UsersRound size={21} />}
          label="Adopción profesional"
          value="23 / 25"
          detail="92 % activos"
          tone="blue"
        />
        <LumenMetricCard
          icon={<ReceiptText size={21} />}
          label="Facturación estimada"
          value={metrics.revenue}
          detail="Datos demo"
        />
      </div>

      <div className="lumen-dashboard-grid">
        <article className="lumen-dashboard-panel lumen-professional-panel">
          <div className="lumen-demo-panel-heading">
            <div>
              <span className="lumen-eyebrow">Rendimiento</span>
              <h2>Productividad por profesional</h2>
            </div>
            <span>Consultas · tiempo</span>
          </div>
          <div className="lumen-professional-list">
            {LUMEN_PROFESSIONALS.map((item, index) => (
              <button
                type="button"
                key={item.name}
                className={selectedProfessional === item.name ? "active" : ""}
                onClick={() => setSelectedProfessional(item.name)}
              >
                <span>{index + 1}</span>
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.specialty}</small>
                </div>
                <i>
                  <b style={{ width: `${(item.consultations / maxConsultations) * 100}%` }} />
                </i>
                <strong>{item.consultations}</strong>
                <em>{item.minutes.toLocaleString("es-CO")} min</em>
              </button>
            ))}
          </div>
          <footer>
            <span>Selección activa</span>
            <strong>
              {professional.name} · {professional.consultations} consultas ·{" "}
              {professional.minutes.toLocaleString("es-CO")} min
            </strong>
          </footer>
        </article>

        <article className="lumen-dashboard-panel lumen-documentation-panel">
          <div className="lumen-demo-panel-heading">
            <div>
              <span className="lumen-eyebrow">Últimas 12 semanas</span>
              <h2>Tiempo de documentación</h2>
            </div>
            <span className="lumen-trend-positive">
              <ArrowDownRight size={15} /> −66,6 %
            </span>
          </div>
          <DocumentationChart />
        </article>

        <article className="lumen-dashboard-panel lumen-revenue-panel">
          <div className="lumen-demo-panel-heading">
            <div>
              <span className="lumen-eyebrow">Ciclo financiero</span>
              <h2>Facturación por convenio</h2>
            </div>
            <strong>$1.612 M</strong>
          </div>
          <RevenueChart />
        </article>

        <article className="lumen-dashboard-panel lumen-voice-panel">
          <div className="lumen-demo-panel-heading">
            <div>
              <span className="lumen-eyebrow">Adopción</span>
              <h2>Uso del dictado por voz</h2>
            </div>
            <span className="lumen-trend-positive">
              <ArrowUpRight size={15} /> +8 pp
            </span>
          </div>
          <div className="lumen-voice-donut" role="img" aria-label="86 por ciento de consultas con dictado por voz">
            <div>
              <Mic2 size={24} aria-hidden="true" />
              <strong>86 %</strong>
              <span>de consultas</span>
            </div>
          </div>
          <div className="lumen-voice-legend">
            <span>
              <i /> Con dictado <strong>86 %</strong>
            </span>
            <span>
              <i /> Sin dictado <strong>14 %</strong>
            </span>
          </div>
          <AdoptionSparkline />
        </article>

        <article className="lumen-dashboard-panel lumen-hours-panel">
          <span className="lumen-hours-icon">
            <Stethoscope size={36} aria-hidden="true" />
          </span>
          <div>
            <small>Horas médicas liberadas</small>
            <strong>{metrics.hours}</strong>
            <span>en el periodo seleccionado</span>
          </div>
          <hr />
          <p>
            <CheckCircle2 size={17} aria-hidden="true" /> ≈ 3.400 consultas adicionales posibles
          </p>
        </article>
      </div>

      <LumenDemoNotice>
        Los indicadores son sintéticos y sirven para demostrar la experiencia gerencial; no representan operación real
        de CEDCO.
      </LumenDemoNotice>
    </section>
  );
}

function DocumentationChart() {
  const width = 720;
  const height = 240;
  const min = 2;
  const max = 12;
  const points = LUMEN_DOCUMENTATION_TREND.map((item, index) => ({
    ...item,
    x: 42 + (index / (LUMEN_DOCUMENTATION_TREND.length - 1)) * (width - 70),
    y: 24 + ((max - item.minutes) / (max - min)) * (height - 62)
  }));
  const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <svg
      className="lumen-documentation-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="El tiempo de documentación baja de 10 a 3,67 minutos en doce semanas"
    >
      {[2, 4, 6, 8, 10, 12].map((tick) => {
        const y = 24 + ((max - tick) / (max - min)) * (height - 62);
        return (
          <g key={tick}>
            <line x1="42" x2={width - 28} y1={y} y2={y} />
            <text x="8" y={y + 4}>
              {tick}
            </text>
          </g>
        );
      })}
      <polyline points={polyline} fill="none" />
      {points.map((point) => (
        <g key={point.week}>
          <circle cx={point.x} cy={point.y} r="4" />
          <text x={point.x} y={height - 10} textAnchor="middle">
            {point.week}
          </text>
        </g>
      ))}
      <g className="lumen-chart-callout">
        <rect x={points[3]!.x - 58} y="4" width="116" height="26" rx="6" />
        <text x={points[3]!.x} y="21" textAnchor="middle">
          Inicio piloto
        </text>
      </g>
    </svg>
  );
}

function RevenueChart() {
  const eps = "20,178 80,160 140,145 200,128 260,108 320,91 380,70 440,42 500,22";
  const prepaid = "20,208 80,195 140,182 200,167 260,151 320,133 380,113 440,93 500,75";
  const privateSeries = "20,232 80,226 140,216 200,207 260,198 320,189 380,173 440,155 500,138";
  return (
    <svg
      className="lumen-revenue-chart"
      viewBox="0 0 530 260"
      role="img"
      aria-label="Crecimiento sintético de facturación por convenio"
    >
      {[50, 100, 150, 200].map((y) => (
        <line key={y} x1="20" x2="505" y1={y} y2={y} />
      ))}
      <polygon points={`20,238 ${eps} 500,238`} className="eps-area" />
      <polyline points={eps} className="eps-line" />
      <polyline points={prepaid} className="prepaid-line" />
      <polyline points={privateSeries} className="private-line" />
      <text x="505" y="24">
        $812 M
      </text>
      <text x="505" y="76">
        $532 M
      </text>
      <text x="505" y="140">
        $268 M
      </text>
    </svg>
  );
}

function AdoptionSparkline() {
  const points = LUMEN_ADOPTION_TREND.map((item, index) => `${8 + index * 34},${66 - item.adoption * 0.58}`).join(" ");
  return (
    <svg
      className="lumen-adoption-sparkline"
      viewBox="0 0 260 72"
      role="img"
      aria-label="Adopción creciente del dictado por voz"
    >
      <polyline points={points} fill="none" />
    </svg>
  );
}

import { Beaker, FlaskConical, ShieldCheck, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

export function LumenDemoBadge({ label = "Demo guiada" }: { label?: string }) {
  return (
    <span className="lumen-demo-badge">
      <Sparkles size={13} aria-hidden="true" />
      {label}
    </span>
  );
}

export function LumenDemoNotice({ children }: { children: ReactNode }) {
  return (
    <div className="lumen-demo-notice" role="note">
      <ShieldCheck size={17} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function LumenDemoHeading({
  id,
  eyebrow,
  title,
  description,
  actions
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="lumen-demo-heading">
      <div>
        <span className="lumen-eyebrow">{eyebrow}</span>
        <h1 id={id}>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="lumen-demo-heading-actions">
        <LumenDemoBadge />
        {actions}
      </div>
    </header>
  );
}

export function LumenMetricCard({
  icon,
  label,
  value,
  detail,
  tone = "green"
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: "green" | "amber" | "blue";
}) {
  return (
    <article className={`lumen-demo-metric tone-${tone}`}>
      <span className="lumen-demo-metric-icon">{icon}</span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

export function LumenOctPreview() {
  return (
    <svg
      className="lumen-oct-preview"
      viewBox="0 0 640 260"
      role="img"
      aria-label="OCT sintético de retina del ojo izquierdo"
    >
      <defs>
        <linearGradient id="octBackground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#111815" />
          <stop offset="1" stopColor="#020403" />
        </linearGradient>
        <filter id="octGlow">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="640" height="260" rx="18" fill="url(#octBackground)" />
      {Array.from({ length: 26 }, (_, index) => (
        <path
          key={index}
          d={`M 20 ${88 + index * 3.8} C 150 ${72 + index * 4}, 235 ${82 + index * 3}, 310 ${
            112 + Math.sin(index / 4) * 6 + index * 2.4
          } C 390 ${84 + index * 3.2}, 505 ${72 + index * 3.8}, 620 ${94 + index * 3.5}`}
          fill="none"
          stroke={index % 5 === 0 ? "#eef8f3" : "#82908a"}
          strokeOpacity={0.22 + (index % 5) * 0.08}
          strokeWidth={index % 5 === 0 ? 2.2 : 1}
          filter={index % 5 === 0 ? "url(#octGlow)" : undefined}
        />
      ))}
      <line x1="470" x2="590" y1="226" y2="226" stroke="#fff" strokeWidth="3" />
      <text x="492" y="216" fill="#fff" fontSize="13">
        200 µm
      </text>
      <text x="22" y="30" fill="#8fe1ba" fontSize="15" fontWeight="700">
        OCT RNFL OI · DEMO
      </text>
      <text x="526" y="30" fill="#8fe1ba" fontSize="15" fontWeight="700">
        71 µm
      </text>
    </svg>
  );
}

export function LumenLabPaper({
  title,
  patient,
  takenAt,
  parameters
}: {
  title: string;
  patient: string;
  takenAt: string;
  parameters: readonly { name: string; value: string; unit: string; range: string }[];
}) {
  return (
    <div className="lumen-lab-paper" aria-label="Documento sintético de laboratorio">
      <div className="lumen-lab-paper-brand">
        <span>
          <FlaskConical size={27} aria-hidden="true" />
        </span>
        <div>
          <strong>LABORATORIO CLÍNICO</strong>
          <small>{title.toLocaleUpperCase("es")} · DEMO</small>
        </div>
      </div>
      <div className="lumen-lab-paper-patient">
        <span>Paciente</span>
        <strong>{patient}</strong>
        <span>Fecha de toma</span>
        <strong>{takenAt}</strong>
      </div>
      <div className="lumen-lab-paper-table">
        <div className="head">Examen</div>
        <div className="head">Resultado</div>
        <div className="head">Referencia</div>
        {parameters.length ? (
          parameters.slice(0, 5).map((parameter) => (
            <div className="lumen-lab-paper-row" key={parameter.name}>
              <span>{parameter.name}</span>
              <strong>
                {parameter.value} {parameter.unit}
              </strong>
              <span>{parameter.range}</span>
            </div>
          ))
        ) : (
          <div className="lumen-lab-paper-processing">
            <span>Extracción en curso</span>
            <strong>Los campos aparecerán al finalizar el OCR clínico.</strong>
          </div>
        )}
      </div>
      <div className="lumen-lab-paper-seal">
        <Beaker size={20} aria-hidden="true" />
        Documento generado exclusivamente para demostración
      </div>
    </div>
  );
}

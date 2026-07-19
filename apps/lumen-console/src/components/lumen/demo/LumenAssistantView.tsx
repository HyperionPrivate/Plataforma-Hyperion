import type { LumenEncounterDetail } from "@hyperion/lumen-contracts";
import {
  AlertTriangle,
  ArrowUp,
  BookOpenCheck,
  CalendarClock,
  CheckCircle2,
  FileCheck2,
  HeartPulse,
  Link2,
  Mic,
  Pill,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LumenDemoHeading, LumenDemoNotice, LumenOctPreview } from "./LumenDemoShared.js";

interface DemoMessage {
  id: number;
  role: "clinician" | "assistant";
  text: string;
  kind?: "trend" | "warning" | "action" | "oct";
  sources?: string[];
}

const INITIAL_MESSAGES: DemoMessage[] = [
  {
    id: 1,
    role: "clinician",
    text: "¿Cómo ha variado la PIO del ojo izquierdo durante el último año?"
  },
  {
    id: 2,
    role: "assistant",
    text: "La PIO OI subió de 19 a 24 mmHg en once meses y supera la meta registrada de 18 mmHg.",
    kind: "trend",
    sources: ["Control 14 oct 2025", "Control 12 mar 2026", "Consulta demo de hoy"]
  },
  {
    id: 3,
    role: "clinician",
    text: "¿Qué debo verificar si considero adicionar timolol?"
  },
  {
    id: 4,
    role: "assistant",
    text: "Verifique antecedente de asma o EPOC y frecuencia cardiaca. No hay un antecedente respiratorio confirmado en el expediente sintético.",
    kind: "warning",
    sources: ["Antecedentes del encuentro", "Fórmula vigente"]
  }
];

const QUICK_PROMPTS = ["Muéstrame el último OCT", "Resume los pendientes", "Prepara control en 6 semanas"] as const;

export function LumenAssistantView({ detail }: { detail: LumenEncounterDetail }) {
  const [messages, setMessages] = useState<DemoMessage[]>(INITIAL_MESSAGES);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const nextId = useRef(10);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );

  function ask(value: string) {
    const question = value.trim();
    if (!question || pending) return;
    const clinicianId = nextId.current++;
    setMessages((current) => [...current, { id: clinicianId, role: "clinician", text: question }]);
    setQuery("");
    setPending(true);
    timer.current = window.setTimeout(() => {
      setMessages((current) => [...current, assistantReply(nextId.current++, question)]);
      setPending(false);
    }, 520);
  }

  return (
    <section className="lumen-demo-view lumen-assistant-view" aria-labelledby="lumen-assistant-title">
      <LumenDemoHeading
        id="lumen-assistant-title"
        eyebrow="Apoyo clínico trazable"
        title="Asistente clínico"
        description={`Contexto activo: ${detail.encounter.patientDisplayName}`}
      />

      <div className="lumen-assistant-layout">
        <div className="lumen-assistant-conversation">
          <div className="lumen-assistant-prompt-row" aria-label="Preguntas rápidas">
            {QUICK_PROMPTS.map((prompt) => (
              <button key={prompt} type="button" onClick={() => ask(prompt)} disabled={pending}>
                <Sparkles size={14} aria-hidden="true" />
                {prompt}
              </button>
            ))}
          </div>

          <div className="lumen-assistant-messages" aria-live="polite">
            {messages.map((message) => (
              <article className={`lumen-chat-message role-${message.role}`} key={message.id}>
                <span className="lumen-chat-avatar" aria-hidden="true">
                  {message.role === "assistant" ? <Sparkles size={19} /> : initials(detail.encounter.professionalName)}
                </span>
                <div className="lumen-chat-bubble">
                  <p>{message.text}</p>
                  {message.kind === "trend" ? <PressureMiniChart /> : null}
                  {message.kind === "warning" ? (
                    <div className="lumen-chat-warning">
                      <AlertTriangle size={16} aria-hidden="true" />
                      Requiere verificación profesional antes de modificar el plan.
                    </div>
                  ) : null}
                  {message.kind === "oct" ? <LumenOctPreview /> : null}
                  {message.kind === "action" ? (
                    <div className="lumen-chat-action-result">
                      <CheckCircle2 size={16} aria-hidden="true" />
                      Acción preparada como borrador de demostración.
                    </div>
                  ) : null}
                  {message.sources?.length ? (
                    <div className="lumen-chat-sources">
                      {message.sources.map((source) => (
                        <span key={source}>
                          <Link2 size={13} aria-hidden="true" /> {source}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <time>{message.role === "assistant" ? "10:18" : "10:17"}</time>
                </div>
              </article>
            ))}
            {pending ? (
              <div className="lumen-assistant-typing" role="status">
                <Sparkles size={17} aria-hidden="true" />
                <span />
                <span />
                <span />
                <small>LUMEN está consultando fuentes sintéticas</small>
              </div>
            ) : null}
          </div>

          <form
            className="lumen-assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              ask(query);
            }}
          >
            <button type="button" className="icon-btn" aria-label="Pregunta por voz no activa en demo" disabled>
              <Mic size={19} aria-hidden="true" />
            </button>
            <label>
              <span className="visually-hidden">Pregunta clínica</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Pregunta sobre el expediente sintético"
              />
            </label>
            <button
              type="submit"
              className="lumen-send-button"
              disabled={!query.trim() || pending}
              aria-label="Enviar pregunta"
            >
              <ArrowUp size={19} aria-hidden="true" />
            </button>
          </form>

          <LumenDemoNotice>
            Apoyo informativo con fuentes sintéticas. La conducta clínica siempre corresponde al profesional.
          </LumenDemoNotice>
        </div>

        <aside className="lumen-assistant-context" aria-label="Contexto clínico activo">
          <div className="lumen-assistant-patient">
            <span>{initials(detail.encounter.patientDisplayName)}</span>
            <div>
              <small>Paciente en contexto</small>
              <strong>{detail.encounter.patientDisplayName}</strong>
              <p>
                {detail.encounter.patientAge} años · {detail.encounter.payer}
              </p>
            </div>
          </div>

          <ContextFact icon={<HeartPulse size={18} />} title="Diagnóstico relevante">
            H40.11 · Glaucoma primario de ángulo abierto AO
          </ContextFact>
          <ContextFact icon={<Pill size={18} />} title="Medicación activa">
            Latanoprost 0,005 % · noche AO
          </ContextFact>
          <ContextFact icon={<FileCheck2 size={18} />} title="Últimos estudios">
            OCT RNFL y campo visual 24-2 · 10 sep 2026
          </ContextFact>
          <ContextFact icon={<CalendarClock size={18} />} title="Pendientes">
            Control con curva de PIO en seis semanas
          </ContextFact>

          <div className="lumen-assistant-context-footer">
            <BookOpenCheck size={18} aria-hidden="true" />
            <span>7 fuentes disponibles</span>
            <ShieldCheck size={17} aria-hidden="true" />
            <span>Solo datos demo</span>
          </div>
        </aside>
      </div>
    </section>
  );
}

function ContextFact({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="lumen-assistant-context-fact">
      <span>{icon}</span>
      <div>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
    </section>
  );
}

function PressureMiniChart() {
  return (
    <div className="lumen-chat-trend" aria-label="Tendencia PIO OI 19, 21 y 24 milímetros de mercurio">
      <div>
        <span>Oct 2025</span>
        <strong>19</strong>
      </div>
      <i />
      <div>
        <span>Mar 2026</span>
        <strong>21</strong>
      </div>
      <i className="alert" />
      <div className="alert">
        <span>Hoy</span>
        <strong>24</strong>
      </div>
      <small>Meta 18 mmHg</small>
    </div>
  );
}

function assistantReply(id: number, question: string): DemoMessage {
  const normalized = question.toLocaleLowerCase("es");
  if (normalized.includes("oct")) {
    return {
      id,
      role: "assistant",
      text: "El último OCT RNFL sintético es del 10 de septiembre de 2026: OD 84 µm y OI 71 µm, pendiente de revisión.",
      kind: "oct",
      sources: ["OCT RNFL · 10 sep 2026"]
    };
  }
  if (normalized.includes("pendiente")) {
    return {
      id,
      role: "assistant",
      text: "Hay un grado de gonioscopía por confirmar y un OCT pendiente de revisión antes de cerrar el encuentro.",
      kind: "warning",
      sources: ["Transcript demo", "OCT RNFL · 10 sep 2026"]
    };
  }
  if (normalized.includes("6 semanas") || normalized.includes("control")) {
    return {
      id,
      role: "assistant",
      text: "Preparé una solicitud de control en seis semanas. Permanece como borrador y no fue enviada a la agenda externa.",
      kind: "action",
      sources: ["Plan clínico en revisión"]
    };
  }
  return {
    id,
    role: "assistant",
    text: "No encuentro una respuesta trazable en el expediente sintético. Reformule la pregunta o abra una fuente específica.",
    kind: "warning"
  };
}

function initials(value: string): string {
  return value
    .replace(/· Demo/gi, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("es"))
    .join("");
}

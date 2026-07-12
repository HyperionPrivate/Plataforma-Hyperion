import type { LumenEncounterDetail } from "@hyperion/contracts";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  Eraser,
  Fingerprint,
  LockKeyhole,
  MessageCircleQuestion,
  PenLine,
  ShieldCheck,
  Signature,
  UserRoundCheck,
  Volume2
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { LumenDemoHeading, LumenDemoNotice } from "./LumenDemoShared.js";

const CONSENT_SECTIONS = [
  {
    title: "Procedimiento propuesto",
    text: "Trabeculoplastia láser selectiva del ojo izquierdo para apoyar el control de la presión intraocular."
  },
  {
    title: "Riesgos explicados",
    text: "Inflamación, elevación transitoria de la PIO, dolor, visión borrosa y necesidad de tratamiento adicional."
  },
  {
    title: "Alternativas",
    text: "Continuar manejo farmacológico, ajustar medicación o no realizar el procedimiento, según decisión clínica."
  },
  {
    title: "Declaración de entendimiento",
    text: "La persona declara haber recibido información clara y haber tenido oportunidad de formular preguntas."
  }
] as const;

export function LumenConsentView({ detail, canWrite }: { detail: LumenEncounterDetail; canWrite: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | undefined>(undefined);
  const [confirmed, setConfirmed] = useState(() => CONSENT_SECTIONS.map(() => true));
  const [hasSignature, setHasSignature] = useState(false);
  const [sealed, setSealed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#22302b";
    context.lineWidth = 5;
  }, []);

  function pointFrom(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height
    };
  }

  function startDrawing(event: PointerEvent<HTMLCanvasElement>) {
    if (!canWrite || sealed) return;
    drawing.current = true;
    lastPoint.current = pointFrom(event);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function draw(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !lastPoint.current || sealed) return;
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    const point = pointFrom(event);
    context.beginPath();
    context.moveTo(lastPoint.current.x, lastPoint.current.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    lastPoint.current = point;
    setHasSignature(true);
  }

  function stopDrawing(event: PointerEvent<HTMLCanvasElement>) {
    drawing.current = false;
    lastPoint.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || sealed) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  }

  const allConfirmed = confirmed.every(Boolean);

  return (
    <section className="lumen-demo-view lumen-consent-view" aria-labelledby="lumen-consent-title">
      <LumenDemoHeading
        id="lumen-consent-title"
        eyebrow="Consentimiento digital"
        title="Consentimiento informado"
        description="Trabeculoplastia láser selectiva (SLT) · Ojo izquierdo"
      />

      <div className="lumen-consent-patient">
        <span>{initials(detail.encounter.patientDisplayName)}</span>
        <div>
          <small>Paciente sintético</small>
          <strong>{detail.encounter.patientDisplayName}</strong>
          <p>
            {detail.encounter.documentMasked} · {detail.encounter.patientAge} años · H40.11
          </p>
        </div>
        <div className="lumen-consent-read-state">
          <Volume2 size={18} aria-hidden="true" />
          <span>
            <strong>Lectura en voz alta completada</strong>
            <small>3 min 40 s · reproducción demo</small>
          </span>
          <CheckCircle2 size={18} aria-hidden="true" />
        </div>
      </div>

      <div className="lumen-consent-layout">
        <article className="lumen-consent-document">
          <header>
            <span className="lumen-consent-document-icon">
              <ShieldCheck size={22} aria-hidden="true" />
            </span>
            <div>
              <span className="lumen-eyebrow">Documento clínico demo</span>
              <h2>Información revisada con el paciente</h2>
            </div>
            <span>
              {confirmed.filter(Boolean).length}/{CONSENT_SECTIONS.length}
            </span>
          </header>

          <div className="lumen-consent-sections">
            {CONSENT_SECTIONS.map((section, index) => (
              <details key={section.title} open={index === 0}>
                <summary>
                  <span>{index + 1}</span>
                  <strong>{section.title}</strong>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <div className="lumen-consent-section-body">
                  <p>{section.text}</p>
                  <button
                    type="button"
                    className={confirmed[index] ? "confirmed" : ""}
                    onClick={() => {
                      if (!sealed)
                        setConfirmed((current) => current.map((value, item) => (item === index ? !value : value)));
                    }}
                    disabled={!canWrite || sealed}
                    aria-label={`${confirmed[index] ? "Desmarcar" : "Confirmar"} ${section.title}`}
                  >
                    <Check size={17} aria-hidden="true" />
                    {confirmed[index] ? "Confirmado" : "Confirmar"}
                  </button>
                </div>
              </details>
            ))}
          </div>

          <LumenDemoNotice>
            El texto, la persona y el procedimiento son sintéticos. Esta pantalla no genera un consentimiento legal.
          </LumenDemoNotice>
        </article>

        <aside className="lumen-consent-signature-panel">
          <div className="lumen-demo-panel-heading">
            <div>
              <span className="lumen-eyebrow">Firma en dispositivo</span>
              <h2>{sealed ? "Evidencia demo sellada" : "Firme con dedo o stylus"}</h2>
            </div>
            {sealed ? <LockKeyhole size={20} aria-hidden="true" /> : <Signature size={20} aria-hidden="true" />}
          </div>

          <div className={`lumen-signature-pad${sealed ? " sealed" : ""}`}>
            <canvas
              ref={canvasRef}
              width={900}
              height={230}
              onPointerDown={startDrawing}
              onPointerMove={draw}
              onPointerUp={stopDrawing}
              onPointerCancel={stopDrawing}
              aria-label="Área de firma sintética"
            />
            {!hasSignature ? (
              <span>
                <PenLine size={24} aria-hidden="true" />
                Dibuje una firma de prueba
              </span>
            ) : null}
          </div>

          <div className="lumen-consent-signature-actions">
            <button
              className="btn btn-outline"
              type="button"
              onClick={clearSignature}
              disabled={!hasSignature || sealed}
            >
              <Eraser size={16} aria-hidden="true" /> Borrar
            </button>
            <button className="btn btn-outline" type="button" disabled>
              <Fingerprint size={16} aria-hidden="true" /> Huella alternativa
            </button>
          </div>

          <div className="lumen-consent-witness">
            <UserRoundCheck size={20} aria-hidden="true" />
            <span>
              <small>Testigo sintético</small>
              <strong>Enfermería · Demo</strong>
            </span>
            <CheckCircle2 size={18} aria-hidden="true" />
          </div>

          <div className="lumen-consent-proof">
            <div>
              <Clock3 size={17} aria-hidden="true" />
              <span>
                <small>Estampa de tiempo</small>
                <strong>{sealed ? "15 sep 2026 · 10:42 a. m." : "Pendiente"}</strong>
              </span>
            </div>
            <div>
              <Fingerprint size={17} aria-hidden="true" />
              <span>
                <small>Hash de demostración</small>
                <strong>{sealed ? "DEMO-3C91…A72E" : "Se genera al sellar"}</strong>
              </span>
            </div>
          </div>

          <button
            className="btn btn-primary lumen-consent-seal"
            type="button"
            disabled={!canWrite || !hasSignature || !allConfirmed || sealed}
            onClick={() => setSealed(true)}
          >
            {sealed ? <CheckCircle2 size={18} aria-hidden="true" /> : <LockKeyhole size={18} aria-hidden="true" />}
            {sealed ? "Consentimiento demo sellado" : "Sellar demostración"}
          </button>
          {!allConfirmed ? (
            <span className="lumen-consent-blocker">
              <CircleHelp size={15} aria-hidden="true" /> Confirme todas las secciones antes de sellar.
            </span>
          ) : null}
          <button className="btn btn-outline" type="button" disabled={!sealed}>
            <MessageCircleQuestion size={17} aria-hidden="true" /> Preparar copia demo
          </button>
        </aside>
      </div>

      <footer className="lumen-consent-compliance">
        <span>
          <Clock3 size={18} aria-hidden="true" /> Estampa de tiempo demostrativa
        </span>
        <span>
          <ShieldCheck size={18} aria-hidden="true" /> Resolución 1995/1999 · diseño de control
        </span>
        <span>
          <LockKeyhole size={18} aria-hidden="true" /> Ley 1581/2012 · sin datos reales
        </span>
      </footer>
    </section>
  );
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

import type {
  LumenClinicalRecord,
  LumenClinicalRecordContent,
  LumenDictation,
  LumenEncounterDetail,
  LumenWorklistEntry
} from "@hyperion/contracts";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  FileAudio,
  FileText,
  Mic,
  Save,
  Sparkles,
  Square,
  Stethoscope,
  Upload,
  UserRound
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Layout } from "../components/Layout.js";
import { Card, CardHead, EmptyState, LoadingState, Pill } from "../components/ui.js";
import { api } from "../lib/api.js";
import { lumenPath, useConsole } from "../lib/context.js";
import { lumenErrorMessage } from "../lib/lumen-model.js";
import { can } from "../lib/rbac.js";

interface LumenHealth {
  providers: { transcriptionConfigured: boolean; structuringConfigured: boolean };
}

type Action = "loading" | "starting" | "transcribing" | "structuring" | "saving" | "approving";

export function LumenPage() {
  const { tenant, session } = useConsole();
  const [worklist, setWorklist] = useState<LumenWorklistEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<LumenEncounterDetail>();
  const [draft, setDraft] = useState<LumenClinicalRecordContent>();
  const [transcript, setTranscript] = useState("");
  const [health, setHealth] = useState<LumenHealth>();
  const [action, setAction] = useState<Action>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef(0);

  const loadDetail = useCallback(
    async (encounterId: string) => {
      const next = await api.get<LumenEncounterDetail>(lumenPath(tenant.id, `encounters/${encounterId}`));
      setDetail(next);
      setDraft(next.clinicalRecord?.content);
      setTranscript(next.dictations[0]?.transcript ?? "");
    },
    [tenant.id]
  );

  const load = useCallback(async () => {
    setAction("loading");
    setError(undefined);
    try {
      const [rows, providerHealth] = await Promise.all([
        api.get<LumenWorklistEntry[]>(lumenPath(tenant.id, "worklist")),
        api.get<LumenHealth>("/v1/lumen/health")
      ]);
      setWorklist(rows);
      setHealth(providerHealth);
      const nextId =
        selectedId && rows.some((row) => row.encounterId === selectedId) ? selectedId : rows[0]?.encounterId;
      setSelectedId(nextId);
      if (nextId) await loadDetail(nextId);
    } catch (nextError) {
      setError(lumenErrorMessage(nextError));
    } finally {
      setAction((current) => (current === "loading" ? undefined : current));
    }
  }, [loadDetail, selectedId, tenant.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(
    () => () => {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    []
  );

  async function selectEncounter(encounterId: string) {
    setSelectedId(encounterId);
    setError(undefined);
    setSuccess(undefined);
    setAction("loading");
    try {
      await loadDetail(encounterId);
    } catch (nextError) {
      setError(lumenErrorMessage(nextError));
    } finally {
      setAction(undefined);
    }
  }

  async function startEncounter() {
    if (!selectedId) return;
    await runAction("starting", async () => {
      const next = await api.post<LumenEncounterDetail>(lumenPath(tenant.id, `encounters/${selectedId}/start`), {});
      setDetail(next);
      setSuccess("Consulta iniciada.");
    });
  }

  async function startRecording() {
    setError(undefined);
    setSuccess(undefined);
    if (!window.isSecureContext && window.location.hostname !== "localhost") {
      setError("El micrófono directo requiere HTTPS. Puedes cargar una grabación desde este dispositivo.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Este navegador no permite captura de audio.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      streamRef.current = stream;
      chunksRef.current = [];
      recordingStartedAtRef.current = Date.now();
      const preferred = "audio/webm;codecs=opus";
      const mimeType = MediaRecorder.isTypeSupported(preferred) ? preferred : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 });
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        void transcribeAudio(blob, Math.max(1, Math.round((Date.now() - recordingStartedAtRef.current) / 1_000)));
      };
      setRecordingSeconds(0);
      setRecording(true);
      recorder.start(500);
    } catch (nextError) {
      setError(lumenErrorMessage(nextError));
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  async function uploadAudio(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      setError("Selecciona un archivo de audio.");
      return;
    }
    await transcribeAudio(file);
  }

  async function transcribeAudio(blob: Blob, durationSeconds?: number) {
    if (!selectedId) return;
    if (blob.size > 675_000) {
      setError("La grabación supera 675 KB. Usa un dictado de máximo 90 segundos.");
      return;
    }
    await runAction("transcribing", async () => {
      const dictation = await api.post<LumenDictation>(
        lumenPath(tenant.id, `encounters/${selectedId}/transcriptions`),
        { audioBase64: await blobToBase64(blob), mimeType: blob.type || "audio/webm", durationSeconds }
      );
      setTranscript(dictation.transcript);
      await loadDetail(selectedId);
      setTranscript(dictation.transcript);
      setSuccess("Dictado transcrito con proveedor real.");
    });
  }

  async function structureRecord() {
    if (!selectedId || transcript.trim().length < 10) {
      setError("El transcript debe tener al menos 10 caracteres.");
      return;
    }
    await runAction("structuring", async () => {
      const dictationId = detail?.dictations.find((entry) => entry.transcript === transcript)?.id;
      const record = await api.post<LumenClinicalRecord>(lumenPath(tenant.id, `encounters/${selectedId}/structure`), {
        transcript,
        dictationId
      });
      setDraft(record.content);
      await loadDetail(selectedId);
      setDraft(record.content);
      setSuccess("Historia clínica estructurada y lista para revisión.");
    });
  }

  async function saveDraft(): Promise<LumenClinicalRecord | undefined> {
    if (!selectedId || !draft) return undefined;
    return api.patch<LumenClinicalRecord>(lumenPath(tenant.id, `encounters/${selectedId}/record`), { content: draft });
  }

  async function save() {
    await runAction("saving", async () => {
      const record = await saveDraft();
      if (!record) return;
      setDraft(record.content);
      setSuccess("Borrador clínico guardado.");
    });
  }

  async function approve() {
    if (!selectedId || !draft) return;
    await runAction("approving", async () => {
      await saveDraft();
      const record = await api.post<LumenClinicalRecord>(lumenPath(tenant.id, `encounters/${selectedId}/approve`), {});
      setDraft(record.content);
      await loadDetail(selectedId);
      setSuccess("Historia clínica aprobada y cerrada.");
    });
  }

  async function runAction(nextAction: Action, work: () => Promise<void>) {
    setAction(nextAction);
    setError(undefined);
    setSuccess(undefined);
    try {
      await work();
    } catch (nextError) {
      setError(lumenErrorMessage(nextError));
    } finally {
      setAction(undefined);
    }
  }

  function updateEye(
    section: "visualAcuity" | "intraocularPressure" | "biomicroscopy" | "fundus",
    eye: "right" | "left",
    value: string
  ) {
    setDraft((current) =>
      current ? { ...current, [section]: { ...current[section], [eye]: value.trim() ? value : null } } : current
    );
  }

  const busy = Boolean(action);
  const approved = detail?.clinicalRecord?.status === "approved";
  const canWrite = can(session.operator.role, "write:operation");
  const recordLocked = Boolean(approved || !canWrite);

  return (
    <Layout
      title="LUMEN"
      subtitle="Consulta clínica por voz"
      actions={
        <div className="row">
          <Pill tone={health?.providers.transcriptionConfigured ? "green" : "amber"}>
            Voz {health?.providers.transcriptionConfigured ? "lista" : "sin configurar"}
          </Pill>
          <Pill tone={health?.providers.structuringConfigured ? "green" : "amber"}>
            Estructuración {health?.providers.structuringConfigured ? "lista" : "sin configurar"}
          </Pill>
          {!canWrite ? <Pill tone="blue">Solo lectura</Pill> : null}
        </div>
      }
    >
      {error ? (
        <div className="banner">
          <AlertTriangle size={18} aria-hidden="true" /> {error}
        </div>
      ) : null}
      {success ? <div className="success-banner">{success}</div> : null}

      <div className="lumen-layout">
        <Card className="lumen-worklist">
          <CardHead title="Agenda clínica" icon={<Clock3 size={18} aria-hidden="true" />} />
          {action === "loading" && worklist.length === 0 ? <LoadingState label="Cargando agenda..." /> : null}
          {worklist.length === 0 && action !== "loading" ? <EmptyState label="No hay encuentros clínicos." /> : null}
          <div className="lumen-worklist-items">
            {worklist.map((entry) => (
              <button
                type="button"
                key={entry.encounterId}
                className={`lumen-worklist-item${selectedId === entry.encounterId ? " active" : ""}`}
                onClick={() => void selectEncounter(entry.encounterId)}
              >
                <span className="row between">
                  <strong>{formatTime(entry.scheduledAt)}</strong>
                  <Pill tone={entry.status === "approved" ? "green" : "blue"}>{statusLabel(entry.status)}</Pill>
                </span>
                <span className="row">
                  <UserRound size={16} aria-hidden="true" />
                  <span className="col lumen-patient-name">
                    <strong>{entry.patientDisplayName}</strong>
                    <span className="tiny muted">
                      {entry.patientAge ? `${entry.patientAge} años` : "Edad no registrada"}
                    </span>
                  </span>
                </span>
                <span className="tiny muted">{entry.professionalName}</span>
                {entry.isDemo ? <span className="lumen-demo-label">DATOS SINTÉTICOS</span> : null}
              </button>
            ))}
          </div>
        </Card>

        <div className="lumen-workspace">
          {!detail ? <EmptyState label="Selecciona un encuentro clínico." /> : null}
          {detail ? (
            <>
              <section className="lumen-patient-bar">
                <div className="col">
                  <span className="tiny muted">CONSULTA ACTIVA</span>
                  <strong>{detail.encounter.patientDisplayName}</strong>
                  <span className="small muted">
                    {detail.encounter.professionalName} · {detail.encounter.siteName}
                  </span>
                </div>
                <div className="row">
                  <Pill tone={approved ? "green" : "blue"}>{statusLabel(detail.encounter.status)}</Pill>
                  {detail.encounter.status === "preconsultation" && canWrite ? (
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={() => void startEncounter()}
                      disabled={busy}
                    >
                      <Stethoscope size={17} aria-hidden="true" /> Iniciar consulta
                    </button>
                  ) : null}
                </div>
              </section>

              <Card>
                <CardHead title="Resumen preconsulta" icon={<FileText size={18} aria-hidden="true" />} />
                {detail.preconsultation ? (
                  <div className="lumen-summary">
                    <p>{detail.preconsultation.summaryText}</p>
                    <div className="lumen-summary-grid">
                      <SummaryList title="Diagnósticos activos" items={detail.preconsultation.activeDiagnoses} />
                      <SummaryList title="Medicamentos" items={detail.preconsultation.medications} />
                      <SummaryList title="Alertas" items={detail.preconsultation.alerts} warning />
                    </div>
                    {detail.preconsultation.trends.map((trend) => (
                      <div className="lumen-trend" key={trend.label}>
                        <span className="small muted">{trend.label}</span>
                        <div className="lumen-trend-points">
                          {trend.points.map((point) => (
                            <span key={point.recordedAt}>
                              <strong>{point.value}</strong> {trend.unit}
                              <small>{formatDate(point.recordedAt)}</small>
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState label="Resumen no disponible." />
                )}
              </Card>

              <Card>
                <CardHead
                  title="Dictado clínico"
                  icon={<Mic size={18} aria-hidden="true" />}
                  trailing={recording ? <Pill tone="red">Grabando {formatDuration(recordingSeconds)}</Pill> : undefined}
                />
                <div className="lumen-dictation">
                  <div className="lumen-recorder-actions">
                    {!recording ? (
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={() => void startRecording()}
                        disabled={busy || recordLocked}
                      >
                        <Mic size={17} aria-hidden="true" /> Grabar
                      </button>
                    ) : (
                      <button className="btn btn-outline" type="button" onClick={stopRecording}>
                        <Square size={15} aria-hidden="true" /> Detener
                      </button>
                    )}
                    <label className={`btn btn-outline${busy || recordLocked ? " disabled" : ""}`}>
                      <Upload size={17} aria-hidden="true" /> Cargar audio
                      <input
                        className="visually-hidden"
                        type="file"
                        accept="audio/*"
                        capture="user"
                        disabled={busy || recordLocked}
                        onChange={(event) => void uploadAudio(event.target.files?.[0])}
                      />
                    </label>
                    {action === "transcribing" ? <span className="small muted">Transcribiendo audio...</span> : null}
                  </div>
                  <label className="field">
                    Transcript revisable
                    <textarea
                      className="input lumen-transcript"
                      value={transcript}
                      onChange={(event) => setTranscript(event.target.value)}
                      disabled={recordLocked}
                      placeholder="El transcript aparecerá aquí."
                    />
                  </label>
                  <div className="card-actions lumen-inline-actions">
                    <span className="tiny muted">
                      <FileAudio size={14} aria-hidden="true" /> El audio no se almacena en esta demo.
                    </span>
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={() => void structureRecord()}
                      disabled={busy || recordLocked}
                    >
                      <Sparkles size={17} aria-hidden="true" />
                      {action === "structuring" ? "Estructurando..." : "Estructurar HC"}
                    </button>
                  </div>
                </div>
              </Card>

              {draft ? (
                <Card>
                  <CardHead
                    title="Historia clínica estructurada"
                    icon={<FileText size={18} aria-hidden="true" />}
                    trailing={<Pill tone={approved ? "green" : "amber"}>{approved ? "Aprobada" : "Borrador"}</Pill>}
                  />
                  <div className="lumen-record">
                    <label className="field lumen-span-2">
                      Motivo de consulta
                      <textarea
                        className="input"
                        value={draft.reasonForVisit}
                        disabled={recordLocked}
                        onChange={(event) => setDraft({ ...draft, reasonForVisit: event.target.value })}
                      />
                    </label>
                    <label className="field lumen-span-2">
                      Evolución e historia
                      <textarea
                        className="input"
                        value={draft.history}
                        disabled={recordLocked}
                        onChange={(event) => setDraft({ ...draft, history: event.target.value })}
                      />
                    </label>
                    <EyeFields
                      title="Agudeza visual"
                      value={draft.visualAcuity}
                      disabled={recordLocked}
                      onChange={(eye, value) => updateEye("visualAcuity", eye, value)}
                    />
                    <EyeFields
                      title="Presión intraocular"
                      value={draft.intraocularPressure}
                      disabled={recordLocked}
                      onChange={(eye, value) => updateEye("intraocularPressure", eye, value)}
                    />
                    <EyeFields
                      title="Biomicroscopía"
                      value={draft.biomicroscopy}
                      disabled={recordLocked}
                      onChange={(eye, value) => updateEye("biomicroscopy", eye, value)}
                    />
                    <EyeFields
                      title="Fondo de ojo"
                      value={draft.fundus}
                      disabled={recordLocked}
                      onChange={(eye, value) => updateEye("fundus", eye, value)}
                    />

                    <div className="lumen-span-2 lumen-record-section">
                      <h3>Impresión clínica dictada</h3>
                      {draft.assessment.length === 0 ? (
                        <span className="small muted">Sin impresión explícita en el dictado.</span>
                      ) : null}
                      {draft.assessment.map((entry, index) => (
                        <div className="lumen-assessment" key={`${entry.description}-${index}`}>
                          <span>{entry.description}</span>
                          <span className="tiny muted">Confianza {Math.round(entry.confidence * 100)} %</span>
                        </div>
                      ))}
                    </div>

                    <label className="field lumen-span-2">
                      Plan, una acción por línea
                      <textarea
                        className="input"
                        value={draft.plan.join("\n")}
                        disabled={recordLocked}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            plan: event.target.value
                              .split("\n")
                              .map((line) => line.trim())
                              .filter(Boolean)
                          })
                        }
                      />
                    </label>

                    {draft.uncertainties.length > 0 ? (
                      <div className="lumen-span-2 lumen-uncertainties">
                        <h3>
                          <AlertTriangle size={17} aria-hidden="true" /> Pendientes de confirmación
                        </h3>
                        {draft.uncertainties.map((uncertainty, index) => (
                          <div className="lumen-uncertainty" key={`${uncertainty.field}-${index}`}>
                            <div className="col">
                              <strong>{uncertainty.field}</strong>
                              <span className="small">{uncertainty.message}</span>
                              {uncertainty.sourceText ? (
                                <span className="tiny muted">“{uncertainty.sourceText}”</span>
                              ) : null}
                            </div>
                            <button
                              className="btn btn-outline btn-sm"
                              type="button"
                              disabled={recordLocked}
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  uncertainties: draft.uncertainties.filter((_, itemIndex) => itemIndex !== index)
                                })
                              }
                            >
                              <Check size={15} aria-hidden="true" /> Confirmar
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="card-actions">
                    <span className="small muted">
                      {draft.uncertainties.length === 0
                        ? "Sin pendientes de confirmación."
                        : `${draft.uncertainties.length} pendiente(s).`}
                    </span>
                    {!approved && canWrite ? (
                      <>
                        <button className="btn btn-outline" type="button" onClick={() => void save()} disabled={busy}>
                          <Save size={17} aria-hidden="true" /> Guardar borrador
                        </button>
                        <button
                          className="btn btn-primary"
                          type="button"
                          onClick={() => void approve()}
                          disabled={busy || draft.uncertainties.length > 0}
                        >
                          <CheckCircle2 size={17} aria-hidden="true" /> Aprobar HC
                        </button>
                      </>
                    ) : null}
                  </div>
                </Card>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </Layout>
  );
}

function SummaryList({ title, items, warning }: { title: string; items: string[]; warning?: boolean }) {
  return (
    <div className={`lumen-summary-list${warning ? " warning" : ""}`}>
      <strong>{title}</strong>
      {items.length === 0 ? <span className="small muted">Sin registros.</span> : null}
      {items.map((item) => (
        <span className="small" key={item}>
          {item}
        </span>
      ))}
    </div>
  );
}

function EyeFields({
  title,
  value,
  disabled,
  onChange
}: {
  title: string;
  value: { right: string | null; left: string | null };
  disabled: boolean;
  onChange: (eye: "right" | "left", value: string) => void;
}) {
  return (
    <fieldset className="lumen-eye-fields">
      <legend>{title}</legend>
      <label className="field">
        OD
        <input
          className="input"
          value={value.right ?? ""}
          disabled={disabled}
          onChange={(event) => onChange("right", event.target.value)}
        />
      </label>
      <label className="field">
        OI
        <input
          className="input"
          value={value.left ?? ""}
          disabled={disabled}
          onChange={(event) => onChange("left", event.target.value)}
        />
      </label>
    </fieldset>
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary);
}

function statusLabel(status: LumenWorklistEntry["status"]): string {
  return {
    preconsultation: "Preconsulta",
    in_progress: "En consulta",
    review: "En revisión",
    approved: "Aprobada"
  }[status];
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" }).format(
    new Date(value)
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es-CO", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

function formatDuration(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

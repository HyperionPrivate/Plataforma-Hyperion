import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  FileSearch,
  FileUp,
  Filter,
  FlaskConical,
  Link2,
  Search,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  filterLumenLabs,
  LUMEN_LABS,
  lumenLabCaptureError,
  lumenLabStatusLabel,
  type LumenLabDocument,
  type LumenLabStatus
} from "../../../lib/lumen-demo-data.js";
import { LumenDemoHeading, LumenDemoNotice, LumenLabPaper, LumenMetricCard } from "./LumenDemoShared.js";

const STATUS_TABS: readonly { id: "all" | LumenLabStatus; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "pending", label: "Por validar" },
  { id: "review", label: "Con alertas" },
  { id: "processing", label: "Procesando" },
  { id: "validated", label: "Validados" }
];

export function LumenLaboratoriesView({ canWrite }: { canWrite: boolean }) {
  const [documents, setDocuments] = useState<LumenLabDocument[]>(() => LUMEN_LABS.map((document) => ({ ...document })));
  const [selectedId, setSelectedId] = useState(documents[0]?.id ?? "");
  const [status, setStatus] = useState<"all" | LumenLabStatus>("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => filterLumenLabs(documents, status, query), [documents, query, status]);
  const selected = documents.find((document) => document.id === selectedId) ?? visible[0] ?? documents[0];

  function validateSelected() {
    if (!selected || !canWrite || selected.status === "processing") return;
    setDocuments((current) =>
      current.map((document) => (document.id === selected.id ? { ...document, status: "validated" } : document))
    );
    setEditing(false);
    setNotice("Documento validado dentro de la demo. No se escribió en una historia clínica real.");
  }

  function updateSelectedParameter(parameterName: string, value: string) {
    if (!selected || !editing || !canWrite) return;
    setDocuments((current) =>
      current.map((document) =>
        document.id === selected.id
          ? {
              ...document,
              parameters: document.parameters.map((parameter) =>
                parameter.name === parameterName ? { ...parameter, value } : parameter
              )
            }
          : document
      )
    );
  }

  function captureLocalFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const validationError = lumenLabCaptureError(file.type, file.size);
    if (validationError) {
      setNotice(`Archivo rechazado: ${validationError}`);
      return;
    }
    const id = `local-${Date.now()}`;
    const localDocument: LumenLabDocument = {
      id,
      title: file.name,
      patient: "Pendiente de identificación · Demo",
      received: "ahora",
      status: "pending",
      lab: "Carga local · Demo",
      takenAt: "Pendiente",
      matchedOrder: "Pendiente de emparejamiento",
      parameters: []
    };
    setDocuments((current) => [localDocument, ...current]);
    setSelectedId(id);
    setStatus("all");
    setEditing(false);
    setNotice("Archivo capturado solo en memoria. No se subió ni se ejecutó OCR clínico.");
  }

  return (
    <section className="lumen-demo-view lumen-labs-view" aria-labelledby="lumen-labs-title">
      <LumenDemoHeading
        id="lumen-labs-title"
        eyebrow="Bandeja clínica"
        title="Laboratorios transcritos"
        description="Revisión humana lado a lado antes de incorporar resultados al expediente."
        actions={
          <button className="btn btn-outline" type="button" onClick={() => setStatus("review")}>
            <Filter size={16} aria-hidden="true" />
            Mostrar alertas
          </button>
        }
      />

      <div className="lumen-demo-metrics lumen-labs-metrics">
        <LumenMetricCard
          icon={<FileSearch size={20} aria-hidden="true" />}
          label="Por validar"
          value="12"
          detail="2 requieren revisión"
          tone="amber"
        />
        <LumenMetricCard
          icon={<CheckCircle2 size={20} aria-hidden="true" />}
          label="Procesados este mes"
          value="148"
          detail="93,4 % sin corrección"
        />
        <LumenMetricCard
          icon={<ShieldCheck size={20} aria-hidden="true" />}
          label="Valores inventados"
          value="0"
          detail="Regla clínica innegociable"
          tone="blue"
        />
      </div>

      {notice ? (
        <div className="lumen-feedback lumen-feedback-success" role="status" aria-live="polite">
          <CheckCircle2 size={18} aria-hidden="true" />
          <span>{notice}</span>
          <button
            className="lumen-inline-dismiss"
            type="button"
            onClick={() => setNotice(undefined)}
            aria-label="Cerrar aviso"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div className="lumen-labs-workspace">
        <aside className="lumen-labs-queue" aria-label="Documentos de laboratorio">
          <label className="lumen-demo-search">
            <Search size={17} aria-hidden="true" />
            <span className="visually-hidden">Buscar documentos</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar documento demo"
            />
          </label>

          <div className="lumen-lab-tabs" role="tablist" aria-label="Filtrar laboratorios">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={status === tab.id}
                className={status === tab.id ? "active" : ""}
                onClick={() => setStatus(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="lumen-lab-queue-list">
            {visible.map((document) => (
              <button
                type="button"
                key={document.id}
                className={`lumen-lab-queue-item${document.id === selected?.id ? " active" : ""}`}
                onClick={() => {
                  setSelectedId(document.id);
                  setEditing(false);
                }}
              >
                <span className="lumen-lab-document-icon">
                  <FlaskConical size={18} aria-hidden="true" />
                </span>
                <span>
                  <strong>{document.title}</strong>
                  <small>{document.patient}</small>
                  <small>{document.received}</small>
                </span>
                <span className={`lumen-demo-status status-${document.status}`}>
                  {lumenLabStatusLabel(document.status)}
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
            {!visible.length ? <span className="lumen-demo-empty">No hay documentos para este filtro.</span> : null}
          </div>
        </aside>

        <div className="lumen-lab-capture" aria-label="Capturar laboratorio">
          <Camera size={28} aria-hidden="true" />
          <div>
            <strong>Capturar resultado</strong>
            <span>Foto o PDF sintético para la demostración</span>
          </div>
          <button className="btn btn-outline" type="button" onClick={() => cameraInputRef.current?.click()}>
            <Camera size={16} aria-hidden="true" />
            Cámara
          </button>
          <button className="btn btn-outline" type="button" onClick={() => fileInputRef.current?.click()}>
            <FileUp size={16} aria-hidden="true" />
            Archivo
          </button>
          <input
            ref={cameraInputRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            capture="environment"
            aria-label="Seleccionar fotografía local de laboratorio"
            onChange={captureLocalFile}
            tabIndex={-1}
          />
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept="image/*,application/pdf"
            aria-label="Seleccionar imagen o PDF local de laboratorio"
            onChange={captureLocalFile}
            tabIndex={-1}
          />
        </div>

        {selected ? (
          <article className="lumen-lab-review" aria-labelledby="selected-lab-title">
            <div className="lumen-lab-preview-panel">
              <div className="lumen-lab-panel-heading">
                <div>
                  <span className="lumen-eyebrow">Original sintético</span>
                  <h2 id="selected-lab-title">{selected.title}</h2>
                </div>
                <span className={`lumen-demo-status status-${selected.status}`}>
                  {lumenLabStatusLabel(selected.status)}
                </span>
              </div>
              <LumenLabPaper
                title={selected.title}
                patient={selected.patient}
                takenAt={selected.takenAt}
                parameters={selected.parameters}
              />
            </div>

            <div className="lumen-lab-extraction-panel">
              <div className="lumen-lab-panel-heading">
                <div>
                  <span className="lumen-eyebrow">Extracción OCR + IA</span>
                  <h2>Datos extraídos</h2>
                </div>
                <span className="lumen-demo-count">
                  {selected.parameters.length}/{selected.parameters.length} campos
                </span>
              </div>

              {selected.status === "processing" ? (
                <div className="lumen-lab-processing" role="status">
                  <Sparkles size={24} aria-hidden="true" />
                  <strong>Procesando documento</strong>
                  <span>{selected.progress ?? 0}%</span>
                  <div>
                    <i style={{ width: `${selected.progress ?? 0}%` }} />
                  </div>
                </div>
              ) : selected.parameters.length ? (
                <div className="lumen-lab-parameter-list">
                  {selected.parameters.map((parameter) => (
                    <label className={`lumen-lab-parameter${parameter.alert ? " alert" : ""}`} key={parameter.name}>
                      <span>
                        <strong>{parameter.name}</strong>
                        <small>Referencia {parameter.range}</small>
                      </span>
                      <input
                        value={parameter.value}
                        readOnly={!editing}
                        onChange={(event) => updateSelectedParameter(parameter.name, event.target.value)}
                        aria-label={`${parameter.name} resultado`}
                      />
                      <span>{parameter.unit}</span>
                      <span className="lumen-lab-confidence">
                        {Math.round(parameter.confidence * 100)}%
                        {parameter.alert ? (
                          <AlertTriangle size={15} aria-hidden="true" />
                        ) : (
                          <Check size={15} aria-hidden="true" />
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="lumen-lab-no-extraction">
                  <FileSearch size={24} aria-hidden="true" />
                  <strong>Sin extracción clínica</strong>
                  <span>La captura permanece local hasta conectar un proveedor OCR autorizado.</span>
                </div>
              )}

              <div className="lumen-lab-match">
                <Link2 size={18} aria-hidden="true" />
                <span>
                  <small>Vínculo propuesto</small>
                  <strong>{selected.matchedOrder}</strong>
                </span>
              </div>

              <LumenDemoNotice>
                La validación es local a la demo; no se adjunta a una HC ni se notifica a terceros.
              </LumenDemoNotice>

              <div className="lumen-demo-actions">
                <button
                  className="btn btn-outline"
                  type="button"
                  disabled={!canWrite || !selected.parameters.length || selected.status === "processing"}
                  onClick={() => setEditing((current) => !current)}
                >
                  {editing ? <Check size={16} aria-hidden="true" /> : <FileSearch size={16} aria-hidden="true" />}
                  {editing ? "Terminar corrección" : "Corregir"}
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={
                    !canWrite ||
                    !selected.parameters.length ||
                    selected.status === "processing" ||
                    selected.status === "validated"
                  }
                  onClick={validateSelected}
                >
                  <CheckCircle2 size={16} aria-hidden="true" />
                  Validar en demo
                </button>
              </div>
            </div>
          </article>
        ) : null}
      </div>
    </section>
  );
}

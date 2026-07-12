import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleDot,
  Copy,
  Eye,
  GripVertical,
  Info,
  Plus,
  Save,
  ScanEye,
  Send,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  X
} from "lucide-react";
import { useMemo, useState } from "react";
import { LUMEN_MODELS, LUMEN_MODEL_FIELDS } from "../../../lib/lumen-demo-data.js";
import { LumenDemoHeading, LumenDemoNotice } from "./LumenDemoShared.js";

interface EditableField {
  id: string;
  label: string;
  type: string;
  required: boolean;
  voice: boolean;
  visible: boolean;
}

const FIELD_TYPES = [
  "Texto largo",
  "Snellen por ojo",
  "Numérico · mmHg",
  "Shaffer 0–IV por ojo",
  "Numérico · µm",
  "Adjunto + interpretación",
  "Autocodificado"
] as const;

export function LumenModelsView({ canWrite }: { canWrite: boolean }) {
  const [selectedId, setSelectedId] = useState("glaucoma");
  const [fields, setFields] = useState<EditableField[]>(() =>
    LUMEN_MODEL_FIELDS.map((field) => ({ ...field, visible: true }))
  );
  const [selectedFieldId, setSelectedFieldId] = useState("pressure");
  const [aliases, setAliases] = useState(["presión", "PIO", "tensión ocular", "Goldmann"]);
  const [aliasDraft, setAliasDraft] = useState("");
  const [notice, setNotice] = useState<string>();

  const selectedModel = LUMEN_MODELS.find((model) => model.id === selectedId) ?? LUMEN_MODELS[0];
  const selectedField = fields.find((field) => field.id === selectedFieldId) ?? fields[0];
  const activeModels = LUMEN_MODELS.filter((model) => model.active).length;

  const preview = useMemo(() => {
    const pressure = fields.find((field) => field.id === "pressure");
    return pressure?.visible && pressure.voice ? "PIO OD 16 · OI 24 mmHg" : "Campo PIO desactivado";
  }, [fields]);

  function patchField(id: string, patch: Partial<EditableField>) {
    setFields((current) => current.map((field) => (field.id === id ? { ...field, ...patch } : field)));
  }

  function moveField(id: string, direction: -1 | 1) {
    setFields((current) => {
      const index = current.findIndex((field) => field.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  function addAlias() {
    const normalized = aliasDraft.trim();
    if (!normalized || aliases.includes(normalized)) return;
    setAliases((current) => [...current, normalized]);
    setAliasDraft("");
  }

  return (
    <section className="lumen-demo-view lumen-models-view" aria-labelledby="lumen-models-title">
      <LumenDemoHeading
        id="lumen-models-title"
        eyebrow="Configuración clínica"
        title="Modelos de historia clínica"
        description={`${activeModels} de 10 modelos activos · edición con doble aprobación simulada`}
        actions={
          <button
            className="btn btn-outline"
            type="button"
            onClick={() => setNotice("Copia de modelo preparada en la demo.")}
          >
            <Copy size={16} aria-hidden="true" />
            Duplicar modelo
          </button>
        }
      />

      {notice ? (
        <div className="lumen-feedback lumen-feedback-success" role="status">
          <Check size={17} aria-hidden="true" />
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

      <div className="lumen-models-layout">
        <aside className="lumen-model-list" aria-label="Modelos de historia clínica">
          <div className="lumen-demo-panel-heading">
            <div>
              <span className="lumen-eyebrow">Especialidades</span>
              <h2>Modelos publicados</h2>
            </div>
            <span>{activeModels}/10</span>
          </div>
          <div>
            {LUMEN_MODELS.map((model) => (
              <button
                type="button"
                key={model.id}
                className={selectedId === model.id ? "active" : ""}
                onClick={() => setSelectedId(model.id)}
              >
                <span className="lumen-model-icon">
                  {model.id === "glaucoma" ? <CircleDot size={20} /> : <Eye size={20} />}
                </span>
                <span>
                  <strong>{model.name}</strong>
                  <small>
                    v{model.version} · {model.fields} campos
                  </small>
                </span>
                <span className={`lumen-demo-status ${model.active ? "status-validated" : "status-pending"}`}>
                  {model.active ? "Activo" : "Borrador"}
                </span>
              </button>
            ))}
          </div>
          <button
            className="lumen-new-model"
            type="button"
            onClick={() => setNotice("Nuevo modelo abierto en modo demo.")}
          >
            <Plus size={19} aria-hidden="true" />
            <span>
              <strong>Nuevo modelo</strong>
              <small>3 cupos disponibles</small>
            </span>
          </button>
        </aside>

        <div className="lumen-model-canvas">
          <div className="lumen-demo-panel-heading">
            <div>
              <span className="lumen-eyebrow">Modelo seleccionado</span>
              <h2>{selectedModel.name}</h2>
            </div>
            <span>Versión {selectedModel.version} · editando demo</span>
          </div>

          <div className="lumen-model-field-list">
            {fields.map((field, index) => (
              <article
                key={field.id}
                className={`lumen-model-field${selectedFieldId === field.id ? " selected" : ""}${
                  field.visible ? "" : " disabled"
                }`}
              >
                <GripVertical size={17} aria-hidden="true" />
                <span className="lumen-model-field-index">{index + 1}</span>
                <button
                  className="lumen-model-field-select"
                  type="button"
                  onClick={() => setSelectedFieldId(field.id)}
                  aria-pressed={selectedFieldId === field.id}
                >
                  <strong>{field.label}</strong>
                  <small>{field.type}</small>
                  {field.id === "pressure" ? <em>Alerta si toma &gt; meta</em> : null}
                </button>
                <label>
                  <span>Visible</span>
                  <input
                    type="checkbox"
                    checked={field.visible}
                    disabled={!canWrite}
                    onChange={(event) => patchField(field.id, { visible: event.target.checked })}
                  />
                  <i />
                </label>
                <label>
                  <span>Obligatorio</span>
                  <input
                    type="checkbox"
                    checked={field.required}
                    disabled={!canWrite}
                    onChange={(event) => patchField(field.id, { required: event.target.checked })}
                  />
                  <i />
                </label>
                <label>
                  <span>Por voz</span>
                  <input
                    type="checkbox"
                    checked={field.voice}
                    disabled={!canWrite}
                    onChange={(event) => patchField(field.id, { voice: event.target.checked })}
                  />
                  <i />
                </label>
                <div className="lumen-model-reorder">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      moveField(field.id, -1);
                    }}
                    disabled={!canWrite || index === 0}
                    aria-label={`Subir ${field.label}`}
                  >
                    <ArrowUp size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      moveField(field.id, 1);
                    }}
                    disabled={!canWrite || index === fields.length - 1}
                    aria-label={`Bajar ${field.label}`}
                  >
                    <ArrowDown size={15} aria-hidden="true" />
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div className="lumen-model-mobile-note">
            <ScanEye size={20} aria-hidden="true" />
            <span>
              <strong>Vista móvil de consulta</strong>
              La edición completa permanece disponible en escritorio.
            </span>
          </div>
        </div>

        <aside className="lumen-model-properties" aria-label="Propiedades del campo">
          <div className="lumen-demo-panel-heading">
            <div>
              <span className="lumen-eyebrow">Propiedades</span>
              <h2>{selectedField.label}</h2>
            </div>
            <Settings2 size={19} aria-hidden="true" />
          </div>

          <label className="lumen-demo-field">
            <span>Tipo de campo</span>
            <select
              value={selectedField.type}
              disabled={!canWrite}
              onChange={(event) => patchField(selectedField.id, { type: event.target.value })}
            >
              {FIELD_TYPES.map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </label>
          <label className="lumen-demo-field">
            <span>Validación</span>
            <input value={selectedField.id === "pressure" ? "0–80 mmHg" : "Según catálogo clínico"} readOnly />
          </label>

          <section className="lumen-model-rule">
            <SlidersHorizontal size={18} aria-hidden="true" />
            <div>
              <small>Regla de negocio</small>
              <strong>
                {selectedField.id === "pressure" ? "Alertar cuando PIO > meta por ojo" : "Sin regla adicional"}
              </strong>
            </div>
          </section>

          <section className="lumen-model-aliases">
            <div>
              <h3>Alias de dictado</h3>
              <Info size={14} aria-hidden="true" />
            </div>
            <div className="lumen-model-alias-list">
              {aliases.map((alias) => (
                <span key={alias}>
                  {alias}
                  <button
                    type="button"
                    onClick={() => setAliases((current) => current.filter((item) => item !== alias))}
                    disabled={!canWrite}
                    aria-label={`Eliminar alias ${alias}`}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
            <div className="lumen-model-alias-input">
              <input
                value={aliasDraft}
                onChange={(event) => setAliasDraft(event.target.value)}
                placeholder="Nuevo alias"
                aria-label="Nuevo alias de dictado"
                disabled={!canWrite}
              />
              <button
                type="button"
                onClick={addAlias}
                disabled={!canWrite || !aliasDraft.trim()}
                aria-label="Agregar alias"
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            </div>
          </section>

          <section className="lumen-model-preview">
            <span>
              <Sparkles size={16} aria-hidden="true" /> Vista previa de dictado
            </span>
            <blockquote>“presión intraocular dieciséis y veinticuatro”</blockquote>
            <ArrowDown size={18} aria-hidden="true" />
            <strong>{preview}</strong>
          </section>

          <LumenDemoNotice>
            No se publica ningún modelo ni regla clínica fuera de esta sesión de demostración.
          </LumenDemoNotice>
        </aside>
      </div>

      <footer className="lumen-demo-sticky-actions lumen-model-actions">
        <div className="lumen-model-action-state">
          <Save size={18} aria-hidden="true" />
          <span>
            <strong>Cambios locales de demo</strong>
            Doble aprobación pendiente
          </span>
        </div>
        <div className="lumen-model-mobile-lock">
          <ScanEye size={18} aria-hidden="true" />
          <span>
            <strong>Consulta móvil</strong>
            Edita y publica modelos desde escritorio.
          </span>
        </div>
        <button
          className="btn btn-outline"
          type="button"
          onClick={() => setNotice("Borrador de modelo guardado localmente.")}
        >
          <Save size={16} aria-hidden="true" /> Guardar borrador
        </button>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => setNotice("Versión demo preparada; no fue publicada a profesionales.")}
          disabled={!canWrite}
        >
          <Send size={16} aria-hidden="true" /> Preparar versión demo
        </button>
      </footer>
    </section>
  );
}

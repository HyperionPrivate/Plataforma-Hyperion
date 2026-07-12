import {
  AlertTriangle,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  CloudUpload,
  FileCheck2,
  FileCode2,
  Landmark,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  LUMEN_INVOICES,
  lumenInvoiceStatusLabel,
  type LumenDemoInvoice,
  type LumenInvoiceStatus
} from "../../../lib/lumen-demo-data.js";
import { LumenDemoHeading, LumenDemoNotice, LumenMetricCard } from "./LumenDemoShared.js";

type InvoiceFilter = "all" | LumenInvoiceStatus;

const RADICATIONS = [
  { payer: "Sanitas", count: 1420, ratio: 100 },
  { payer: "PONAL", count: 310, ratio: 22 },
  { payer: "HOSMIR", count: 205, ratio: 14 },
  { payer: "SURA PAC", count: 480, ratio: 34 },
  { payer: "Salud Mía", count: 240, ratio: 17 },
  { payer: "Prepagadas", count: 760, ratio: 54 },
  { payer: "Particular", count: 803, ratio: 57 }
] as const;

const FILTERS: readonly { id: InvoiceFilter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "validated", label: "Validadas" },
  { id: "processing", label: "En proceso" },
  { id: "retained", label: "Con alerta" }
];

export function LumenBillingView({ canWrite }: { canWrite: boolean }) {
  const [filter, setFilter] = useState<InvoiceFilter>("all");
  const [expandedId, setExpandedId] = useState("FE-24817");
  const [notice, setNotice] = useState<string>();

  const invoices = useMemo(
    () => LUMEN_INVOICES.filter((invoice) => filter === "all" || invoice.status === filter),
    [filter]
  );

  function prepare(action: "rips" | "radication") {
    setNotice(
      action === "rips"
        ? "Lote RIPS preparado en la demostración. No se envió información a MinSalud."
        : "Radicación preparada en la demostración. No se contactó ningún pagador."
    );
  }

  return (
    <section className="lumen-demo-view lumen-billing-view" aria-labelledby="lumen-billing-title">
      <LumenDemoHeading
        id="lumen-billing-title"
        eyebrow="Ciclo financiero clínico"
        title="Facturación electrónica y RIPS"
        description="Vista demostrativa · septiembre 2026 · trazabilidad desde la HC"
        actions={
          <label className="lumen-period-control">
            <span className="visually-hidden">Periodo</span>
            <select defaultValue="sep-2026">
              <option value="sep-2026">Septiembre 2026</option>
              <option value="aug-2026">Agosto 2026</option>
            </select>
          </label>
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

      <div className="lumen-demo-metrics lumen-billing-metrics">
        <LumenMetricCard icon={<ReceiptText size={21} />} label="Facturas emitidas" value="4.218" detail="Mes demo" />
        <LumenMetricCard
          icon={<ShieldCheck size={21} />}
          label="Validadas DIAN"
          value="99,8 %"
          detail="4.210 de 4.218"
        />
        <LumenMetricCard
          icon={<FileCode2 size={21} />}
          label="RIPS generados"
          value="4.180"
          detail="99,1 % del total"
          tone="blue"
        />
        <LumenMetricCard icon={<CheckCircle2 size={21} />} label="Sin glosa" value="97,4 %" detail="Meta ≥ 98 %" />
        <LumenMetricCard
          icon={<AlertTriangle size={21} />}
          label="Glosas activas"
          value="$12,4 M"
          detail="3 facturas demo"
          tone="amber"
        />
      </div>

      <div className="lumen-billing-layout">
        <article className="lumen-billing-table-panel">
          <div className="lumen-demo-panel-heading lumen-billing-table-heading">
            <div>
              <span className="lumen-eyebrow">Bandeja operativa</span>
              <h2>Facturas del día</h2>
            </div>
            <div className="lumen-segmented" aria-label="Filtrar facturas">
              {FILTERS.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={filter === item.id ? "active" : ""}
                  onClick={() => setFilter(item.id)}
                  aria-pressed={filter === item.id}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="lumen-billing-table" aria-label="Facturas sintéticas">
            <div className="lumen-billing-table-row lumen-billing-table-header">
              <span>Factura</span>
              <span>Paciente</span>
              <span>Convenio</span>
              <span>Concepto</span>
              <span>Valor</span>
              <span>Estado</span>
              <span aria-hidden="true" />
            </div>
            {invoices.map((invoice) => (
              <InvoiceRow
                key={invoice.id}
                invoice={invoice}
                expanded={expandedId === invoice.id}
                onToggle={() => setExpandedId((current) => (current === invoice.id ? "" : invoice.id))}
              />
            ))}
            {!invoices.length ? <p className="lumen-demo-empty">No hay facturas para este filtro.</p> : null}
          </div>
          <footer className="lumen-billing-table-footer">
            <span>
              Mostrando {invoices.length} de {LUMEN_INVOICES.length} facturas sintéticas
            </span>
            <span>Cero redigitación en la ruta demostrada</span>
          </footer>
        </article>

        <aside className="lumen-billing-rail">
          <section className="lumen-radication-card">
            <div className="lumen-demo-panel-heading">
              <div>
                <span className="lumen-eyebrow">Distribución demo</span>
                <h2>Radicación por pagador</h2>
              </div>
              <span>Mes</span>
            </div>
            <div className="lumen-radication-list">
              {RADICATIONS.map((item) => (
                <div key={item.payer}>
                  <span>{item.payer}</span>
                  <i>
                    <b style={{ width: `${item.ratio}%` }} />
                  </i>
                  <strong>{item.count.toLocaleString("es-CO")}</strong>
                </div>
              ))}
            </div>
            <footer>
              <span>Total demostrativo</span>
              <strong>4.218</strong>
            </footer>
          </section>

          <section className="lumen-glosa-card">
            <div className="lumen-demo-panel-heading">
              <div>
                <span className="lumen-eyebrow">Control previo</span>
                <h2>Alertas de glosa</h2>
              </div>
              <span className="lumen-demo-status status-retained">3</span>
            </div>
            {[
              ["FE-24488", "Código CUPS inconsistente"],
              ["FE-24502", "Diagnóstico principal no soportado"],
              ["FE-24491", "Servicio fuera del plan"]
            ].map(([invoice, reason]) => (
              <button
                type="button"
                key={invoice}
                onClick={() => setNotice(`${invoice}: sugerencia clínica abierta en la demo.`)}
              >
                <AlertTriangle size={18} aria-hidden="true" />
                <span>
                  <strong>{invoice}</strong>
                  <small>{reason}</small>
                </span>
                <ChevronDown size={16} aria-hidden="true" />
              </button>
            ))}
          </section>

          <button
            className="btn btn-outline lumen-billing-action"
            type="button"
            onClick={() => prepare("rips")}
            disabled={!canWrite}
          >
            <CloudUpload size={18} aria-hidden="true" /> Preparar lote RIPS demo
          </button>
          <button
            className="btn btn-primary lumen-billing-action"
            type="button"
            onClick={() => prepare("radication")}
            disabled={!canWrite}
          >
            <Landmark size={18} aria-hidden="true" /> Preparar radicación demo
          </button>
          <LumenDemoNotice>
            Sin conexión a DIAN, MinSalud ni pagadores. No se emiten documentos legales.
          </LumenDemoNotice>
        </aside>
      </div>
    </section>
  );
}

function InvoiceRow({
  invoice,
  expanded,
  onToggle
}: {
  invoice: LumenDemoInvoice;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`lumen-billing-invoice${expanded ? " expanded" : ""}`}>
      <button className="lumen-billing-table-row" type="button" onClick={onToggle} aria-expanded={expanded}>
        <strong data-label="Factura">{invoice.id}</strong>
        <span data-label="Paciente">{invoice.patient}</span>
        <span data-label="Convenio">
          <i className="lumen-payer-chip">{invoice.payer}</i>
        </span>
        <span data-label="Concepto">{invoice.concept}</span>
        <strong data-label="Valor">{invoice.value}</strong>
        <span data-label="Estado">
          <i className={`lumen-demo-status status-${invoice.status}`}>{lumenInvoiceStatusLabel(invoice.status)}</i>
        </span>
        <ChevronDown className="lumen-invoice-chevron" size={17} aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="lumen-billing-pipeline">
          <PipelineStep icon={<FileCheck2 size={20} />} label="HC firmada" complete />
          <PipelineStep icon={<Sparkles size={20} />} label="CIE-10 / CUPS" complete={invoice.status !== "retained"} />
          <PipelineStep
            icon={<ReceiptText size={20} />}
            label="Factura generada"
            complete={invoice.status !== "processing"}
          />
          <PipelineStep
            icon={<ShieldCheck size={20} />}
            label="Validación DIAN"
            complete={invoice.status === "validated"}
          />
          <PipelineStep icon={<FileCode2 size={20} />} label="RIPS JSON" complete={invoice.status === "validated"} />
          <PipelineStep
            icon={<Building2 size={20} />}
            label="Listo para radicar"
            complete={invoice.status === "validated"}
          />
          {invoice.note ? (
            <p>
              <AlertTriangle size={16} aria-hidden="true" /> {invoice.note}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PipelineStep({ icon, label, complete }: { icon: ReactNode; label: string; complete: boolean }) {
  return (
    <span className={complete ? "complete" : "pending"}>
      <i>{complete ? icon : <Clock3 size={20} />}</i>
      <small>{label}</small>
      {complete ? <CheckCircle2 size={14} aria-hidden="true" /> : <CircleDollarSign size={14} aria-hidden="true" />}
    </span>
  );
}

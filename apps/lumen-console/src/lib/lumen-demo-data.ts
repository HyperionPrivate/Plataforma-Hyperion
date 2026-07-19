export type LumenLabStatus = "pending" | "review" | "processing" | "validated";

export interface LumenLabParameter {
  name: string;
  value: string;
  unit: string;
  range: string;
  confidence: number;
  alert?: boolean;
}

export interface LumenLabDocument {
  id: string;
  title: string;
  patient: string;
  received: string;
  status: LumenLabStatus;
  progress?: number;
  lab: string;
  takenAt: string;
  matchedOrder: string;
  parameters: LumenLabParameter[];
}

export const LUMEN_LABS: readonly LumenLabDocument[] = [
  {
    id: "lab-hba1c",
    title: "Glicemia y HbA1c",
    patient: "María Eugenia Duarte · Demo",
    received: "hace 4 min",
    status: "review",
    lab: "Higuera Escalante · Demo",
    takenAt: "12 sep 2026",
    matchedOrder: "Laboratorios de control · Dra. Camacho",
    parameters: [
      { name: "Glicemia", value: "118", unit: "mg/dL", range: "70–100", confidence: 0.99, alert: true },
      { name: "HbA1c", value: "7,2", unit: "%", range: "< 5,7", confidence: 0.97, alert: true },
      { name: "Creatinina", value: "0,9", unit: "mg/dL", range: "0,6–1,1", confidence: 0.93 }
    ]
  },
  {
    id: "lab-hemogram",
    title: "Hemograma",
    patient: "Paciente sintético 02",
    received: "hace 18 min",
    status: "validated",
    lab: "Laboratorio clínico · Demo",
    takenAt: "15 sep 2026",
    matchedOrder: "Prequirúrgicos · Catarata",
    parameters: [
      { name: "Hemoglobina", value: "14,2", unit: "g/dL", range: "12–16", confidence: 0.98 },
      { name: "Plaquetas", value: "248", unit: "10³/µL", range: "150–400", confidence: 0.98 }
    ]
  },
  {
    id: "lab-lipid",
    title: "Perfil lipídico",
    patient: "Paciente sintético 03",
    received: "hace 27 min",
    status: "pending",
    lab: "Laboratorio externo · Demo",
    takenAt: "14 sep 2026",
    matchedOrder: "Sin orden emparejada",
    parameters: [
      { name: "Colesterol total", value: "216", unit: "mg/dL", range: "< 200", confidence: 0.96, alert: true },
      { name: "HDL", value: "48", unit: "mg/dL", range: "> 40", confidence: 0.98 },
      { name: "Triglicéridos", value: "180", unit: "mg/dL", range: "< 150", confidence: 0.95, alert: true }
    ]
  },
  {
    id: "lab-topography",
    title: "Topografía corneal",
    patient: "Paciente sintético 04",
    received: "hace 35 min",
    status: "processing",
    progress: 62,
    lab: "Ayudas diagnósticas · Demo",
    takenAt: "15 sep 2026",
    matchedOrder: "Topografía prequirúrgica",
    parameters: []
  }
];

export const LUMEN_MODELS = [
  { id: "general", name: "Oftalmología general", version: 4, fields: 12, active: true },
  { id: "retina", name: "Retina", version: 2, fields: 12, active: true },
  { id: "glaucoma", name: "Glaucoma — control", version: 3, fields: 12, active: true },
  { id: "cornea", name: "Córnea", version: 1, fields: 10, active: true },
  { id: "pediatrics", name: "Pediatría / Estrabismo", version: 2, fields: 11, active: true },
  { id: "cataract", name: "Catarata — prequirúrgica", version: 1, fields: 14, active: false },
  { id: "optometry", name: "Optometría", version: 5, fields: 10, active: true }
] as const;

export const LUMEN_MODEL_FIELDS = [
  { id: "reason", label: "Motivo de consulta", type: "Texto largo", required: true, voice: true },
  { id: "acuity", label: "Agudeza visual OD/OI", type: "Snellen por ojo", required: true, voice: true },
  { id: "pressure", label: "PIO OD/OI", type: "Numérico · mmHg", required: true, voice: true },
  { id: "gonioscopy", label: "Gonioscopía", type: "Shaffer 0–IV por ojo", required: true, voice: true },
  { id: "pachymetry", label: "Paquimetría", type: "Numérico · µm", required: false, voice: true },
  { id: "field", label: "Campimetría", type: "Adjunto + interpretación", required: false, voice: true },
  { id: "diagnosis", label: "Diagnóstico CIE-10", type: "Autocodificado", required: true, voice: true },
  { id: "plan", label: "Plan y órdenes CUPS", type: "Autocodificado", required: true, voice: true }
] as const;

export type LumenInvoiceStatus = "validated" | "processing" | "retained";

export interface LumenDemoInvoice {
  id: string;
  patient: string;
  payer: string;
  concept: string;
  value: string;
  status: LumenInvoiceStatus;
  note?: string;
}

export const LUMEN_INVOICES: readonly LumenDemoInvoice[] = [
  {
    id: "FE-24817",
    patient: "M. E. Duarte · Demo",
    payer: "Sanitas",
    concept: "Consulta control + tonometría",
    value: "$128.400",
    status: "validated"
  },
  {
    id: "FE-24818",
    patient: "Paciente sintético 02",
    payer: "SURA PAC",
    concept: "OCT macular",
    value: "$312.000",
    status: "processing"
  },
  {
    id: "FE-24803",
    patient: "Paciente sintético 03",
    payer: "FOMAG",
    concept: "Campimetría",
    value: "$214.600",
    status: "retained",
    note: "CUPS 951301 sin soporte suficiente en la HC"
  },
  {
    id: "FE-24820",
    patient: "Paciente sintético 04",
    payer: "Particular",
    concept: "Consulta oftalmológica",
    value: "$185.400",
    status: "validated"
  }
];

export const LUMEN_DOCUMENTATION_TREND = [
  { week: "S1", minutes: 10 },
  { week: "S2", minutes: 8.9 },
  { week: "S3", minutes: 7.7 },
  { week: "S4", minutes: 6.8 },
  { week: "S5", minutes: 5.7 },
  { week: "S6", minutes: 4.9 },
  { week: "S7", minutes: 4.3 },
  { week: "S8", minutes: 4 },
  { week: "S9", minutes: 3.8 },
  { week: "S10", minutes: 3.7 },
  { week: "S11", minutes: 3.7 },
  { week: "S12", minutes: 3.67 }
] as const;

export const LUMEN_ADOPTION_TREND = [
  { week: "S1", adoption: 20 },
  { week: "S2", adoption: 31 },
  { week: "S3", adoption: 42 },
  { week: "S4", adoption: 54 },
  { week: "S5", adoption: 63 },
  { week: "S6", adoption: 72 },
  { week: "S7", adoption: 79 },
  { week: "S8", adoption: 86 }
] as const;

export const LUMEN_PROFESSIONALS = [
  { name: "Dra. Camacho", specialty: "Glaucoma", consultations: 412, minutes: 3.2 },
  { name: "Opt. Suárez", specialty: "Optometría", consultations: 402, minutes: 3.45 },
  { name: "Dr. Rueda", specialty: "Retina", consultations: 388, minutes: 3.92 },
  { name: "Dra. Niño", specialty: "Córnea", consultations: 356, minutes: 4.2 }
] as const;

export function filterLumenLabs(
  documents: readonly LumenLabDocument[],
  status: "all" | LumenLabStatus,
  query: string
): LumenLabDocument[] {
  const normalized = query.trim().toLocaleLowerCase("es");
  return documents.filter((document) => {
    if (status !== "all" && document.status !== status) return false;
    if (!normalized) return true;
    return `${document.title} ${document.patient} ${document.lab}`.toLocaleLowerCase("es").includes(normalized);
  });
}

export function lumenLabStatusLabel(status: LumenLabStatus): string {
  if (status === "validated") return "Validado";
  if (status === "review") return "Requiere revisión";
  if (status === "processing") return "Procesando";
  return "Por validar";
}

export function lumenInvoiceStatusLabel(status: LumenInvoiceStatus): string {
  if (status === "validated") return "Validada";
  if (status === "retained") return "RIPS retenido";
  return "En proceso";
}

export function lumenLabCaptureError(mimeType: string, sizeBytes: number): string | undefined {
  const supported = mimeType.startsWith("image/") || mimeType === "application/pdf";
  if (!supported) return "Usa una imagen o un PDF.";
  if (sizeBytes <= 0 || sizeBytes > 8 * 1024 * 1024) return "El archivo debe pesar entre 1 byte y 8 MiB.";
  return undefined;
}

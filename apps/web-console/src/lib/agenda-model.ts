export interface AgendaQueueItem {
  id: string;
  recordType?: "appointment" | "hold" | "configuration_error";
  origin?: string | null;
  professionalIsPilot?: boolean;
  status: string;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt?: string;
  siteId?: string | null;
  siteName?: string | null;
  professionalId?: string | null;
  professionalName?: string | null;
  appointmentTypeId?: string | null;
  appointmentTypeName?: string | null;
  payerId?: string | null;
  payerName?: string | null;
  patientName?: string | null;
  conversationId?: string | null;
  externalReference?: string | null;
  externalSystem?: string | null;
  verificationMode?: string | null;
  holdExpiresAt?: string | null;
  externalConfirmationDueAt?: string | null;
  externalSlaDueAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  rescheduleCount?: number;
}

export interface AgendaQueueResponse {
  items?: AgendaQueueItem[];
  appointments?: AgendaQueueItem[];
  holds?: Array<Record<string, unknown>>;
  configurationErrors?: Array<Record<string, unknown> | string>;
  summary?: Record<string, number>;
}

export interface NormalizedAgendaQueueResponse {
  items: AgendaQueueItem[];
  summary?: Record<string, number>;
}

export type AgendaQueueView = "pending" | "verified" | "closed" | "holds" | "errors";

export interface ImportPreviewRow {
  rowNumber: number;
  accepted: boolean;
  reason?: string;
  values?: Record<string, unknown>;
}

export interface ImportPreview {
  accepted: number;
  rejected: number;
  rows: ImportPreviewRow[];
  previewToken?: string;
}

export function normalizeQueueResponse(value: AgendaQueueResponse | AgendaQueueItem[]): NormalizedAgendaQueueResponse {
  if (Array.isArray(value)) return { items: value.map((item) => ({ ...item, recordType: "appointment" })) };
  const appointments = (value.items ?? value.appointments ?? []).map((item) => {
    const dueAt = item.externalConfirmationDueAt ?? nullableString(item.externalSlaDueAt);
    return {
      ...item,
      ...(dueAt ? { externalConfirmationDueAt: dueAt } : {}),
      recordType: item.recordType ?? ("appointment" as const)
    };
  });
  const holds = (value.holds ?? []).map((raw, index): AgendaQueueItem => ({
    id: String(raw.id ?? raw.holdId ?? `hold-${index}`),
    recordType: "hold",
    status: String(raw.status ?? "held"),
    scheduledAt: nullableString(raw.scheduledAt ?? raw.startsAt),
    createdAt: String(raw.createdAt ?? new Date(0).toISOString()),
    updatedAt: nullableString(raw.updatedAt) ?? undefined,
    siteId: nullableString(raw.siteId),
    siteName: nullableString(raw.siteName),
    professionalId: nullableString(raw.professionalId),
    professionalName: nullableString(raw.professionalName),
    appointmentTypeId: nullableString(raw.appointmentTypeId),
    appointmentTypeName: nullableString(raw.appointmentTypeName),
    payerId: nullableString(raw.payerId),
    payerName: nullableString(raw.payerName),
    patientName: nullableString(raw.patientName),
    conversationId: nullableString(raw.conversationId),
    holdExpiresAt: nullableString(raw.holdExpiresAt ?? raw.expiresAt)
  }));
  const configurationErrors = (value.configurationErrors ?? []).map((raw, index): AgendaQueueItem => {
    const record = typeof raw === "string" ? { message: raw } : raw;
    return {
      id: String(record.id ?? `${String(record.code ?? "configuration")}-${index}`),
      recordType: "configuration_error",
      status: "configuration_error",
      scheduledAt: null,
      createdAt: String(record.createdAt ?? new Date(0).toISOString()),
      errorCode: nullableString(record.code ?? record.errorCode),
      errorMessage: nullableString(record.message ?? record.errorMessage) ?? "Error de configuracion de agenda"
    };
  });
  return { items: [...appointments, ...holds, ...configurationErrors], summary: value.summary };
}

export function queueViewFor(item: AgendaQueueItem): AgendaQueueView {
  if (item.recordType === "configuration_error") return "errors";
  if (item.recordType === "hold") return "holds";
  if (
    item.errorCode ||
    item.errorMessage ||
    ["configuration_error", "verification_failed", "failed"].includes(item.status)
  ) {
    return "errors";
  }
  if (item.holdExpiresAt && ["offered", "held", "pending_hold"].includes(item.status)) {
    return "holds";
  }
  if (["verified", "confirmed"].includes(item.status)) return "verified";
  if (["cancelled", "rejected", "external_rejected", "expired", "rescheduled", "no_show"].includes(item.status)) {
    return "closed";
  }
  return "pending";
}

export function queuePrimaryLabel(item: AgendaQueueItem): string {
  if (item.recordType === "configuration_error") return "Problema de configuracion de agenda";
  if (item.recordType === "hold") return "Reserva temporal sin cita vinculada";
  return item.patientName ?? "Identidad del paciente no vinculada";
}

export function queueConfigurationLabel(item: AgendaQueueItem): string {
  if (item.recordType === "configuration_error") return "Revisar configuracion de agenda";
  if (item.recordType === "hold") return "Cupo temporal reservado";
  return (
    [item.appointmentTypeName, item.professionalName, item.siteName].filter(Boolean).join(" · ") ||
    "Configuracion incompleta: faltan tipo de cita, profesional o sede"
  );
}

export function queueScheduleLabel(item: AgendaQueueItem): string | undefined {
  if (item.scheduledAt) return undefined;
  if (item.recordType === "configuration_error") return "Sin franja aplicable";
  return "Configuracion incompleta: la cita no tiene horario";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function queueStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending_external_confirmation: "Pendiente de confirmacion externa",
    pending_provider: "Pendiente del proveedor",
    submitted: "Enviada",
    offered: "Reserva temporal",
    held: "Reserva temporal",
    active: "Reserva temporal activa",
    expired: "Reserva temporal vencida",
    consumed: "Reserva consumida",
    verified: "Verificada",
    confirmed: "Asistencia confirmada",
    verification_failed: "Fallo de verificacion",
    external_rejected: "Rechazada externamente",
    rejected: "Rechazada",
    deferred: "Diferida",
    failed: "Fallida",
    cancelled: "Cancelada",
    rescheduled: "Reagendada",
    no_show: "No asistio"
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

export function queueTone(status: string): "green" | "red" | "amber" | "blue" | undefined {
  if (["verified", "confirmed"].includes(status)) return "green";
  if (
    ["cancelled", "rejected", "external_rejected", "verification_failed", "failed", "no_show", "expired"].includes(
      status
    )
  ) {
    return "red";
  }
  if (["pending_external_confirmation", "pending_provider", "deferred", "offered", "held", "active"].includes(status)) {
    return "amber";
  }
  return "blue";
}

export function normalizeImportPreview(value: unknown): ImportPreview {
  const data = (value ?? {}) as Record<string, unknown>;
  const rawRows = Array.isArray(data.rows)
    ? data.rows
    : [
        ...(Array.isArray(data.accepted) ? data.accepted : []).map((row) => ({ ...(row as object), accepted: true })),
        ...(Array.isArray(data.rejected) ? data.rejected : []).map((row) => ({ ...(row as object), accepted: false })),
        ...(Array.isArray(data.acceptedRows) ? data.acceptedRows : []).map((row) => ({
          ...(row as object),
          accepted: true
        })),
        ...(Array.isArray(data.rejectedRows) ? data.rejectedRows : []).map((row) => ({
          ...(row as object),
          accepted: false
        }))
      ];
  const rows = rawRows.map((row, index) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      rowNumber: Number(record.rowNumber ?? record.row ?? index + 2),
      accepted: record.accepted !== false && !record.reason && !record.error,
      reason: record.reason ? String(record.reason) : record.error ? String(record.error) : undefined,
      values:
        (record.values as Record<string, unknown> | undefined) ??
        (record.data as Record<string, unknown> | undefined) ??
        record
    };
  });
  const summary = (data.summary ?? {}) as Record<string, unknown>;
  return {
    accepted: Number(
      (Array.isArray(data.accepted) ? undefined : data.accepted) ??
        summary.accepted ??
        rows.filter((row) => row.accepted).length
    ),
    rejected: Number(
      (Array.isArray(data.rejected) ? undefined : data.rejected) ??
        summary.rejected ??
        rows.filter((row) => !row.accepted).length
    ),
    rows,
    previewToken: typeof data.previewToken === "string" ? data.previewToken : undefined
  };
}

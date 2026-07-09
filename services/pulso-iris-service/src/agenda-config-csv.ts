import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { ServiceContext } from "@hyperion/service-runtime";

type Database = NonNullable<ServiceContext["db"]>;
type QueryExecutor = Pick<Database, "query">;

export const AGENDA_IMPORT_RESOURCES = [
  "professionals",
  "professional-sites",
  "professional-appointment-types",
  "availability-rules",
  "payer-exclusions",
  "agenda-blocks"
] as const;

export type AgendaImportResource = (typeof AGENDA_IMPORT_RESOURCES)[number];

type NormalizedRow = Record<string, string | number | null>;

export interface AgendaImportAcceptedRow {
  row: number;
  data: NormalizedRow;
}

export interface AgendaImportRejectedRow {
  row: number;
  reason: string;
}

export interface AgendaImportPreview {
  resource: AgendaImportResource;
  accepted: AgendaImportAcceptedRow[];
  rejected: AgendaImportRejectedRow[];
  summary: {
    total: number;
    accepted: number;
    rejected: number;
  };
}

export interface AgendaImportApplyResult extends AgendaImportPreview {
  importId: string;
  applied: number;
  idempotent: boolean;
}

interface ImportDefinition {
  headers: readonly string[];
  required: readonly string[];
}

const IMPORT_DEFINITIONS: Record<AgendaImportResource, ImportDefinition> = {
  professionals: {
    headers: ["name", "professional_type", "subspecialty", "status"],
    required: ["name", "professional_type"]
  },
  "professional-sites": {
    headers: ["professional_id", "site_id", "status"],
    required: ["professional_id", "site_id"]
  },
  "professional-appointment-types": {
    headers: ["professional_id", "appointment_type_id", "status"],
    required: ["professional_id", "appointment_type_id"]
  },
  "availability-rules": {
    headers: [
      "site_id",
      "professional_id",
      "appointment_type_id",
      "weekday",
      "starts_at",
      "ends_at",
      "slot_duration_min",
      "capacity",
      "timezone",
      "effective_from",
      "effective_to",
      "status",
      "notes"
    ],
    required: [
      "site_id",
      "professional_id",
      "appointment_type_id",
      "weekday",
      "starts_at",
      "ends_at",
      "slot_duration_min",
      "capacity"
    ]
  },
  "payer-exclusions": {
    headers: ["professional_id", "payer_id", "status"],
    required: ["professional_id", "payer_id"]
  },
  "agenda-blocks": {
    headers: [
      "site_id",
      "professional_id",
      "appointment_type_id",
      "starts_at",
      "ends_at",
      "block_type",
      "reason",
      "status"
    ],
    required: ["starts_at", "ends_at", "reason"]
  }
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_CSV_BYTES = 2_000_000;
const MAX_CSV_ROWS = 2_000;

export class AgendaCsvError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

export function parseAgendaImportResource(value: unknown): AgendaImportResource | undefined {
  return typeof value === "string" && AGENDA_IMPORT_RESOURCES.includes(value as AgendaImportResource)
    ? (value as AgendaImportResource)
    : undefined;
}

export function agendaImportTemplate(resource: AgendaImportResource): { csv: string; filename: string } {
  return {
    csv: `${IMPORT_DEFINITIONS[resource].headers.join(",")}\r\n`,
    filename: `pulso-iris-${resource}-template.csv`
  };
}

export async function previewAgendaImport(
  db: QueryExecutor,
  tenantId: string,
  resource: AgendaImportResource,
  csv: string
): Promise<AgendaImportPreview> {
  const rows = parseCsv(csv, IMPORT_DEFINITIONS[resource]);
  const context = await loadValidationContext(db, tenantId);
  const accepted: AgendaImportAcceptedRow[] = [];
  const rejected: AgendaImportRejectedRow[] = [];
  const fileKeys = new Set<string>();
  const acceptedAvailability: NormalizedRow[] = [];

  for (const input of rows) {
    try {
      const normalized = normalizeRow(resource, input.data);
      const reason = validateNormalizedRow(resource, normalized, context, fileKeys, acceptedAvailability);
      if (reason) {
        rejected.push({ row: input.row, reason });
        continue;
      }

      const key = naturalKey(resource, normalized);
      fileKeys.add(key);
      if (resource === "availability-rules") {
        acceptedAvailability.push(normalized);
      }
      accepted.push({ row: input.row, data: normalized });
    } catch (error) {
      rejected.push({
        row: input.row,
        reason: error instanceof Error ? error.message : "Fila invalida"
      });
    }
  }

  return {
    resource,
    accepted,
    rejected,
    summary: {
      total: rows.length,
      accepted: accepted.length,
      rejected: rejected.length
    }
  };
}

export async function applyAgendaImport(input: {
  db: Database;
  tenantId: string;
  resource: AgendaImportResource;
  csv: string;
  idempotencyKey: string;
  operatorId?: string;
}): Promise<AgendaImportApplyResult> {
  const contentHash = createHash("sha256").update(`${input.resource}\n${input.csv}`).digest("hex");
  const preview = await previewAgendaImport(input.db, input.tenantId, input.resource, input.csv);

  try {
    return await input.db.transaction(async (transaction) => {
      const existing = await transaction.query<ConfigurationImportRow>(
        `select id, content_hash as "contentHash", preview, status
         from pulso_iris.configuration_imports
         where tenant_id = $1 and idempotency_key = $2
         for update`,
        [input.tenantId, input.idempotencyKey]
      );
      const previous = existing.rows[0];
      if (previous) {
        if (previous.contentHash !== contentHash || previous.preview.resource !== input.resource) {
          throw new AgendaCsvError("La clave de idempotencia ya fue usada con otro archivo", 409);
        }
        return {
          ...previous.preview,
          importId: previous.id,
          applied: previous.status === "applied" ? previous.preview.summary.accepted : 0,
          idempotent: true
        };
      }

      const created = await transaction.query<{ id: string }>(
        `insert into pulso_iris.configuration_imports
           (tenant_id, kind, idempotency_key, content_hash, status, row_count, accepted_count,
            rejected_count, created_by, preview, error_summary)
         values ($1, $2, $3, $4, 'previewed', $5, $6, $7, $8, $9::jsonb, $10::jsonb)
         returning id`,
        [
          input.tenantId,
          databaseImportKind(input.resource),
          input.idempotencyKey,
          contentHash,
          preview.summary.total,
          preview.summary.accepted,
          preview.summary.rejected,
          input.operatorId ?? null,
          JSON.stringify(preview),
          JSON.stringify(preview.rejected)
        ]
      );
      const importId = created.rows[0]?.id;
      if (!importId) {
        throw new Error("No se pudo crear el registro de importacion");
      }

      for (const row of preview.accepted) {
        await insertConfigurationRow(transaction, input.tenantId, input.resource, row.data);
      }

      await transaction.query(
        `update pulso_iris.configuration_imports
         set status = 'applied', applied_at = now(), updated_at = now()
         where tenant_id = $1 and id = $2`,
        [input.tenantId, importId]
      );

      return {
        ...preview,
        importId,
        applied: preview.summary.accepted,
        idempotent: false
      };
    });
  } catch (error) {
    if (isDatabaseCode(error, "23505") || isDatabaseCode(error, "23P01")) {
      const existing = await input.db.query<ConfigurationImportRow>(
        `select id, content_hash as "contentHash", preview, status
         from pulso_iris.configuration_imports
         where tenant_id = $1 and idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey]
      );
      const previous = existing.rows[0];
      if (previous && previous.contentHash === contentHash && previous.preview.resource === input.resource) {
        return {
          ...previous.preview,
          importId: previous.id,
          applied: previous.status === "applied" ? previous.preview.summary.accepted : 0,
          idempotent: true
        };
      }
      throw new AgendaCsvError("La configuracion cambio desde la vista previa; vuelva a validar el archivo", 409);
    }
    if (isDatabaseCode(error, "23503") || isDatabaseCode(error, "23514")) {
      throw new AgendaCsvError("La configuracion relacionada cambio; vuelva a validar el archivo", 409);
    }
    throw error;
  }
}

export async function exportAgendaResource(
  db: QueryExecutor,
  tenantId: string,
  resource: AgendaImportResource
): Promise<{ csv: string; filename: string }> {
  const rows = await readExportRows(db, tenantId, resource);
  return {
    csv: serializeCsv(IMPORT_DEFINITIONS[resource].headers, rows),
    filename: `pulso-iris-${resource}.csv`
  };
}

interface ParsedInputRow {
  row: number;
  data: Record<string, string>;
}

function parseCsv(csv: string, definition: ImportDefinition): ParsedInputRow[] {
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) {
    throw new AgendaCsvError(`El CSV supera el limite de ${MAX_CSV_BYTES} bytes`, 413);
  }

  const records = tokenizeCsv(csv.replace(/^\uFEFF/, ""));
  const header = records.shift()?.map((cell) => cell.trim()) ?? [];
  if (header.length === 0 || header.every((cell) => cell === "")) {
    throw new AgendaCsvError("El CSV no contiene encabezados");
  }
  if (new Set(header).size !== header.length) {
    throw new AgendaCsvError("El CSV contiene encabezados duplicados");
  }

  const missing = definition.headers.filter((expected) => !header.includes(expected));
  const unknown = header.filter((actual) => !definition.headers.includes(actual));
  if (missing.length > 0 || unknown.length > 0) {
    const detail = [
      missing.length > 0 ? `faltan: ${missing.join(", ")}` : undefined,
      unknown.length > 0 ? `no reconocidos: ${unknown.join(", ")}` : undefined
    ]
      .filter(Boolean)
      .join("; ");
    throw new AgendaCsvError(`Encabezados invalidos (${detail})`);
  }

  const nonEmpty = records
    .map((record, index) => ({ record, row: index + 2 }))
    .filter(({ record }) => record.some((cell) => cell.trim() !== ""));
  if (nonEmpty.length > MAX_CSV_ROWS) {
    throw new AgendaCsvError(`El CSV supera el limite de ${MAX_CSV_ROWS} filas`, 413);
  }

  return nonEmpty.map(({ record, row }) => {
    if (record.length !== header.length) {
      throw new AgendaCsvError(`La fila ${row} tiene ${record.length} columnas; se esperaban ${header.length}`);
    }
    const data = Object.fromEntries(header.map((name, column) => [name, record[column]?.trim() ?? ""]));
    for (const required of definition.required) {
      if (!data[required]) {
        data.__missing = required;
        break;
      }
    }
    return { row, data };
  });
}

function tokenizeCsv(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"') {
      if (cell.length > 0) {
        throw new AgendaCsvError("Comillas invalidas en el CSV");
      }
      quoted = true;
    } else if (character === ",") {
      record.push(cell);
      cell = "";
    } else if (character === "\n") {
      record.push(cell.replace(/\r$/, ""));
      records.push(record);
      record = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) {
    throw new AgendaCsvError("El CSV contiene una celda entre comillas sin cerrar");
  }
  if (cell.length > 0 || record.length > 0) {
    record.push(cell.replace(/\r$/, ""));
    records.push(record);
  }
  return records;
}

function normalizeRow(resource: AgendaImportResource, data: Record<string, string>): NormalizedRow {
  if (data.__missing) {
    throw new Error(`El campo ${data.__missing} es obligatorio`);
  }
  const status = normalizeStatus(data.status);

  switch (resource) {
    case "professionals":
      if (!data.name || data.name.length < 2) throw new Error("name debe tener al menos 2 caracteres");
      if (data.professional_type !== "ophthalmologist" && data.professional_type !== "optometrist") {
        throw new Error("professional_type debe ser ophthalmologist u optometrist");
      }
      return {
        name: data.name,
        professional_type: data.professional_type,
        subspecialty: optionalText(data.subspecialty),
        status
      };
    case "professional-sites":
      return {
        professional_id: requiredUuid(data.professional_id, "professional_id"),
        site_id: requiredUuid(data.site_id, "site_id"),
        status
      };
    case "professional-appointment-types":
      return {
        professional_id: requiredUuid(data.professional_id, "professional_id"),
        appointment_type_id: requiredUuid(data.appointment_type_id, "appointment_type_id"),
        status
      };
    case "availability-rules": {
      const startsAt = normalizeTime(data.starts_at, "starts_at");
      const endsAt = normalizeTime(data.ends_at, "ends_at");
      if (timeToSeconds(endsAt) <= timeToSeconds(startsAt)) throw new Error("ends_at debe ser posterior a starts_at");
      const effectiveFrom = optionalDate(data.effective_from, "effective_from");
      const effectiveTo = optionalDate(data.effective_to, "effective_to");
      if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
        throw new Error("effective_to debe ser igual o posterior a effective_from");
      }
      const timezone = data.timezone || "America/Bogota";
      assertTimezone(timezone);
      return {
        site_id: requiredUuid(data.site_id, "site_id"),
        professional_id: requiredUuid(data.professional_id, "professional_id"),
        appointment_type_id: requiredUuid(data.appointment_type_id, "appointment_type_id"),
        weekday: requiredInteger(data.weekday, "weekday", 0, 6),
        starts_at: startsAt,
        ends_at: endsAt,
        slot_duration_min: requiredInteger(data.slot_duration_min, "slot_duration_min", 1, 1_440),
        capacity: requiredInteger(data.capacity, "capacity", 1, 1_000),
        timezone,
        effective_from: effectiveFrom,
        effective_to: effectiveTo,
        status,
        notes: optionalText(data.notes)
      };
    }
    case "payer-exclusions":
      return {
        professional_id: requiredUuid(data.professional_id, "professional_id"),
        payer_id: requiredUuid(data.payer_id, "payer_id"),
        status
      };
    case "agenda-blocks": {
      const startsAt = requiredDateTime(data.starts_at, "starts_at");
      const endsAt = requiredDateTime(data.ends_at, "ends_at");
      if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
        throw new Error("ends_at debe ser posterior a starts_at");
      }
      if (!data.reason || data.reason.length < 2) throw new Error("reason debe tener al menos 2 caracteres");
      const blockType = data.block_type || "block";
      if (blockType !== "block" && blockType !== "absence" && blockType !== "vacation") {
        throw new Error("block_type debe ser block, absence o vacation");
      }
      return {
        site_id: optionalUuid(data.site_id, "site_id"),
        professional_id: optionalUuid(data.professional_id, "professional_id"),
        appointment_type_id: optionalUuid(data.appointment_type_id, "appointment_type_id"),
        starts_at: startsAt,
        ends_at: endsAt,
        block_type: blockType,
        reason: data.reason,
        status:
          data.status === "cancelled"
            ? "cancelled"
            : data.status === "active" || !data.status
              ? "active"
              : invalidBlockStatus()
      };
    }
  }
}

interface ValidationContext {
  professionalIds: Set<string>;
  professionalNames: Set<string>;
  siteIds: Set<string>;
  appointmentTypes: Map<string, { durationMin: number }>;
  payerIds: Set<string>;
  activeProfessionalSites: Set<string>;
  activeProfessionalAppointmentTypes: Set<string>;
  existingKeys: Record<AgendaImportResource, Set<string>>;
  availabilityRules: ExistingAvailabilityRule[];
}

interface ExistingAvailabilityRule {
  professionalId: string;
  weekday: number;
  startsAt: string;
  endsAt: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  status: string;
}

async function loadValidationContext(db: QueryExecutor, tenantId: string): Promise<ValidationContext> {
  const [
    professionals,
    sites,
    appointmentTypes,
    payers,
    professionalSites,
    professionalTypes,
    rules,
    exclusions,
    blocks
  ] = await Promise.all([
    db.query<{ id: string; name: string }>("select id, name from pulso_iris.professionals where tenant_id = $1", [
      tenantId
    ]),
    db.query<{ id: string }>("select id from pulso_iris.sites where tenant_id = $1", [tenantId]),
    db.query<{ id: string; durationMin: number }>(
      `select id, duration_min as "durationMin" from pulso_iris.appointment_types where tenant_id = $1`,
      [tenantId]
    ),
    db.query<{ id: string }>("select id from pulso_iris.payers where tenant_id = $1", [tenantId]),
    db.query<{ professionalId: string; siteId: string; status: string }>(
      `select professional_id as "professionalId", site_id as "siteId", status
         from pulso_iris.professional_sites where tenant_id = $1`,
      [tenantId]
    ),
    db.query<{ professionalId: string; appointmentTypeId: string; status: string }>(
      `select professional_id as "professionalId", appointment_type_id as "appointmentTypeId", status
         from pulso_iris.professional_appointment_types where tenant_id = $1`,
      [tenantId]
    ),
    db.query<ExistingAvailabilityRule & { siteId: string; appointmentTypeId: string }>(
      `select professional_id as "professionalId", site_id as "siteId",
                appointment_type_id as "appointmentTypeId", weekday::int as weekday,
                to_char(starts_at, 'HH24:MI:SS') as "startsAt", to_char(ends_at, 'HH24:MI:SS') as "endsAt",
                effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo", status
         from pulso_iris.availability_rules where tenant_id = $1`,
      [tenantId]
    ),
    db.query<{ professionalId: string; payerId: string }>(
      `select professional_id as "professionalId", payer_id as "payerId"
         from pulso_iris.professional_payer_exclusions where tenant_id = $1`,
      [tenantId]
    ),
    db.query<{
      siteId: string | null;
      professionalId: string | null;
      appointmentTypeId: string | null;
      startsAt: Date | string;
      endsAt: Date | string;
      blockType: string;
      reason: string;
    }>(
      `select site_id as "siteId", professional_id as "professionalId",
                appointment_type_id as "appointmentTypeId", starts_at as "startsAt", ends_at as "endsAt",
                block_type as "blockType", reason
         from pulso_iris.agenda_blocks where tenant_id = $1`,
      [tenantId]
    )
  ]);

  const existingKeys = Object.fromEntries(
    AGENDA_IMPORT_RESOURCES.map((resource) => [resource, new Set<string>()])
  ) as Record<AgendaImportResource, Set<string>>;
  for (const row of professionals.rows) existingKeys.professionals.add(normalizeName(row.name));
  for (const row of professionalSites.rows) {
    existingKeys["professional-sites"].add(`${row.professionalId}|${row.siteId}`);
  }
  for (const row of professionalTypes.rows) {
    existingKeys["professional-appointment-types"].add(`${row.professionalId}|${row.appointmentTypeId}`);
  }
  for (const row of rules.rows) {
    existingKeys["availability-rules"].add(
      `${row.siteId}|${row.professionalId}|${row.appointmentTypeId}|${row.weekday}|${row.startsAt}|${row.effectiveFrom ?? ""}`
    );
  }
  for (const row of exclusions.rows) {
    existingKeys["payer-exclusions"].add(`${row.professionalId}|${row.payerId}`);
  }
  for (const row of blocks.rows) {
    existingKeys["agenda-blocks"].add(
      `${row.siteId ?? ""}|${row.professionalId ?? ""}|${row.appointmentTypeId ?? ""}|${toIso(row.startsAt)}|${toIso(row.endsAt)}|${row.blockType}|${normalizeName(row.reason)}`
    );
  }

  return {
    professionalIds: new Set(professionals.rows.map((row) => row.id)),
    professionalNames: new Set(professionals.rows.map((row) => normalizeName(row.name))),
    siteIds: new Set(sites.rows.map((row) => row.id)),
    appointmentTypes: new Map(appointmentTypes.rows.map((row) => [row.id, { durationMin: row.durationMin }])),
    payerIds: new Set(payers.rows.map((row) => row.id)),
    activeProfessionalSites: new Set(
      professionalSites.rows
        .filter((row) => row.status === "active")
        .map((row) => `${row.professionalId}|${row.siteId}`)
    ),
    activeProfessionalAppointmentTypes: new Set(
      professionalTypes.rows
        .filter((row) => row.status === "active")
        .map((row) => `${row.professionalId}|${row.appointmentTypeId}`)
    ),
    existingKeys,
    availabilityRules: rules.rows
  };
}

function validateNormalizedRow(
  resource: AgendaImportResource,
  row: NormalizedRow,
  context: ValidationContext,
  fileKeys: Set<string>,
  acceptedAvailability: NormalizedRow[]
): string | undefined {
  const key = naturalKey(resource, row);
  if (fileKeys.has(key)) return "Fila duplicada dentro del archivo";
  if (context.existingKeys[resource].has(key)) return "La configuracion ya existe";

  if (resource === "professionals") {
    return context.professionalNames.has(normalizeName(String(row.name)))
      ? "Ya existe un profesional con ese nombre"
      : undefined;
  }

  const professionalId = typeof row.professional_id === "string" ? row.professional_id : undefined;
  const siteId = typeof row.site_id === "string" ? row.site_id : undefined;
  const appointmentTypeId = typeof row.appointment_type_id === "string" ? row.appointment_type_id : undefined;
  if (professionalId && !context.professionalIds.has(professionalId)) return "professional_id no pertenece al tenant";
  if (siteId && !context.siteIds.has(siteId)) return "site_id no pertenece al tenant";
  if (appointmentTypeId && !context.appointmentTypes.has(appointmentTypeId)) {
    return "appointment_type_id no pertenece al tenant";
  }

  if (resource === "professional-sites" || resource === "professional-appointment-types") return undefined;
  if (resource === "payer-exclusions") {
    return typeof row.payer_id !== "string" || !context.payerIds.has(row.payer_id)
      ? "payer_id no pertenece al tenant"
      : undefined;
  }
  if (resource === "agenda-blocks") return undefined;

  if (!professionalId || !siteId || !appointmentTypeId) return "Referencias de horario incompletas";
  if (!context.activeProfessionalSites.has(`${professionalId}|${siteId}`)) {
    return "El profesional no tiene una relacion activa con la sede";
  }
  if (!context.activeProfessionalAppointmentTypes.has(`${professionalId}|${appointmentTypeId}`)) {
    return "El profesional no esta autorizado para el tipo de cita";
  }
  const appointmentType = context.appointmentTypes.get(appointmentTypeId);
  if (Number(row.slot_duration_min) < (appointmentType?.durationMin ?? 0)) {
    return `slot_duration_min debe ser igual o mayor a ${appointmentType?.durationMin ?? 0}`;
  }

  const candidate = toAvailabilityRange(row);
  const overlapsExisting = context.availabilityRules.some((rule) => availabilityRangesOverlap(candidate, rule));
  const overlapsFile = acceptedAvailability.some((other) =>
    availabilityRangesOverlap(candidate, toAvailabilityRange(other))
  );
  return overlapsExisting || overlapsFile ? "El horario se cruza con otra regla del profesional" : undefined;
}

function naturalKey(resource: AgendaImportResource, row: NormalizedRow): string {
  switch (resource) {
    case "professionals":
      return normalizeName(String(row.name));
    case "professional-sites":
      return `${row.professional_id}|${row.site_id}`;
    case "professional-appointment-types":
      return `${row.professional_id}|${row.appointment_type_id}`;
    case "availability-rules":
      return `${row.site_id}|${row.professional_id}|${row.appointment_type_id}|${row.weekday}|${row.starts_at}|${row.effective_from ?? ""}`;
    case "payer-exclusions":
      return `${row.professional_id}|${row.payer_id}`;
    case "agenda-blocks":
      return `${row.site_id ?? ""}|${row.professional_id ?? ""}|${row.appointment_type_id ?? ""}|${row.starts_at}|${row.ends_at}|${row.block_type}|${normalizeName(String(row.reason))}`;
  }
}

async function insertConfigurationRow(
  db: QueryExecutor,
  tenantId: string,
  resource: AgendaImportResource,
  row: NormalizedRow
): Promise<void> {
  switch (resource) {
    case "professionals":
      await db.query(
        `insert into pulso_iris.professionals
           (tenant_id, name, professional_type, subspecialty, status)
         values ($1, $2, $3, $4, $5)`,
        [tenantId, row.name, row.professional_type, row.subspecialty, row.status]
      );
      return;
    case "professional-sites":
      await db.query(
        `insert into pulso_iris.professional_sites (tenant_id, professional_id, site_id, status)
         values ($1, $2, $3, $4)`,
        [tenantId, row.professional_id, row.site_id, row.status]
      );
      return;
    case "professional-appointment-types":
      await db.query(
        `insert into pulso_iris.professional_appointment_types
           (tenant_id, professional_id, appointment_type_id, status)
         values ($1, $2, $3, $4)`,
        [tenantId, row.professional_id, row.appointment_type_id, row.status]
      );
      return;
    case "availability-rules":
      await db.query(
        `insert into pulso_iris.availability_rules
           (tenant_id, site_id, professional_id, appointment_type_id, weekday, starts_at, ends_at,
            slot_duration_min, capacity, timezone, effective_from, effective_to, status, notes)
         values ($1, $2, $3, $4, $5, $6::time, $7::time, $8, $9, $10, $11::date, $12::date, $13, $14)`,
        [
          tenantId,
          row.site_id,
          row.professional_id,
          row.appointment_type_id,
          row.weekday,
          row.starts_at,
          row.ends_at,
          row.slot_duration_min,
          row.capacity,
          row.timezone,
          row.effective_from,
          row.effective_to,
          row.status,
          row.notes
        ]
      );
      return;
    case "payer-exclusions":
      await db.query(
        `insert into pulso_iris.professional_payer_exclusions
           (tenant_id, professional_id, payer_id, status)
         values ($1, $2, $3, $4)`,
        [tenantId, row.professional_id, row.payer_id, row.status]
      );
      return;
    case "agenda-blocks":
      await db.query(
        `insert into pulso_iris.agenda_blocks
           (tenant_id, site_id, professional_id, appointment_type_id, starts_at, ends_at, block_type, reason, status)
         values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9)`,
        [
          tenantId,
          row.site_id,
          row.professional_id,
          row.appointment_type_id,
          row.starts_at,
          row.ends_at,
          row.block_type,
          row.reason,
          row.status
        ]
      );
  }
}

async function readExportRows(
  db: QueryExecutor,
  tenantId: string,
  resource: AgendaImportResource
): Promise<QueryResultRow[]> {
  switch (resource) {
    case "professionals":
      return (
        await db.query(
          `select name, professional_type, coalesce(subspecialty, '') as subspecialty, status
           from pulso_iris.professionals where tenant_id = $1 order by name`,
          [tenantId]
        )
      ).rows;
    case "professional-sites":
      return (
        await db.query(
          `select professional_id, site_id, status from pulso_iris.professional_sites
           where tenant_id = $1 order by professional_id, site_id`,
          [tenantId]
        )
      ).rows;
    case "professional-appointment-types":
      return (
        await db.query(
          `select professional_id, appointment_type_id, status
           from pulso_iris.professional_appointment_types
           where tenant_id = $1 order by professional_id, appointment_type_id`,
          [tenantId]
        )
      ).rows;
    case "availability-rules":
      return (
        await db.query(
          `select site_id, professional_id, appointment_type_id, weekday,
                  to_char(starts_at, 'HH24:MI:SS') as starts_at,
                  to_char(ends_at, 'HH24:MI:SS') as ends_at,
                  slot_duration_min, capacity, timezone,
                  coalesce(effective_from::text, '') as effective_from,
                  coalesce(effective_to::text, '') as effective_to,
                  status, coalesce(notes, '') as notes
           from pulso_iris.availability_rules where tenant_id = $1
           order by professional_id, weekday, starts_at`,
          [tenantId]
        )
      ).rows;
    case "payer-exclusions":
      return (
        await db.query(
          `select professional_id, payer_id, status
           from pulso_iris.professional_payer_exclusions
           where tenant_id = $1 order by professional_id, payer_id`,
          [tenantId]
        )
      ).rows;
    case "agenda-blocks":
      return (
        await db.query(
          `select coalesce(site_id::text, '') as site_id,
                  coalesce(professional_id::text, '') as professional_id,
                  coalesce(appointment_type_id::text, '') as appointment_type_id,
                  to_char(starts_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as starts_at,
                  to_char(ends_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as ends_at,
                  block_type, reason, status
           from pulso_iris.agenda_blocks where tenant_id = $1 order by starts_at`,
          [tenantId]
        )
      ).rows;
  }
}

function serializeCsv(headers: readonly string[], rows: QueryResultRow[]): string {
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsvCell(row[header] ?? "")).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function escapeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function normalizeStatus(value: string | undefined): "active" | "paused" {
  if (!value || value === "active") return "active";
  if (value === "paused") return "paused";
  throw new Error("status debe ser active o paused");
}

function invalidBlockStatus(): never {
  throw new Error("status debe ser active o cancelled");
}

function requiredUuid(value: string | undefined, field: string): string {
  if (!value || !UUID_PATTERN.test(value)) throw new Error(`${field} debe ser UUID`);
  return value.toLowerCase();
}

function optionalUuid(value: string | undefined, field: string): string | null {
  return value ? requiredUuid(value, field) : null;
}

function requiredInteger(value: string | undefined, field: string, min: number, max: number): number {
  if (!value || !/^-?\d+$/.test(value)) throw new Error(`${field} debe ser entero`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} debe estar entre ${min} y ${max}`);
  }
  return parsed;
}

function normalizeTime(value: string | undefined, field: string): string {
  if (!value || !TIME_PATTERN.test(value)) throw new Error(`${field} debe usar HH:MM o HH:MM:SS`);
  return value.length === 5 ? `${value}:00` : value;
}

function timeToSeconds(value: string): number {
  const [hours = 0, minutes = 0, seconds = 0] = value.split(":").map(Number);
  return hours * 3_600 + minutes * 60 + seconds;
}

function optionalDate(value: string | undefined, field: string): string | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !DATE_PATTERN.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    value.startsWith("0000")
  ) {
    throw new Error(`${field} debe usar YYYY-MM-DD`);
  }
  return value;
}

function requiredDateTime(value: string | undefined, field: string): string {
  if (!value || !DATE_TIME_PATTERN.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`${field} debe ser fecha ISO 8601 con zona horaria`);
  }
  return new Date(value).toISOString();
}

function optionalText(value: string | undefined): string | null {
  return value?.trim() || null;
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("es-CO", { timeZone: timezone }).format();
  } catch {
    throw new Error("timezone no es una zona IANA valida");
  }
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("es-CO");
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function toAvailabilityRange(row: NormalizedRow): ExistingAvailabilityRule {
  return {
    professionalId: String(row.professional_id),
    weekday: Number(row.weekday),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    effectiveFrom: typeof row.effective_from === "string" ? row.effective_from : null,
    effectiveTo: typeof row.effective_to === "string" ? row.effective_to : null,
    status: String(row.status)
  };
}

function availabilityRangesOverlap(left: ExistingAvailabilityRule, right: ExistingAvailabilityRule): boolean {
  if (left.status !== "active" || right.status !== "active") return false;
  if (left.professionalId !== right.professionalId || left.weekday !== right.weekday) return false;
  const timesOverlap =
    timeToSeconds(left.startsAt) < timeToSeconds(right.endsAt) &&
    timeToSeconds(right.startsAt) < timeToSeconds(left.endsAt);
  const datesOverlap =
    (left.effectiveTo ?? "9999-12-31") >= (right.effectiveFrom ?? "0001-01-01") &&
    (right.effectiveTo ?? "9999-12-31") >= (left.effectiveFrom ?? "0001-01-01");
  return timesOverlap && datesOverlap;
}

function isDatabaseCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code?: unknown }).code) === code
  );
}

function databaseImportKind(resource: AgendaImportResource): string {
  return resource.replaceAll("-", "_");
}

interface ConfigurationImportRow {
  id: string;
  contentHash: string;
  preview: AgendaImportPreview;
  status: string;
}

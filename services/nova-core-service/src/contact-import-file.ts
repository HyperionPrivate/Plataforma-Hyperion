import { novaCatalog } from "@hyperion/contracts";
import { normalizeE164, normalizeSegment } from "./domain.js";

const MAX_FILE_BYTES = 2_000_000;
const MAX_ROWS = 5000;

export interface ContactImportRow {
  phone_e164: string;
  full_name?: string;
  agency_code?: string;
  ciudad?: string;
  documento?: string;
  cupo_preaprobado?: boolean;
  mora_actual?: number;
  saldo_total?: number;
  universidad?: string;
  segment?: string;
  email?: string;
}

export interface ContactImportParseError {
  row: number;
  reason: string;
}

export interface ContactImportParseResult {
  rows: ContactImportRow[];
  errors: ContactImportParseError[];
}

/** Pilot-compatible column aliases (CoopFuturo Excel/CSV exports). */
const COLUMN_ALIASES: Record<keyof ContactImportRow | "phone" | "name" | "agency", string[]> = {
  phone: ["phone", "telefono", "teléfono", "celular", "movil", "móvil", "phone_e164"],
  name: ["name", "full_name", "nombre", "nombres", "estudiante", "first_name"],
  agency: ["agency_code", "agency", "agencia", "sede", "codigo_agencia"],
  ciudad: ["ciudad", "city", "municipio"],
  documento: ["documento", "document", "cedula", "cédula", "id. nro", "id nro", "identificacion", "identificación"],
  cupo_preaprobado: ["cupo", "cupo_preaprobado", "cupo preaprobado"],
  mora_actual: ["mora", "mora_actual", "mora coop", "mora_coop"],
  saldo_total: ["saldo", "saldo_total", "saldo total"],
  universidad: ["universidad", "university", "ies"],
  segment: ["segment", "segmento", "flujo"],
  email: ["email", "correo", "e-mail"],
  phone_e164: [],
  full_name: [],
  agency_code: []
};

export function parseContactsCsv(csv: string): ContactImportParseResult {
  if (Buffer.byteLength(csv, "utf8") > MAX_FILE_BYTES) {
    return { rows: [], errors: [{ row: 0, reason: "file_too_large" }] };
  }

  const records = tokenizeCsv(csv.replace(/^\uFEFF/, ""));
  if (records.length === 0) {
    return { rows: [], errors: [{ row: 0, reason: "empty_file" }] };
  }

  const header = records[0]!.map((cell) => cell.trim());
  if (header.length === 0 || header.every((cell) => cell === "")) {
    return { rows: [], errors: [{ row: 1, reason: "missing_headers" }] };
  }

  const index = buildHeaderIndex(header);
  if (index.phone.length === 0) {
    return { rows: [], errors: [{ row: 1, reason: "missing_phone_column" }] };
  }

  const body = records
    .slice(1)
    .map((record, offset) => ({ record, row: offset + 2 }))
    .filter(({ record }) => record.some((cell) => cell.trim() !== ""));

  if (body.length > MAX_ROWS) {
    return { rows: [], errors: [{ row: 0, reason: `too_many_rows_max_${MAX_ROWS}` }] };
  }

  const rows: ContactImportRow[] = [];
  const errors: ContactImportParseError[] = [];

  for (const { record, row } of body) {
    const get = (...keys: Array<keyof typeof COLUMN_ALIASES>): string => {
      for (const key of keys) {
        for (const col of index[key] ?? []) {
          const value = record[col]?.trim() ?? "";
          if (value) return value;
        }
      }
      return "";
    };

    const phoneRaw = get("phone", "phone_e164");
    const phone = normalizeE164(phoneRaw);
    if (!phone) {
      errors.push({ row, reason: phoneRaw ? "phone_not_e164" : "phone_required" });
      continue;
    }

    const first = get("name", "full_name");
    const apellido1 = cellByAlias(header, record, ["apellido1", "apellido"]);
    const apellido2 = cellByAlias(header, record, ["apellido2"]);
    const fullName = [first, apellido1, apellido2].filter(Boolean).join(" ").trim() || undefined;

    const ciudad = get("ciudad") || undefined;
    const agencyRaw = get("agency", "agency_code");
    const agencyCode = resolveAgencyCode(agencyRaw, ciudad);

    const cupoRaw = get("cupo_preaprobado");
    const moraRaw = get("mora_actual");
    const saldoRaw = get("saldo_total");
    const segmentRaw = get("segment");

    rows.push({
      phone_e164: phone,
      full_name: fullName,
      agency_code: agencyCode,
      ciudad,
      documento: get("documento") || undefined,
      cupo_preaprobado: cupoRaw ? parseBoolean(cupoRaw) : undefined,
      mora_actual: moraRaw ? parseNumber(moraRaw) : undefined,
      saldo_total: saldoRaw ? parseNumber(saldoRaw) : undefined,
      universidad: get("universidad") || undefined,
      segment: segmentRaw ? normalizeSegment(segmentRaw) : undefined,
      email: get("email") || undefined
    });
  }

  return { rows, errors };
}

export function extractMultipartFile(
  contentType: string | undefined,
  body: Buffer
): { filename: string; content: Buffer } | { error: string } {
  if (!contentType || !contentType.toLowerCase().includes("multipart/form-data")) {
    return { error: "expected_multipart_form_data" };
  }
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return { error: "missing_multipart_boundary" };
  if (body.byteLength > MAX_FILE_BYTES + 64_000) return { error: "file_too_large" };

  const delimiter = Buffer.from(`--${boundary}`);
  let offset = indexOf(body, delimiter, 0);
  if (offset < 0) return { error: "invalid_multipart" };
  offset += delimiter.length;

  while (offset < body.length) {
    if (body[offset] === 45 && body[offset + 1] === 45) break; // closing --
    if (body[offset] === 13 && body[offset + 1] === 10) offset += 2;
    else if (body[offset] === 10) offset += 1;

    const headerEnd = indexOf(body, Buffer.from("\r\n\r\n"), offset);
    if (headerEnd < 0) break;
    const headers = body.subarray(offset, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;
    const next = indexOf(body, delimiter, dataStart);
    if (next < 0) break;
    let dataEnd = next;
    if (body[dataEnd - 2] === 13 && body[dataEnd - 1] === 10) dataEnd -= 2;
    else if (body[dataEnd - 1] === 10) dataEnd -= 1;

    const nameMatch = /name="([^"]+)"/i.exec(headers);
    const filenameMatch = /filename="([^"]*)"/i.exec(headers);
    const fieldName = nameMatch?.[1] ?? "";
    const filename = filenameMatch?.[1] ?? "upload.csv";
    const content = body.subarray(dataStart, dataEnd);

    if (filenameMatch || fieldName === "file" || fieldName === "csv") {
      return { filename, content };
    }

    offset = next + delimiter.length;
  }

  return { error: "file_field_required" };
}

export function isCsvFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".csv") || lower.endsWith(".txt") || lower === "upload.csv";
}

function buildHeaderIndex(header: string[]): Record<string, number[]> {
  const index: Record<string, number[]> = {};
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    index[canonical] = [];
    for (let i = 0; i < header.length; i += 1) {
      const normalized = normalizeHeader(header[i]!);
      if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
        index[canonical]!.push(i);
      }
    }
  }
  return index;
}

function cellByAlias(header: string[], record: string[], aliases: string[]): string {
  for (let i = 0; i < header.length; i += 1) {
    const normalized = normalizeHeader(header[i]!);
    if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
      const value = record[i]?.trim() ?? "";
      if (value) return value;
    }
  }
  return "";
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[_\s.]+/g, " ");
}

function resolveAgencyCode(agencyRaw?: string, ciudad?: string): string | undefined {
  if (agencyRaw) {
    const upper = agencyRaw.trim().toUpperCase();
    const byCode = novaCatalog.agencies.find((agency) => agency.code === upper);
    if (byCode) return byCode.code;
    const byCity = novaCatalog.agencies.find((agency) => normalizeHeader(agency.city) === normalizeHeader(agencyRaw));
    if (byCity) return byCity.code;
    if (/^[A-Z]{2,8}$/.test(upper)) return upper;
  }
  if (ciudad) {
    const byCity = novaCatalog.agencies.find((agency) => normalizeHeader(agency.city) === normalizeHeader(ciudad));
    return byCity?.code;
  }
  return undefined;
}

function parseBoolean(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (["1", "true", "si", "sí", "yes", "y", "x"].includes(value)) return true;
  if (["0", "false", "no", "n"].includes(value)) return false;
  return undefined;
}

function parseNumber(raw: string): number | undefined {
  const cleaned = raw
    .replace(/[$\s]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

function tokenizeCsv(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]!;
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

  if (cell.length > 0 || record.length > 0) {
    record.push(cell.replace(/\r$/, ""));
    records.push(record);
  }

  return records;
}

function indexOf(haystack: Buffer, needle: Buffer, from: number): number {
  return haystack.indexOf(needle, from);
}

const DEFAULT_TIME_ZONE = "America/Bogota";

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12
};

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6
};

export type AgendaConstraintInvalidReason =
  | "invalid_now"
  | "invalid_timezone"
  | "invalid_date"
  | "past_date"
  | "past_datetime"
  | "ambiguous_date"
  | "weekday_mismatch"
  | "invalid_time"
  | "ambiguous_time";

export interface AgendaRequestConstraints {
  localDate?: string;
  localTime?: string;
  bookingIntent: boolean;
  rescheduleIntent: boolean;
  requestsChange: boolean;
  invalidReason?: AgendaConstraintInvalidReason;
}

export interface AgendaRequestConstraintOptions {
  now?: Date;
  timeZone?: string;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

interface LocalDateTimeParts extends LocalDateParts {
  hour: number;
  minute: number;
}

interface DateResolution {
  localDate?: string;
  invalidReason?: AgendaConstraintInvalidReason;
}

interface TimeResolution {
  localTime?: string;
  invalidReason?: AgendaConstraintInvalidReason;
}

export function extractAgendaRequestConstraints(
  body: string,
  options: AgendaRequestConstraintOptions = {}
): AgendaRequestConstraints {
  const normalized = normalize(body);
  const rescheduleIntent = hasRescheduleIntent(normalized);
  const bookingIntent = !rescheduleIntent && hasBookingIntent(normalized);
  const requestsChange = hasDimensionChange(normalized);
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;

  if (!Number.isFinite(now.getTime())) {
    return { bookingIntent, rescheduleIntent, requestsChange, invalidReason: "invalid_now" };
  }

  let localNow: LocalDateTimeParts;
  try {
    localNow = localDateTimeParts(now, timeZone);
  } catch {
    return { bookingIntent, rescheduleIntent, requestsChange, invalidReason: "invalid_timezone" };
  }

  const date = resolveDate(normalized, localNow);
  const time = resolveTime(normalized);
  const invalidReason = date.invalidReason ?? time.invalidReason;
  if (
    !invalidReason &&
    date.localDate &&
    time.localTime &&
    isLocalDateTimeAtOrBeforeNow(date.localDate, time.localTime, { now, timeZone })
  ) {
    return { bookingIntent, rescheduleIntent, requestsChange, invalidReason: "past_datetime" };
  }
  return {
    ...(date.localDate ? { localDate: date.localDate } : {}),
    ...(time.localTime ? { localTime: time.localTime } : {}),
    bookingIntent,
    rescheduleIntent,
    requestsChange,
    ...(invalidReason ? { invalidReason } : {})
  };
}

export function isLocalDateTimeAtOrBeforeNow(
  localDate: string,
  localTime: string,
  options: AgendaRequestConstraintOptions = {}
): boolean {
  const [year, month, day] = localDate.split("-").map(Number);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (makeDate(year!, month!, day!) !== localDate || !timeMatch) return true;
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (hour > 23 || minute > 59) return true;
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  if (!Number.isFinite(now.getTime())) return true;
  try {
    const localNow = localDateTimeParts(now, timeZone);
    return `${localDate}T${localTime}` <= `${formatDate(localNow)}T${formatTime(localNow.hour, localNow.minute)}`;
  } catch {
    return true;
  }
}

function resolveDate(value: string, today: LocalDateParts): DateResolution {
  const explicitDates: string[] = [];
  let invalidDate = false;
  let explicitlyPast = false;
  const todayValue = formatDate(today);

  for (const match of value.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const candidate = makeDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (!candidate) invalidDate = true;
    else if (candidate < todayValue) explicitlyPast = true;
    else explicitDates.push(candidate);
  }

  for (const match of value.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const candidate = makeDate(Number(match[3]), Number(match[2]), Number(match[1]));
    if (!candidate) invalidDate = true;
    else if (candidate < todayValue) explicitlyPast = true;
    else explicitDates.push(candidate);
  }

  const monthNames = Object.keys(MONTHS).join("|");
  const namedDatePattern = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${monthNames})(?:\\s+de\\s+(\\d{4}))?\\b`, "g");
  for (const match of value.matchAll(namedDatePattern)) {
    const day = Number(match[1]);
    const month = MONTHS[match[2]!]!;
    const explicitYear = match[3] ? Number(match[3]) : undefined;
    let year = explicitYear ?? today.year;
    let candidate = makeDate(year, month, day);
    if (!candidate) {
      invalidDate = true;
      continue;
    }
    if (explicitYear !== undefined && candidate < todayValue) {
      explicitlyPast = true;
      continue;
    }
    if (explicitYear === undefined && candidate < todayValue) {
      year += 1;
      candidate = makeDate(year, month, day);
    }
    if (!candidate) invalidDate = true;
    else explicitDates.push(candidate);
  }

  if (invalidDate) return { invalidReason: "invalid_date" };
  if (explicitlyPast) return { invalidReason: "past_date" };

  const relativeDates: string[] = [];
  let relativeText = value.replace(/\b(?:en|por|durante)\s+la\s+manana\b/g, " ");
  if (/\bpasado\s+manana\b/.test(relativeText)) {
    relativeDates.push(addDays(today, 2));
    relativeText = relativeText.replace(/\bpasado\s+manana\b/g, " ");
  }
  if (/\bmanana\b/.test(relativeText)) relativeDates.push(addDays(today, 1));
  if (/\bhoy\b/.test(relativeText)) relativeDates.push(todayValue);

  const weekdayValues = [...value.matchAll(/\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/g)].map(
    (match) => WEEKDAYS[match[1]!]!
  );
  const uniqueWeekdays = [...new Set(weekdayValues)];
  if (uniqueWeekdays.length > 1) return { invalidReason: "ambiguous_date" };

  const baseDates = [...new Set([...explicitDates, ...relativeDates])];
  if (baseDates.length > 1) return { invalidReason: "ambiguous_date" };
  if (baseDates.length === 1) {
    const localDate = baseDates[0]!;
    if (uniqueWeekdays.length === 1 && weekdayForDate(localDate) !== uniqueWeekdays[0]) {
      return { invalidReason: "weekday_mismatch" };
    }
    return { localDate };
  }
  if (uniqueWeekdays.length === 1) return { localDate: nextWeekday(today, uniqueWeekdays[0]!) };
  return {};
}

function resolveTime(value: string): TimeResolution {
  const times: string[] = [];
  let invalidTime = false;

  const meridiemPattern = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\s*\.?\s*m\s*\.?/g;
  for (const match of value.matchAll(meridiemPattern)) {
    let hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) {
      invalidTime = true;
      continue;
    }
    if (match[3] === "p" && hour < 12) hour += 12;
    if (match[3] === "a" && hour === 12) hour = 0;
    times.push(formatTime(hour, minute));
  }

  const twentyFourHourPattern = /\b(\d{1,2}):(\d{2})(?!\s*[ap]\s*\.?\s*m\b)/g;
  for (const match of value.matchAll(twentyFourHourPattern)) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) invalidTime = true;
    else times.push(formatTime(hour, minute));
  }

  const timeLikeValues = [...value.matchAll(/\b(\d{1,2}):(\d{2})\b/g)];
  if (timeLikeValues.some((match) => Number(match[1]) > 23 || Number(match[2]) > 59)) invalidTime = true;
  if (/\ba\s+las?\s+\d{1,2}\b(?!\s*:|\s*[ap]\s*\.?\s*m)/.test(value)) {
    return { invalidReason: "ambiguous_time" };
  }
  if (invalidTime) return { invalidReason: "invalid_time" };

  const uniqueTimes = [...new Set(times)];
  if (uniqueTimes.length > 1) return { invalidReason: "ambiguous_time" };
  return uniqueTimes[0] ? { localTime: uniqueTimes[0] } : {};
}

function hasBookingIntent(value: string): boolean {
  return (
    /\b(agend\w*|reserv\w*|separ\w*|program\w*)\b/.test(value) ||
    /\b(quiero|deseo|necesito|busco|solicito)\b.{0,80}\b(cita|turno)\b/.test(value) ||
    /\b(prefiero|elijo|escojo|me sirve)\b.{0,80}\b(horario|turno|\d{1,2}(?::\d{2})?)\b/.test(value)
  );
}

function hasRescheduleIntent(value: string): boolean {
  return (
    /\b(reagend\w*|reprogram\w*)\b/.test(value) ||
    /\b(cambiar|cambio|mover|muevo)\b.{0,40}\b(cita|turno|fecha|hora)\b/.test(value)
  );
}

function hasDimensionChange(value: string): boolean {
  const dimension = "(?:sede|convenio|profesional|doctor|doctora|optometra|oftalmologo|tipo(?:\\s+de\\s+cita)?)";
  return (
    new RegExp(`\\b(?:otra|otro|diferente|nueva|nuevo)\\s+${dimension}\\b`).test(value) ||
    new RegExp(`\\b${dimension}\\s+(?:diferente|distinta|distinto|nueva|nuevo)\\b`).test(value) ||
    new RegExp(`\\b(?:cambiar|cambio)\\s+(?:de|el|la)?\\s*${dimension}\\b`).test(value)
  );
}

function localDateTimeParts(now: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const result = {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute")
  };
  if (!makeDate(result.year, result.month, result.day)) throw new Error("Invalid local date");
  if (!Number.isInteger(result.hour) || result.hour < 0 || result.hour > 23) throw new Error("Invalid local hour");
  if (!Number.isInteger(result.minute) || result.minute < 0 || result.minute > 59) {
    throw new Error("Invalid local minute");
  }
  return result;
}

function makeDate(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return formatDate({ year, month, day });
}

function addDays(date: LocalDateParts, days: number): string {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days, 12));
  return formatDate({ year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() });
}

function nextWeekday(today: LocalDateParts, requestedWeekday: number): string {
  const current = weekdayForDate(formatDate(today));
  const delta = (requestedWeekday - current + 7) % 7;
  return addDays(today, delta);
}

function weekdayForDate(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, 12)).getUTCDay();
}

function formatDate(date: LocalDateParts): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

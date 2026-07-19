export const GREEN = "#2f9e6e";
export const GREEN_SOFT = "#8fd3b6";
export const AMBER = "#d99a2b";
export const RED = "#d1584f";
export const INK_2 = "#5c6b64";
export const LINE = "#e3e9e6";

const timeFmt = new Intl.DateTimeFormat("es-CO", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
  timeZone: "America/Bogota"
});

const dateFmt = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
  timeZone: "America/Bogota"
});

const weekdayFmt = new Intl.DateTimeFormat("es-CO", {
  weekday: "short",
  day: "2-digit",
  timeZone: "America/Bogota"
});

export function formatTime(value?: string | null): string {
  if (!value) return "";
  return timeFmt.format(new Date(value));
}

export function formatDate(value?: string | null): string {
  if (!value) return "";
  return dateFmt.format(new Date(value));
}

export function formatWeekday(value: string | Date): string {
  return weekdayFmt.format(typeof value === "string" ? new Date(value) : value);
}

export function formatCop(value?: number | null): string {
  if (value == null) return "-";
  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
}

export function formatNumber(value?: number | null): string {
  if (value == null) return "-";
  return new Intl.NumberFormat("es-CO").format(value);
}

export function relativeWait(seconds?: number | null): string {
  if (seconds == null) return "";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function trendLabel(today: number, yesterday: number): { value: string; up: boolean } | undefined {
  if (!yesterday) return undefined;
  const delta = Math.round((100 * (today - yesterday)) / yesterday);
  if (delta === 0) return undefined;
  return { value: `${delta > 0 ? "+" : ""}${delta}% vs ayer`, up: delta > 0 };
}

const HOUR_LABELS: Record<number, string> = {};
for (let h = 0; h <= 23; h += 1) {
  const suffix = h < 12 ? "a. m." : "p. m.";
  const base = h % 12 === 0 ? 12 : h % 12;
  HOUR_LABELS[h] = `${base}:00 ${suffix}`;
}

export function hourLabel(hour: number): string {
  return HOUR_LABELS[hour] ?? `${hour}:00`;
}

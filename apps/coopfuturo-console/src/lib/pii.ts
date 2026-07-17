/** Client-side PII helpers (API also masks when ui.pii_masking=true). */

export function maskPhone(value: string | null | undefined): string {
  if (!value) return "";
  const s = String(value).trim();
  if (s.length <= 4) return "****";
  return `${s.slice(0, 3)}******${s.slice(-2)}`;
}

export function maskDocument(value: string | null | undefined): string {
  if (!value) return "";
  const s = String(value).trim();
  if (s === "-" || s === "—") return s;
  if (s.length <= 4) return "****";
  return `${"*".repeat(Math.max(4, s.length - 4))}${s.slice(-4)}`;
}

export function maskName(value: string | null | undefined): string {
  if (!value) return "";
  const parts = String(value).trim().split(/\s+/);
  if (!parts.length) return "";
  if (parts.length === 1) {
    const p = parts[0];
    return p.length > 1 ? `${p[0]}***` : "***";
  }
  return `${parts[0]} ${parts.slice(1).map((p) => `${p[0]}.`).join(" ")}`;
}

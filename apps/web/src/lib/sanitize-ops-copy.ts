/** Strip provider / infra jargon from operator-facing copy. */

const REPLACEMENTS: [RegExp, string][] = [
  [/elevenlabs_sip_trunk/gi, "voz"],
  [/elevenlabs_sip/gi, "voz"],
  [/live_dialer/gi, "voz"],
  [/whatsapp_liwa/gi, "whatsapp"],
  [/whatsapp_mock/gi, "whatsapp"],
  [/liwa_mock/gi, "whatsapp"],
  [/\bLIWA\b/gi, "WhatsApp"],
  [/\bliwa\b/g, "whatsapp"],
  [/pilot-core/gi, "API"],
  [/queued_mock/gi, "en cola"],
  [/\bmock_commercial\b/gi, "demo"],
];

export function sanitizeOpsCopy(input: string): string {
  let out = input;
  for (const [re, to] of REPLACEMENTS) {
    out = out.replace(re, to);
  }
  // Collapse leftover mode noise like "Llamada outbound (voz) · sent"
  out = out.replace(/Llamada outbound\s*\([^)]*\)\s*·\s*sent/gi, "Llamada de voz enviada");
  out = out.replace(/Llamada outbound\s*\([^)]*\)\s*·\s*en cola/gi, "Llamada de voz en cola");
  out = out.replace(/Llamada outbound\s*\([^)]*\)\s*·\s*failed/gi, "Llamada de voz fallida");
  out = out.replace(/\s*·\s*sent\b/gi, " · enviada");
  out = out.replace(/\s*·\s*failed\b/gi, " · fallida");
  return out;
}

export function sanitizeTags(tags: string[] | undefined): string[] {
  return (tags ?? [])
    .map((t) => sanitizeOpsCopy(t))
    .filter((t) => {
      const low = t.toLowerCase();
      return low !== "laboratorio" && low !== "liwa" && !low.includes("elevenlabs");
    });
}

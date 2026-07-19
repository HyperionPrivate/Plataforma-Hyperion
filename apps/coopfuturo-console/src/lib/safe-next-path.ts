const DEFAULT_NEXT_PATH = "/dashboard";
const VALIDATION_ORIGIN = "https://coopfuturo.invalid";
const MAX_DECODE_PASSES = 8;

function hasUnsafeAuthoritySeparator(value: string): boolean {
  let decoded = value;

  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    if (decoded.includes("\\") || decoded.startsWith("//")) return true;

    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      // A malformed escape in the supplied value is not a safe redirect target.
      // An escape such as %25 may legitimately decode to a literal percent sign,
      // so a later failed pass does not invalidate the original URL.
      return pass === 0;
    }

    if (next === decoded) return false;
    decoded = next;
  }

  // Excessive nested encoding is ambiguous and unnecessary for an app route.
  return true;
}

export function safeNextPath(value: string | null | undefined): string {
  if (!value?.startsWith("/") || hasUnsafeAuthoritySeparator(value)) {
    return DEFAULT_NEXT_PATH;
  }

  try {
    const parsed = new URL(value, VALIDATION_ORIGIN);
    if (parsed.origin !== VALIDATION_ORIGIN) return DEFAULT_NEXT_PATH;
  } catch {
    return DEFAULT_NEXT_PATH;
  }

  return value;
}

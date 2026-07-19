import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function walk(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const target = join(path, entry);
    return statSync(target).isDirectory() ? walk(target) : /\.(css|ts|tsx)$/.test(entry) ? [target] : [];
  });
}

describe("PULSO source boundary", () => {
  it("contains no routes, endpoints or styles from another product", () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const content = walk(root)
      .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(content).not.toMatch(/\/nova\b|\/lumen\b|brand-coopfuturo|VITE_PRODUCT|VITE_BRAND_LABEL/i);
  });
  it("does not persist or attach a browser bearer", () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const content = walk(root)
      .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(content).not.toMatch(/localStorage|sessionStorage|authorization\s*[:=]|Bearer\s+/i);
  });
});

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function sources(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const target = join(path, name);
    return statSync(target).isDirectory() ? sources(target) : /\.(css|ts|tsx)$/.test(name) ? [target] : [];
  });
}

describe("platform admin isolation", () => {
  it("does not contain product routes or API namespaces", () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const content = sources(root)
      .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(content).not.toMatch(/\/nova\b|\/lumen\b|pulso-iris|brand-coopfuturo/i);
    expect(content).not.toMatch(/localStorage|sessionStorage|Bearer\s+/i);
  });
});

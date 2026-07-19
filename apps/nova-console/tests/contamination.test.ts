import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : statSync(path).isFile() ? [path] : [];
  });
}

function sourceText(): string {
  return sourceFiles(sourceRoot)
    .filter((path) => /\.(?:css|ts|tsx)$/.test(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

describe("NOVA frontend closure", () => {
  it("contains no foreign product, customer brand or multiproduct build markers", () => {
    const source = sourceText();
    const forbidden = [
      /\bpulso\b/i,
      /\blumen\b/i,
      /\bsof[ií]a\b/i,
      /coop\w*/i,
      /\bcedco\b/i,
      /brand-coopfuturo/i,
      /vite_product/i,
      /\/pulso-iris\//i,
      /\/lumen\//i
    ];

    for (const pattern of forbidden) expect(source, `found ${pattern}`).not.toMatch(pattern);
  });

  it("does not expose bearer credentials or browser token storage", () => {
    const source = sourceText();
    expect(source).not.toMatch(/localStorage|sessionStorage/);
    expect(source).not.toMatch(/authorization\s*[:=]/i);
    expect(source).not.toMatch(/Bearer\s+/i);
    expect(source).toContain('credentials: "include"');
  });

  it("does not import the legacy console or global contracts catalog", () => {
    const source = sourceText();
    expect(source).not.toMatch(/apps[\\/]web-console|@hyperion\/contracts/);
  });
});

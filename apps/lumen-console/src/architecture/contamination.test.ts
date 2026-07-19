import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const productionExtensions = new Set([".ts", ".tsx", ".css"]);

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    if (!productionExtensions.has(extname(entry.name)) || entry.name.includes(".test.")) return [];
    return [path];
  });
}

describe("LUMEN frontend boundary", () => {
  const files = productionFiles(sourceRoot);
  const corpus = files
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
    .toLowerCase();

  it("does not contain routes, branding or build switches owned by another product", () => {
    const forbidden = [
      "pul" + "so",
      "no" + "va",
      "coop" + "futuro",
      "vite_" + "product",
      "brand-" + "coopfuturo",
      "/oper" + "acion",
      "/camp" + "anas",
      "/config" + "uracion"
    ];
    for (const fragment of forbidden) expect(corpus, fragment).not.toContain(fragment);
  });

  it("does not import source files from the former shared console", () => {
    expect(corpus).not.toContain("web-" + "console");
  });

  it("uses a same-origin cookie session and never browser token storage", () => {
    const apiSource = readFileSync(join(sourceRoot, "lib", "api.ts"), "utf8");
    expect(apiSource).toContain('credentials: "include"');
    expect(apiSource).toContain('headers["x-csrf-token"]');
    expect(corpus).not.toContain("local" + "storage");
    expect(corpus).not.toContain("session" + "storage");
    expect(corpus).not.toContain("bear" + "er");
  });

  it("keeps a real catch-all 404", () => {
    const appSource = readFileSync(join(sourceRoot, "app.tsx"), "utf8");
    expect(appSource).toContain('<Route path="*" element={<NotFound />} />');
  });

  it("targets the dedicated LUMEN BFF during local development", () => {
    const viteConfig = readFileSync(join(sourceRoot, "..", "vite.config.ts"), "utf8");
    expect(viteConfig).toContain('"http://127.0.0.1:8096"');
    expect(viteConfig).not.toContain('"http://127.0.0.1:8082"');
  });
});

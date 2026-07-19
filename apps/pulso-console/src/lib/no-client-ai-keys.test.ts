import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const forbidden = [
  /OPENAI_API_KEY/,
  /DEEPSEEK_API_KEY/,
  /VITE_[A-Z0-9_]*(?:KEY|SECRET|TOKEN)/,
  /api\.openai\.com/,
  /api\.deepseek\.com/,
  /Bearer\s+sk-[A-Za-z0-9_-]+/
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (![".ts", ".tsx", ".js", ".jsx", ".css", ".html"].includes(extname(entry.name))) return [];
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) return [];
    return [path];
  });
}

describe("web-console secret boundary", () => {
  it("contains no AI credentials or direct provider endpoints", () => {
    const violations = sourceFiles(sourceRoot).flatMap((path) => {
      const content = readFileSync(path, "utf8");
      return forbidden.filter((pattern) => pattern.test(content)).map((pattern) => `${path}: ${pattern.source}`);
    });
    expect(violations).toEqual([]);
  });
});

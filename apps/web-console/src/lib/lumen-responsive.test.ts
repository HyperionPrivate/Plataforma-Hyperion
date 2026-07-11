import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const mobile = styles.slice(styles.indexOf("@media (max-width: 760px)"));

describe("LUMEN responsive CSS contract", () => {
  it("uses one-column clinical layouts on the phone breakpoint", () => {
    expect(mobile).toMatch(/\.lumen-pre-layout,[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
    expect(mobile).toContain(".lumen-dictation-layout");
    expect(mobile).toContain(".lumen-record-layout");
  });

  it("keeps the three in-scope views reachable without covering content", () => {
    expect(mobile).toMatch(/\.lumen-product-nav[\s\S]*?position: fixed/);
    expect(mobile).toMatch(/grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    expect(mobile).toMatch(/\.lumen-shell-host \.content[\s\S]*?padding: 12px 12px 156px/);
  });

  it("clips page-level horizontal spill while preserving intentional scroll regions", () => {
    expect(mobile).toMatch(/\.lumen-shell-host \.content[\s\S]*?overflow-x: clip/);
    expect(styles).toMatch(/\.lumen-agenda-list[\s\S]*?overflow-x: auto/);
  });
});

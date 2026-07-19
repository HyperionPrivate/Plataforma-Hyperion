import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";

describe("NOVA application routing", () => {
  it("renders a real not-found view for every non-root route before authentication", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/foreign-product"]}>
        <App />
      </MemoryRouter>
    );

    expect(html).toContain("404");
    expect(html).toContain("Ruta no encontrada");
    expect(html).not.toContain("Ingresar");
  });
});

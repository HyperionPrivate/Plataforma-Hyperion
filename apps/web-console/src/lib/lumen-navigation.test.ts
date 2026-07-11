import { describe, expect, it } from "vitest";
import {
  LUMEN_VIEWS,
  lumenViewHref,
  normalizeLumenHref,
  normalizeLumenPath,
  resolveLumenLocation
} from "./lumen-navigation.js";

describe("LUMEN navigation", () => {
  it("expone solo las tres vistas del corte", () => {
    expect(LUMEN_VIEWS.map((view) => view.id)).toEqual(["preconsulta", "dictado", "historia"]);
    expect(LUMEN_VIEWS.map((view) => view.path)).toEqual(["/lumen/preconsulta", "/lumen/dictado", "/lumen/historia"]);
    expect(LUMEN_VIEWS.map((view) => view.icon)).toEqual(["clipboard-pulse", "mic", "file-check-2"]);
  });

  it("normaliza la raiz de LUMEN a preconsulta", () => {
    expect(normalizeLumenPath("/lumen")).toBe("/lumen/preconsulta");
    expect(normalizeLumenPath("/lumen/")).toBe("/lumen/preconsulta");
    expect(normalizeLumenHref("/lumen?encounter=enc-42")).toBe("/lumen/preconsulta?encounter=enc-42");
  });

  it("rechaza rutas ajenas y modulos fuera del corte", () => {
    expect(normalizeLumenPath("/agenda")).toBeNull();
    expect(normalizeLumenPath("/lumen/laboratorios")).toBeNull();
    expect(normalizeLumenPath("/lumen/asistente")).toBeNull();
    expect(resolveLumenLocation("/lumen/facturacion-rips?encounter=enc-42")).toBeNull();
  });

  it("preserva solo encounter al cambiar de vista", () => {
    expect(
      lumenViewHref("dictado", {
        pathname: "/lumen/preconsulta",
        search: "?encounter=enc%2F42&token=no-debe-viajar"
      })
    ).toBe("/lumen/dictado?encounter=enc%2F42");
    expect(lumenViewHref("historia", "/lumen/dictado?encounter=enc-99#captura")).toBe(
      "/lumen/historia?encounter=enc-99"
    );
  });

  it("resuelve vista, encuentro y necesidad de redireccion", () => {
    expect(resolveLumenLocation("/lumen?encounter=enc-7")).toMatchObject({
      viewId: "preconsulta",
      pathname: "/lumen/preconsulta",
      href: "/lumen/preconsulta?encounter=enc-7",
      encounterId: "enc-7",
      redirected: true
    });
    expect(resolveLumenLocation("/lumen/historia?encounter=enc-7")).toMatchObject({
      viewId: "historia",
      href: "/lumen/historia?encounter=enc-7",
      encounterId: "enc-7",
      redirected: false
    });
  });
});

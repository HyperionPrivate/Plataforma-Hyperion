import { describe, expect, it } from "vitest";
import {
  LUMEN_DEMO_VIEW_IDS,
  LUMEN_VIEWS,
  filterLumenNavViews,
  isLumenRoute,
  lumenViewHref,
  normalizeLumenHref,
  normalizeLumenPath,
  resolveLumenLocation,
  shouldHideLumenDemoViewsFromNav
} from "./lumen-navigation.js";

describe("LUMEN navigation", () => {
  it("expone las nueve experiencias definidas para la demo integral", () => {
    expect(LUMEN_VIEWS.map((view) => view.id)).toEqual([
      "preconsulta",
      "dictado",
      "historia",
      "laboratorios",
      "asistente",
      "modelos",
      "consentimientos",
      "facturacion",
      "dashboard"
    ]);
    expect(LUMEN_VIEWS.filter((view) => view.mobilePrimary).map((view) => view.id)).toEqual([
      "preconsulta",
      "dictado",
      "historia"
    ]);
    expect(LUMEN_VIEWS.filter((view) => view.requiresEncounter).map((view) => view.id)).toEqual([
      "preconsulta",
      "dictado",
      "historia",
      "asistente",
      "consentimientos"
    ]);
  });

  it("marca las vistas guiadas como demo y deja operables las clínicas", () => {
    expect(LUMEN_VIEWS.filter((view) => view.isDemo).map((view) => view.id)).toEqual([...LUMEN_DEMO_VIEW_IDS]);
    expect(LUMEN_VIEWS.filter((view) => !view.isDemo).map((view) => view.id)).toEqual([
      "preconsulta",
      "dictado",
      "historia"
    ]);
  });

  it("oculta vistas demo del nav en staging, production o build Vite production", () => {
    expect(shouldHideLumenDemoViewsFromNav({ MODE: "development", VITE_HYPERION_ENVIRONMENT: "staging" })).toBe(true);
    expect(shouldHideLumenDemoViewsFromNav({ MODE: "development", VITE_HYPERION_ENVIRONMENT: "production" })).toBe(
      true
    );
    expect(shouldHideLumenDemoViewsFromNav({ MODE: "production", VITE_HYPERION_ENVIRONMENT: "local" })).toBe(true);
    expect(shouldHideLumenDemoViewsFromNav({ MODE: "development", VITE_HYPERION_ENVIRONMENT: "local" })).toBe(false);
    expect(shouldHideLumenDemoViewsFromNav({ MODE: "development" })).toBe(false);
  });

  it("no expone ids demo en nav cuando VITE_HYPERION_ENVIRONMENT=staging", () => {
    const navViews = filterLumenNavViews(LUMEN_VIEWS, {
      hideDemoViews: shouldHideLumenDemoViewsFromNav({
        MODE: "development",
        VITE_HYPERION_ENVIRONMENT: "staging"
      })
    });
    const navIds = navViews.map((view) => view.id);
    for (const demoId of LUMEN_DEMO_VIEW_IDS) {
      expect(navIds).not.toContain(demoId);
    }
    expect(navIds).toEqual(["preconsulta", "dictado", "historia"]);
  });

  it("conserva vistas demo en nav local no restringido", () => {
    const navViews = filterLumenNavViews(LUMEN_VIEWS, {
      hideDemoViews: shouldHideLumenDemoViewsFromNav({ MODE: "development", VITE_HYPERION_ENVIRONMENT: "local" })
    });
    expect(navViews.map((view) => view.id)).toEqual(LUMEN_VIEWS.map((view) => view.id));
  });

  it("normaliza la raiz de LUMEN a preconsulta", () => {
    expect(normalizeLumenPath("/lumen")).toBe("/lumen/preconsulta");
    expect(normalizeLumenPath("/lumen/")).toBe("/lumen/preconsulta");
    expect(normalizeLumenHref("/lumen?encounter=enc-42")).toBe("/lumen/preconsulta?encounter=enc-42");
  });

  it("acepta los modulos documentados y rechaza rutas ajenas", () => {
    expect(isLumenRoute("/")).toBe(true);
    expect(isLumenRoute("/lumen/dashboard")).toBe(true);
    expect(isLumenRoute("/otro-producto")).toBe(false);
    expect(normalizeLumenPath("/otro-producto")).toBeNull();
    expect(normalizeLumenPath("/lumen/laboratorios")).toBe("/lumen/laboratorios");
    expect(normalizeLumenPath("/lumen/asistente")).toBe("/lumen/asistente");
    expect(normalizeLumenPath("/lumen/dashboard")).toBe("/lumen/dashboard");
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

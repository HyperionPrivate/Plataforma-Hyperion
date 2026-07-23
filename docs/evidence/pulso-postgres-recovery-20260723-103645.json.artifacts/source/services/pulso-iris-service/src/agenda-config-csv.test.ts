import { describe, expect, it } from "vitest";
import {
  AgendaCsvError,
  agendaImportTemplate,
  parseAgendaImportResource,
  previewAgendaImport
} from "./agenda-config-csv.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";

describe("agenda configuration CSV", () => {
  it("publishes empty templates without synthetic records", () => {
    const template = agendaImportTemplate("professionals");

    expect(template.filename).toBe("pulso-iris-professionals-template.csv");
    expect(template.csv).toBe("name,professional_type,subspecialty,status\r\n");
  });

  it("recognizes only supported URL resources", () => {
    expect(parseAgendaImportResource("availability-rules")).toBe("availability-rules");
    expect(parseAgendaImportResource("availability_rules")).toBeUndefined();
  });

  it("parses quoted cells and reports invalid rows without rejecting valid rows", async () => {
    const preview = await previewAgendaImport(
      emptyDatabase(),
      TENANT_ID,
      "professionals",
      [
        "name,professional_type,subspecialty,status",
        '"Apellido, Nombre",ophthalmologist,Retina,active',
        "Profesional invalido,dentist,,active",
        '"Apellido, Nombre",ophthalmologist,Retina,active'
      ].join("\n")
    );

    expect(preview.summary).toEqual({ total: 3, accepted: 1, rejected: 2 });
    expect(preview.accepted[0]?.data.name).toBe("Apellido, Nombre");
    expect(preview.rejected[0]?.reason).toContain("professional_type");
    expect(preview.rejected[1]?.reason).toContain("duplicada");
  });

  it("rejects unknown headers before processing rows", async () => {
    await expect(
      previewAgendaImport(
        emptyDatabase(),
        TENANT_ID,
        "professionals",
        "name,professional_type,subspecialty,unknown\nNombre,optometrist,,active"
      )
    ).rejects.toBeInstanceOf(AgendaCsvError);
  });
});

function emptyDatabase(): Parameters<typeof previewAgendaImport>[0] {
  return {
    query: async () => ({ rows: [], command: "SELECT", rowCount: 0, oid: 0, fields: [] })
  } as Parameters<typeof previewAgendaImport>[0];
}

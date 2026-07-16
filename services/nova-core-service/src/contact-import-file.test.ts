import { describe, expect, it } from "vitest";
import { extractMultipartFile, parseContactsCsv } from "./contact-import-file.js";

describe("parseContactsCsv", () => {
  it("maps pilot columns and normalizes phones", () => {
    const csv = [
      "Celular,Nombres,Ciudad,documento,cupo,mora,saldo,universidad,segment",
      "3001234567,Ana Perez,Bucaramanga,123,si,1000,50000,UIS,Renovacion",
      "bad,No Phone,Barranquilla,,,,,,",
      ",Empty,,,,,,,"
    ].join("\n");

    const result = parseContactsCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      phone_e164: "+573001234567",
      full_name: "Ana Perez",
      agency_code: "BGA",
      ciudad: "Bucaramanga",
      documento: "123",
      cupo_preaprobado: true,
      mora_actual: 1000,
      saldo_total: 50000,
      universidad: "UIS",
      segment: "Renovacion"
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 3, reason: "phone_not_e164" }),
        expect.objectContaining({ row: 4, reason: "phone_required" })
      ])
    );
  });
});

describe("extractMultipartFile", () => {
  it("extracts the file part from multipart body", () => {
    const boundary = "----HyperionBoundary";
    const body = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="contacts.csv"',
        "Content-Type: text/csv",
        "",
        "phone,name\n3001112233,Test",
        `--${boundary}--`,
        ""
      ].join("\r\n")
    );

    const extracted = extractMultipartFile(`multipart/form-data; boundary=${boundary}`, body);
    expect("error" in extracted).toBe(false);
    if ("error" in extracted) return;
    expect(extracted.filename).toBe("contacts.csv");
    expect(extracted.content.toString("utf8")).toContain("3001112233");
  });
});

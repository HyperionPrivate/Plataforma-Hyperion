import { describe, expect, it } from "vitest";
import { extractAgendaRequestConstraints } from "./availability-request-constraints.js";

const NOW = new Date("2026-07-10T03:27:00.000Z");
const options = { now: NOW, timeZone: "America/Bogota" };

describe("extractAgendaRequestConstraints", () => {
  it("uses the tenant local day instead of the UTC day", () => {
    expect(extractAgendaRequestConstraints("Quiero una cita manana a las 9:00 a. m.", options)).toMatchObject({
      localDate: "2026-07-10",
      localTime: "09:00",
      bookingIntent: true,
      rescheduleIntent: false
    });
  });

  it.each([
    ["Quiero cita el 2026-07-13 a las 09:00", "2026-07-13", "09:00"],
    ["Quiero cita el 13/07/2026 a las 9 a.m.", "2026-07-13", "09:00"],
    ["Quiero la cita del lunes 13 de julio a las 9:00 a. m.", "2026-07-13", "09:00"],
    ["Quiero cita el 13 de julio de 2026 a las 2:20 p. m.", "2026-07-13", "14:20"]
  ])("extracts explicit date and clock from %s", (body, localDate, localTime) => {
    expect(extractAgendaRequestConstraints(body, options)).toMatchObject({
      localDate,
      localTime,
      bookingIntent: true
    });
  });

  it("resolves pasado manana and does not confuse en la manana with tomorrow", () => {
    expect(extractAgendaRequestConstraints("Busco cita pasado manana en la manana", options)).toMatchObject({
      localDate: "2026-07-11",
      bookingIntent: true
    });
    expect(extractAgendaRequestConstraints("Busco cita en la manana", options)).toEqual({
      bookingIntent: true,
      rescheduleIntent: false,
      requestsChange: false
    });
  });

  it("resolves a weekday from the local date", () => {
    expect(extractAgendaRequestConstraints("Quiero una cita el lunes a las 14:00", options)).toMatchObject({
      localDate: "2026-07-13",
      localTime: "14:00"
    });
  });

  it("accepts a future local time today and rejects the same minute or an earlier time", () => {
    expect(extractAgendaRequestConstraints("Quiero cita hoy a las 10:40 p. m.", options)).toMatchObject({
      localDate: "2026-07-09",
      localTime: "22:40"
    });

    for (const body of ["Quiero cita hoy a las 10:27 p. m.", "Quiero cita hoy a las 10:20 p. m."]) {
      const result = extractAgendaRequestConstraints(body, options);
      expect(result.invalidReason).toBe("past_datetime");
      expect(result.localDate).toBeUndefined();
      expect(result.localTime).toBeUndefined();
    }
  });

  it("compares today in the supplied IANA timezone", () => {
    const tokyo = { now: NOW, timeZone: "Asia/Tokyo" };
    expect(extractAgendaRequestConstraints("Quiero cita hoy a las 12:20", tokyo).invalidReason).toBe("past_datetime");
    expect(extractAgendaRequestConstraints("Quiero cita hoy a las 12:40", tokyo)).toMatchObject({
      localDate: "2026-07-10",
      localTime: "12:40"
    });
  });

  it("does not reject an earlier clock on a future local date", () => {
    expect(extractAgendaRequestConstraints("Quiero cita manana a las 8:00 a. m.", options)).toMatchObject({
      localDate: "2026-07-10",
      localTime: "08:00"
    });
  });

  it("rejects a weekday that conflicts with an explicit calendar date", () => {
    const result = extractAgendaRequestConstraints("Quiero cita el martes 13 de julio de 2026 a las 9 a. m.", options);
    expect(result.invalidReason).toBe("weekday_mismatch");
    expect(result.localDate).toBeUndefined();
  });

  it.each([
    ["Quiero cita el 31 de febrero de 2026", "invalid_date"],
    ["Quiero cita el 8 de julio de 2026", "past_date"],
    ["Quiero cita hoy o manana", "ambiguous_date"],
    ["Quiero cita lunes o martes", "ambiguous_date"],
    ["Quiero cita a las 9", "ambiguous_time"],
    ["Quiero cita a las 25:00", "invalid_time"],
    ["Quiero cita a las 9:00 o a las 10:00", "ambiguous_time"]
  ])("does not invent a constraint for %s", (body, invalidReason) => {
    expect(extractAgendaRequestConstraints(body, options).invalidReason).toBe(invalidReason);
  });

  it("infers the next year only when a named date omits its year", () => {
    expect(extractAgendaRequestConstraints("Quiero cita el 8 de julio", options).localDate).toBe("2027-07-08");
  });

  it("distinguishes booking from rescheduling", () => {
    expect(extractAgendaRequestConstraints("Quiero reservar una cita", options)).toMatchObject({
      bookingIntent: true,
      rescheduleIntent: false
    });
    expect(extractAgendaRequestConstraints("Quiero reagendar mi cita para el lunes", options)).toMatchObject({
      bookingIntent: false,
      rescheduleIntent: true
    });
  });

  it.each(["otra sede", "otro convenio", "otro profesional", "otro tipo de cita", "cambiar de sede"])(
    "detects a requested dimension change: %s",
    (phrase) => {
      expect(extractAgendaRequestConstraints(`Quiero ${phrase}`, options).requestsChange).toBe(true);
    }
  );

  it("rejects an invalid clock or timezone deterministically", () => {
    expect(extractAgendaRequestConstraints("Quiero cita", { now: new Date("invalid") }).invalidReason).toBe(
      "invalid_now"
    );
    expect(extractAgendaRequestConstraints("Quiero cita", { now: NOW, timeZone: "Invalid/Zone" }).invalidReason).toBe(
      "invalid_timezone"
    );
  });
});

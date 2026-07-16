import { useMemo, useState } from "react";
import { Card, CardHead } from "../../components/ui.js";
import type { ImportedContact } from "./types.js";

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0]!.split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = (cols[index] ?? "").trim();
    });
    return row;
  });
  return { headers, rows };
}

function guessMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const header of headers) {
    const low = header.toLowerCase();
    if (/(phone|tel|celular|movil|móvil)/.test(low)) map[header] = "phone_e164";
    else if (/(nombre|name|first)/.test(low)) map[header] = "full_name";
    else if (/(agencia|agency|sede|codigo)/.test(low)) map[header] = "agency_code";
    else map[header] = "ignore";
  }
  return map;
}

export function NovaImportTab({
  canWriteOps,
  onImportJson,
  onImportFile
}: {
  canWriteOps: boolean;
  onImportJson: (contacts: Array<{ phone_e164: string; full_name?: string; agency_code?: string }>) => Promise<ImportedContact[]>;
  onImportFile?: (file: File) => Promise<ImportedContact[] | null>;
}) {
  const [mode, setMode] = useState<"lines" | "csv">("lines");
  const [importText, setImportText] = useState("+573001112233,Barranquilla,BAQ\n");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [lastImported, setLastImported] = useState<ImportedContact[]>([]);
  const [notice, setNotice] = useState<string>();

  const mappedRows = useMemo(() => {
    return rawRows.map((row) => {
      const out: Record<string, string> = {};
      for (const [col, target] of Object.entries(mapping)) {
        if (target === "ignore") continue;
        out[target] = row[col] ?? "";
      }
      return out;
    });
  }, [mapping, rawRows]);

  async function onFile(file: File | null) {
    if (!file) return;
    setFileName(file.name);
    setNotice(undefined);

    if (onImportFile) {
      setBusy(true);
      try {
        const viaFile = await onImportFile(file);
        if (viaFile) {
          setLastImported(viaFile);
          setNotice(`Importados ${viaFile.length} contactos vía import/file.`);
          return;
        }
      } catch {
        // fallback CSV→JSON below
      } finally {
        setBusy(false);
      }
    }

    const text = await file.text();
    const parsed = parseCsv(text);
    setHeaders(parsed.headers);
    setRawRows(parsed.rows);
    setMapping(guessMap(parsed.headers));
    setMode("csv");
    setNotice(`Archivo cargado: ${parsed.rows.length} filas (se enviará como JSON).`);
  }

  async function importLines() {
    if (!canWriteOps) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const contacts = importText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [phone_e164, full_name, agency_code] = line.split(",").map((part) => part.trim());
          return { phone_e164: phone_e164!, full_name, agency_code };
        });
      const imported = await onImportJson(contacts);
      setLastImported(imported);
      setNotice(`Importados ${imported.length} contactos.`);
    } finally {
      setBusy(false);
    }
  }

  async function importMappedCsv() {
    if (!canWriteOps || mappedRows.length === 0) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const contacts = mappedRows
        .map((row) => ({
          phone_e164: row.phone_e164 ?? "",
          full_name: row.full_name || undefined,
          agency_code: row.agency_code || undefined
        }))
        .filter((row) => row.phone_e164);
      const imported = await onImportJson(contacts);
      setLastImported(imported);
      setNotice(`Importados ${imported.length} contactos desde CSV.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className={`chip${mode === "lines" ? " active" : ""}`} onClick={() => setMode("lines")}>
          Texto / JSON lines
        </button>
        <button type="button" className={`chip${mode === "csv" ? " active" : ""}`} onClick={() => setMode("csv")}>
          CSV
        </button>
      </div>

      {mode === "lines" ? (
        <Card>
          <CardHead title="Importar contactos E.164" />
          <p className="muted tiny">Formato: telefono,nombre,codigo_agencia (una línea por contacto).</p>
          <textarea className="input" rows={8} value={importText} onChange={(e) => setImportText(e.target.value)} />
          <button className="btn btn-primary" type="button" disabled={!canWriteOps || busy} onClick={() => void importLines()}>
            Importar JSON
          </button>
        </Card>
      ) : (
        <Card>
          <CardHead title="Importar CSV" />
          <p className="muted tiny">
            Intenta `import/file` si existe; si no, mapea columnas y envía a `contacts/import`.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
          />
          {fileName ? <p className="tiny muted">Archivo: {fileName}</p> : null}
          {headers.length > 0 ? (
            <div className="col" style={{ gap: 8, marginTop: 12 }}>
              {headers.map((header) => (
                <label key={header} className="row" style={{ gap: 8, alignItems: "center" }}>
                  <span style={{ minWidth: 120 }}>{header}</span>
                  <select
                    className="input"
                    value={mapping[header] ?? "ignore"}
                    onChange={(e) => setMapping((prev) => ({ ...prev, [header]: e.target.value }))}
                  >
                    <option value="phone_e164">Teléfono</option>
                    <option value="full_name">Nombre</option>
                    <option value="agency_code">Agencia</option>
                    <option value="ignore">Ignorar</option>
                  </select>
                </label>
              ))}
              <button
                className="btn btn-primary"
                type="button"
                disabled={!canWriteOps || busy || mappedRows.length === 0}
                onClick={() => void importMappedCsv()}
              >
                Importar {mappedRows.length} filas
              </button>
            </div>
          ) : null}
        </Card>
      )}

      {notice ? (
        <Card>
          <CardHead title="Estado" />
          <p>{notice}</p>
          {lastImported.length > 0 ? (
            <ul className="muted tiny">
              {lastImported.slice(0, 8).map((row) => (
                <li key={row.contact_id}>
                  {row.phone_e164} · {row.contact_id.slice(0, 8)} {row.created ? "(nuevo)" : "(actualizado)"}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

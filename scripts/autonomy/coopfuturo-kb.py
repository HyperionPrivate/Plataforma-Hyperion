#!/usr/bin/env python3
"""Genera y sube UN documento de base de conocimiento (RAG) de Coopfuturo/Crediestudio a ElevenLabs.

Uso (en el servidor, con .env que tenga ELEVENLABS_API_KEY):
  python3 scripts/autonomy/coopfuturo-kb.py --generate                 # solo crea el PDF
  python3 scripts/autonomy/coopfuturo-kb.py --upload --write-env       # crea, sube, indexa RAG y escribe .env
  python3 scripts/autonomy/coopfuturo-kb.py --upload --replace         # borra el KB anterior (por nombre) y sube el nuevo

El documento es un BORRADOR para pruebas. Para usar el oficial: reemplaza el PDF (o sube el oficial)
y actualiza NOVA_KB_DOCUMENT_ID / NOVA_KB_DOCUMENT_NAME en el .env; luego re-corre el bootstrap del agente.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE = "https://api.elevenlabs.io"
DEFAULT_PDF = "/tmp/coopfuturo-crediestudio-kb.pdf"
DOC_NAME = "Coopfuturo Crediestudio KB (BORRADOR - reemplazar por oficial)"


def load_env(path: Path) -> dict:
    out = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"^([A-Za-z0-9_]+)=(.*)$", line)
        if not m:
            continue
        k, v = m.group(1), m.group(2)
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k] = v
    return out


def upsert_env(path: Path, pairs: dict) -> None:
    raw = path.read_text(encoding="utf-8") if path.exists() else ""
    lines = raw.split("\n") if raw else []
    seen = set()
    out = []
    for line in lines:
        m = re.match(r"^([A-Za-z0-9_]+)=(.*)$", line)
        if m and m.group(1) in pairs:
            seen.add(m.group(1))
            out.append(f"{m.group(1)}={pairs[m.group(1)]}")
        else:
            out.append(line)
    for k, v in pairs.items():
        if k not in seen:
            out.append(f"{k}={v}")
    path.write_text(re.sub(r"\n*$", "\n", "\n".join(out)), encoding="utf-8")


def sanitize(text: str) -> str:
    repl = {
        "\u201c": '"', "\u201d": '"', "\u2018": "'", "\u2019": "'",
        "\u2013": "-", "\u2014": "-", "\u2026": "...", "\u2022": "-",
        "\u20ac": "EUR", "\u00a0": " ", "\u2192": "->",
    }
    for a, b in repl.items():
        text = text.replace(a, b)
    return text.encode("latin-1", "replace").decode("latin-1")


# ---------------------------------------------------------------------------
# Contenido KB: .docx oficiales (CONVERSACIONAL COPI + ESQUEMA FUNCIONAL) + web
# coopfuturo.com.co (2026). Sin inventar "cupo preaprobado" (no existe en cartera).
# ---------------------------------------------------------------------------
SECTIONS: list[tuple[str, list[str]]] = [
    ("AVISO (documento borrador)", [
        "Este documento es un BORRADOR de base de conocimiento para el agente de voz Valerie (NOVA / PULSO).",
        "Fuentes: CONVERSACIONAL COPI.docx, ESQUEMA FUNCIONAL CHATBOT.docx y sitio oficial coopfuturo.com.co (2026).",
        "Las tasas, plazos exactos y montos de aprobacion finales NO se fijan aqui: dependen del estudio de credito y los confirma un asesor.",
        "Para produccion: reemplazar este documento por el material oficial definitivo de Coopfuturo (mismo nombre o actualizando NOVA_KB_DOCUMENT_ID).",
    ]),
    ("Sobre Coopfuturo", [
        "Coopfuturo es una cooperativa colombiana de credito educativo y microcredito, vigilada por la Superintendencia de la Economia Solidaria.",
        "Financia pregrado, posgrado, maestrias, doctorados y educacion continua; tambien microcredito productivo.",
        "Financia hasta el 100% del valor de la matricula, sin cuota inicial, proceso 100% virtual y primera cuota a 30 dias (segun condiciones del estudio).",
        "Convenios con mas de 120 instituciones educativas a nivel nacional.",
        "Mas de 160.000 asociados a nivel nacional; 9 agencias fisicas. Sitio: coopfuturo.com.co. Linea nacional: 300 912 7807.",
    ]),
    ("Producto Crediestudio / credito educativo", [
        "Crediestudio es la linea de credito educativo de Coopfuturo (pregrado, posgrado y educacion continua).",
        "Puede financiar cursos o materias especificas de la carrera, programas tecnicos, tecnologicos y especializaciones.",
        "Aplica para Instituciones de Educacion Superior (IES) en Colombia y en el exterior.",
        "La campana de renovacion / continuidad (VIP temporada academica) contacta asociados con credito vigente para renovar o continuar estudios este semestre.",
        "NO se menciona un monto de cupo preaprobado: ese dato no viene en la cartera; el asesor confirma montos exactos tras el estudio.",
    ]),
    ("Beneficios (presentar solo si hay interes)", [
        "Financiamos hasta el 100% de la matricula.",
        "Sin cuota inicial.",
        "Todo el proceso puede ser virtual.",
        "Primera cuota entre 30 dias (segun condiciones).",
        "Acompanamiento personalizado y financiacion parcial si lo desea.",
        "Para asociados: seguro exequial (auxilio hasta 3 SMMLV) y auxilio educativo (hasta 6 SMLMV en modalidad credito).",
    ]),
    ("Renovacion de credito (flujo voz)", [
        "Objetivo: invitar a renovar o continuar el credito educativo este semestre.",
        "Confirmar identidad del titular antes de hablar de saldos o cuotas.",
        "Preguntar si desea renovar; manejar objeciones (cambio de IES, otra financiacion, pauso estudios, situacion economica).",
        "Si acepta: confirmar misma universidad/programa, semestre a matricular y datos de contacto vigentes.",
        "La orden de matricula (PDF) se recibe por WhatsApp o con el asesor; Valerie (voz) NO recibe archivos.",
        "Si hay interes: un asesor de su agencia continua el proceso (handoff).",
        "Si no desea renovar: registrar motivo y cerrar con cortesia; si pide no ser contactado, confirmar opt-out.",
    ]),
    ("Reactivacion (flujo voz)", [
        "Objetivo: retomar el contacto con quienes tuvieron credito o dejaron de operar con Coopfuturo.",
        "Pregunta clave: si actualmente continua con sus estudios (termino / pauso / sigue).",
        "Si termino: felicitar y ofrecer posgrado, educacion continua u otras opciones con asesor.",
        "Si pauso: preguntar si piensa retomar este semestre; si si, oferta de regreso y precalificacion verbal.",
        "Si sigue estudiando: preguntar como financia hoy su matricula y ofrecer regreso a Coopfuturo.",
        "Precalificacion expres verbal: universidad, semestre, actividad economica, reportes (sin inventar).",
        "Interesado -> handoff a asesor; no interesado -> cierre respetuoso.",
    ]),
    ("Requisitos credito educativo - estudiante (autoritativo COPI)", [
        "Copia de cedula al 150% (fotocopia ampliada).",
        "Recibo / orden de matricula de la universidad (PDF).",
        "Si es empleado: ultimo desprendible de nomina.",
        "Si es menor de edad: fotocopia de la tarjeta de identidad y responsable del pago de las cuotas.",
        "Documentos escaneados en PDF (preferible un solo archivo); no se aceptan fotos sueltas para el tramite formal.",
        "Paso tipico: documento de identidad del estudiante y del aliado de pago + recibo de matricula del semestre.",
    ]),
    ("Requisitos codeudor (autoritativo COPI)", [
        "Fotocopia de la cedula ampliada (al 150%).",
        "Edad maxima 69 anos.",
        "Contrato fijo o indefinido con mas de 6 meses de antiguedad (empleados).",
        "Certificacion laboral o desprendible de pago.",
        "Ingresos iguales o superiores a dos salarios minimos.",
        "La necesidad de codeudor depende de la validacion del perfil (estabilidad laboral, reportes e ingresos). El agente de voz NO debe afirmar que alguien necesita o no necesita codeudor: un asesor lo confirma en el estudio.",
    ]),
    ("Perfilamiento / precalificacion (preguntas tipicas)", [
        "Ciudad y universidad de la solicitud.",
        "Primera vez o renovacion (tiene o ha tenido credito con Coopfuturo).",
        "Mayor de edad; si no, quien es el responsable del pago.",
        "Actividad economica del titular: Empleado, Independiente, Pensionado, Finca raiz o Prestacion de servicios.",
        "Actividad economica del codeudor (mismas opciones).",
        "Monto que desea solicitar (lo confirma el asesor en estudio).",
        "Si tiene conocimiento de reportes negativos en centrales de riesgo.",
        "Ingreso mensual expresado en SMMLV (salarios minimos).",
        "Tipo de estudio: pregrado o posgrado.",
    ]),
    ("Medios de pago (autoritativo)", [
        "PSE / pagos en linea: https://coopfuturo.com.co/pagos-en-linea/",
        "MiPagoAmigo (Davivienda) disponible para pagos a Coopfuturo.",
        "Efecty, Daviplata, bancos Davivienda y Banco de Bogota.",
        "Pago presencial en cualquiera de las 9 agencias.",
        "Usar siempre medios autorizados por Coopfuturo; nunca claves, OTP, PIN ni CVV por telefono.",
    ]),
    ("Microcredito (referencia; cobertura Santander)", [
        "Aplica a personas con emprendimiento o negocio en Santander.",
        "Documentos tipicos: RUT DIAN con actividad, facturas de compra o venta, camara de comercio (si la tiene), recibo de servicio publico (estrato).",
        "Visita al negocio para confirmar funcionamiento.",
        "Codeudor: empleado (carta laboral, >6 meses, ingreso > SMMLV, tres desprendibles), pensionado (tres desprendibles, > SMMLV) o independiente con finca raiz (certificado de libertad y tradicion sin embargo ni patrimonio de familia).",
        "Consulta en centrales de riesgo del titular y codeudor tiene costo (referencia COPI: alrededor de 7.000 pesos por cada uno); el asesor confirma valores vigentes.",
        "Si el negocio no esta en Santander: no aplica por cobertura; se puede registrar interes para expansion futura.",
    ]),
    ("Agencias", [
        "9 agencias: Bucaramanga, Barrancabermeja, Barranquilla, Cucuta, Floridablanca, Piedecuesta, San Gil, Valledupar y Villavicencio.",
        "Villavicencio: Avenida 40 No. 26c-10, C.C. Unicentro, piso 3, local 3-49 B, barrio Nuevo Maizaro.",
        "Villavicencio WhatsApp: 3223122184 y 3223087472. Lineas: 3114446008 y 3114447201.",
        "Para tramites y pagos presenciales, el asociado puede acercarse a la agencia mas cercana.",
    ]),
    ("Canales oficiales y seguridad", [
        "Linea nacional: 300 912 7807. Sitio: coopfuturo.com.co.",
        "Coopfuturo informa sobre productos y credito; no solicita contrasenas ni pagos a cuentas personales.",
        "Ante dudas de autenticidad: verificar en la linea nacional o en la agencia.",
    ]),
    ("Habeas Data (Ley 1581 de 2012)", [
        "El tratamiento de datos personales se rige por la Ley 1581 de 2012.",
        "El asociado tiene derecho a conocer, actualizar y rectificar sus datos.",
        "Las llamadas pueden grabarse con fines de calidad; antes de tratar datos financieros se confirma que se habla con el titular.",
    ]),
    ("Preguntas frecuentes", [
        "P: Que financian? R: Matricula de pregrado, posgrado, tecnicos, tecnologicos, especializaciones y educacion continua; tambien cursos o materias.",
        "P: Cuanto financian? R: Hasta el 100% de la matricula, segun estudio de credito; el asesor confirma el monto final.",
        "P: Necesito codeudor? R: Depende de la validacion de su perfil (estabilidad laboral, reportes e ingresos). Un asesor confirmara esta condicion durante el estudio; no se afirma por telefono.",
        "P: Donde pago? R: PSE (coopfuturo.com.co/pagos-en-linea), MiPagoAmigo, Efecty, Daviplata, Davivienda, Banco de Bogota o agencias.",
        "P: Todo el proceso es virtual? R: Si puede ser 100% virtual; tambien hay atencion en oficinas.",
        "P: Como renuevo? R: Confirmar interes, datos y universidad; enviar orden de matricula PDF por WhatsApp o con el asesor.",
        "P: Estoy reportado? R: Hay alternativas (p. ej. microcredito con codeudor); un asesor orienta el caso.",
        "P: Puedo financiar solo una parte? R: Si, financiacion parcial segun el caso.",
        "P: En cuanto tiempo desembolsan? R: Depende del estudio y documentos; el asesor da el plazo real.",
    ]),
    ("Guia para el asesor de voz (Valerie)", [
        "Eres Valerie, asistente de voz de Coopfuturo (marca PULSO white-label). Nunca menciones ElevenLabs, LIWA, Meta, AWS ni otros proveedores.",
        "No digas montos de cupo preaprobado: ese dato no existe en la cartera; enfocate en renovacion o continuidad de estudios.",
        "Tras confirmar identidad puedes usar saldo, cuota, mora y fecha de proximo pago si llegan en variables dinamicas concretas.",
        "Responde dudas con esta base de conocimiento; si no esta el dato, ofrece handoff a un asesor de la sede.",
        "No pidas datos sensibles (contrasenas, OTP, PIN, CVV).",
        "Si acepta avanzar: un asesor de su agencia continuara el proceso y recibira la orden de matricula por WhatsApp si aplica.",
    ]),
]


def build_pdf(path: str) -> None:
    try:
        from fpdf import FPDF  # type: ignore
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "fpdf2"], check=True)
        from fpdf import FPDF  # type: ignore

    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_margins(18, 16, 18)
    pdf.add_page()
    w = pdf.epw  # effective page width (respects margins)

    def block(text: str, size: int, style: str = "", gap: float = 0.0) -> None:
        pdf.set_font("Helvetica", style, size)
        pdf.set_x(pdf.l_margin)
        pdf.multi_cell(w, size * 0.5 + 1.5, sanitize(text))
        if gap:
            pdf.ln(gap)

    block("Coopfuturo - Credito educativo Crediestudio", 16, "B")
    block("Base de conocimiento para el agente de voz Valerie (NOVA)", 11, "", gap=3)

    for title, lines in SECTIONS:
        if pdf.get_y() > 250:
            pdf.add_page()
        block(title, 13, "B")
        for line in lines:
            block("- " + line, 11)
        pdf.ln(2)

    pdf.output(path)
    print(f"PDF_GENERATED={path}")


def el_get(path: str, api_key: str):
    req = urllib.request.Request(BASE + path, headers={"xi-api-key": api_key, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode() or "{}")


def el_json(path: str, api_key: str, method: str, body: dict):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def upload_pdf(path: str, api_key: str, name: str):
    boundary = "----coopfuturoKB" + uuid.uuid4().hex
    fname = os.path.basename(path)
    pre = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="name"\r\n\r\n{name}\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{fname}"\r\n'
        f"Content-Type: application/pdf\r\n\r\n"
    ).encode("utf-8")
    post = f"\r\n--{boundary}--\r\n".encode("utf-8")
    body = pre + Path(path).read_bytes() + post
    req = urllib.request.Request(
        BASE + "/v1/convai/knowledge-base/file",
        data=body,
        headers={
            "xi-api-key": api_key,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def find_existing(api_key: str, name: str):
    try:
        data = el_get("/v1/convai/knowledge-base?page_size=100", api_key)
    except Exception:
        return []
    docs = data.get("documents") if isinstance(data, dict) else data
    docs = docs or []
    return [d for d in docs if str(d.get("name", "")) == name]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--generate", action="store_true", help="solo generar el PDF")
    ap.add_argument("--upload", action="store_true", help="generar y subir a ElevenLabs")
    ap.add_argument("--write-env", action="store_true", help="escribir NOVA_KB_* en .env")
    ap.add_argument("--replace", action="store_true", help="borrar KB anterior con el mismo nombre")
    ap.add_argument("--env", default="/opt/hyperion-platform/.env")
    ap.add_argument("--pdf", default=DEFAULT_PDF)
    args = ap.parse_args()

    env_path = Path(args.env)
    env = load_env(env_path)
    api_key = env.get("ELEVENLABS_API_KEY") or os.environ.get("ELEVENLABS_API_KEY", "")

    build_pdf(args.pdf)
    if args.generate and not args.upload:
        return

    if not api_key:
        print("ERROR: ELEVENLABS_API_KEY no encontrado en .env", file=sys.stderr)
        sys.exit(1)

    if args.replace:
        for d in find_existing(api_key, DOC_NAME):
            did = d.get("id") or d.get("documentation_id")
            if did:
                code, resp = el_json(f"/v1/convai/knowledge-base/{did}", api_key, "DELETE", {})
                print(f"DELETED_OLD={did} http={code}")

    code, resp = upload_pdf(args.pdf, api_key, DOC_NAME)
    print(f"UPLOAD_HTTP={code}")
    if code >= 300:
        print(json.dumps(resp)[:1500], file=sys.stderr)
        sys.exit(2)
    doc_id = resp.get("id") or resp.get("documentation_id") or ""
    print(f"NOVA_KB_DOCUMENT_ID={doc_id}")
    print(f"NOVA_KB_DOCUMENT_NAME={DOC_NAME}")

    if doc_id:
        code_r, resp_r = el_json(
            f"/v1/convai/knowledge-base/{doc_id}/rag-index",
            api_key,
            "POST",
            {"model": "multilingual_e5_large_instruct"},
        )
        print(f"RAG_INDEX_HTTP={code_r} status={resp_r.get('status') if isinstance(resp_r, dict) else ''}")

    if args.write_env and doc_id:
        upsert_env(env_path, {"NOVA_KB_DOCUMENT_ID": doc_id, "NOVA_KB_DOCUMENT_NAME": DOC_NAME})
        print("WROTE_ENV=1")


if __name__ == "__main__":
    main()

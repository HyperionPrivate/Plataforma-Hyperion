"""Lead context for voice outbound — enrich ElevenLabs dynamic variables from contacts."""

from __future__ import annotations

from typing import Any

from pilot_core import ops_store
from pilot_core.phone import normalize_phone

_UNITS = (
    "cero",
    "uno",
    "dos",
    "tres",
    "cuatro",
    "cinco",
    "seis",
    "siete",
    "ocho",
    "nueve",
    "diez",
    "once",
    "doce",
    "trece",
    "catorce",
    "quince",
    "dieciséis",
    "diecisiete",
    "dieciocho",
    "diecinueve",
)
_TENS = (
    "",
    "",
    "veinte",
    "treinta",
    "cuarenta",
    "cincuenta",
    "sesenta",
    "setenta",
    "ochenta",
    "noventa",
)
_HUNDREDS = (
    "",
    "ciento",
    "doscientos",
    "trescientos",
    "cuatrocientos",
    "quinientos",
    "seiscientos",
    "setecientos",
    "ochocientos",
    "novecientos",
)


def _under_1000(n: int) -> str:
    if n == 0:
        return ""
    if n == 100:
        return "cien"
    if n < 20:
        return _UNITS[n]
    if n < 100:
        ten, unit = divmod(n, 10)
        if unit == 0:
            return _TENS[ten]
        if ten == 2:
            return f"veinti{_UNITS[unit]}"
        return f"{_TENS[ten]} y {_UNITS[unit]}"
    hun, rest = divmod(n, 100)
    head = _HUNDREDS[hun]
    tail = _under_1000(rest)
    return f"{head} {tail}".strip() if tail else head


def money_to_spoken_cop(value: Any) -> str:
    """Convert COP amount to spoken Spanish for TTS (no $, no dots)."""
    try:
        if isinstance(value, str):
            cleaned = value.replace("$", "").replace(" ", "").replace(".", "").replace(",", "")
            n = int(float(cleaned)) if cleaned else 0
        else:
            n = int(float(value))
    except Exception:
        s = str(value or "").strip()
        return s if s else ""
    if n < 0:
        n = abs(n)
    if n == 0:
        return "cero pesos"

    parts: list[str] = []
    millions, rem = divmod(n, 1_000_000)
    thousands, units = divmod(rem, 1_000)

    if millions:
        if millions == 1:
            parts.append("un millón")
        else:
            parts.append(f"{_under_1000(millions)} millones")
    if thousands:
        if thousands == 1:
            parts.append("mil")
        else:
            parts.append(f"{_under_1000(thousands)} mil")
    if units:
        parts.append(_under_1000(units))

    spoken = " ".join(parts)
    # "un millón de pesos"; el resto suena natural con "pesos" al final.
    if spoken == "un millón":
        return "un millón de pesos"
    return f"{spoken} pesos"


def _money(value: Any) -> str:
    """Display form (for logs/CRM). Prefer spoken vars for TTS."""
    try:
        n = int(float(value))
        return f"${n:,}".replace(",", ".")
    except Exception:
        s = str(value or "").strip()
        return s if s else ""


def _s(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def find_contact(phone: str) -> dict[str, Any] | None:
    phone_n = normalize_phone(phone) or phone.strip()
    hit = ops_store.get_contact_by_phone(phone_n)
    if hit:
        return hit
    # Fallback scan (legacy rows without unique phone index).
    for c in ops_store.list_contacts(5_000):
        if normalize_phone(str(c.get("phone") or "")) == phone_n:
            return c
    return None


def build_dynamic_variables(
    *,
    phone: str,
    first_name: str = "Asociado",
    flow: str = "A",
    contact: dict[str, Any] | None = None,
) -> dict[str, str]:
    """Variables consumed by the ElevenLabs agent prompt ({{nombre}}, {{cupo}}, …)."""
    c = contact or find_contact(phone) or {}
    raw_payload = c.get("payload")
    payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else c

    nombre = _s(
        payload.get("nombre") or payload.get("first_name") or c.get("first_name") or first_name,
        first_name or "Asociado",
    )
    apellido1 = _s(payload.get("apellido1") or payload.get("apellido"))
    apellido2 = _s(payload.get("apellido2"))
    full_name = " ".join(p for p in (nombre, apellido1, apellido2) if p).strip() or nombre

    universidad = _s(payload.get("universidad") or payload.get("university") or c.get("university"))
    programa = _s(payload.get("programa") or payload.get("carrera"))
    semestre = _s(payload.get("semestre"))
    ciudad = _s(payload.get("ciudad"))
    producto = _s(payload.get("producto") or payload.get("linea_credito"))
    segmento = _s(
        payload.get("segmento") or payload.get("segment") or c.get("segment"),
        "Reactivacion" if str(flow).upper() == "B" else "Renovacion",
    )
    cupo = payload.get("cupo_preaprobado") or payload.get("cupo")
    cuota = payload.get("cuota_actual") or payload.get("cuota")
    saldo = payload.get("saldo_total") or payload.get("saldo")
    notas = _s(payload.get("notas_agente") or payload.get("notas"))
    documento = _s(payload.get("documento") or payload.get("identificacion"))
    obligacion = _s(payload.get("obligacion") or payload.get("pagare"))
    agencia = _s(payload.get("agencia"))

    # Voice TTS: always inject spoken Spanish amounts (never $4.200.000).
    cupo_txt = (
        money_to_spoken_cop(cupo) if cupo not in (None, "") else "cupo preaprobado disponible"
    )
    cuota_txt = money_to_spoken_cop(cuota) if cuota not in (None, "") else ""
    saldo_txt = money_to_spoken_cop(saldo) if saldo not in (None, "") else ""
    cupo_display = _money(cupo) if cupo not in (None, "") else ""
    cuota_display = _money(cuota) if cuota not in (None, "") else ""

    known_bits = []
    if universidad:
        known_bits.append(f"universidad {universidad}")
    if programa:
        known_bits.append(f"programa {programa}")
    if semestre:
        known_bits.append(f"semestre {semestre}")
    if cupo_txt and cupo not in (None, ""):
        known_bits.append(f"cupo preaprobado {cupo_txt}")
    if cuota_txt:
        known_bits.append(f"cuota de referencia {cuota_txt}")

    contexto = (
        "Datos confirmados del asociado: " + "; ".join(known_bits) + "."
        if known_bits
        else "Sin ficha completa; captura universidad, programa y semestre."
    )
    if notas:
        contexto = f"{contexto} Nota operativa: {notas}"

    return {
        "nombre": nombre.split()[0].title() if nombre else "Asociado",
        "first_name": nombre.split()[0].title() if nombre else "Asociado",
        "nombre_completo": full_name.title(),
        "phone": normalize_phone(phone) or phone,
        "flujo": str(flow).upper(),
        "product_flow": str(flow).upper(),
        "segmento": segmento,
        "universidad": universidad or "por confirmar",
        "programa": programa or "por confirmar",
        "semestre": semestre or "por confirmar",
        "ciudad": ciudad or "",
        "producto": producto or "",
        "documento": documento,
        "obligacion": obligacion,
        "agencia": agencia,
        "cupo": cupo_txt,
        "cupo_preaprobado": cupo_txt,
        "cuota": cuota_txt,
        "cuota_actual": cuota_txt,
        "saldo_total": saldo_txt,
        "cupo_display": cupo_display,
        "cuota_display": cuota_display,
        "contexto_cliente": contexto,
        "puede_whatsapp": "si",
        "instruccion_whatsapp": (
            "Si el asociado pide información, documentos o matrícula por WhatsApp, "
            "confirma que SE LO ENVIAREMOS por WhatsApp al terminar la llamada. "
            "Nunca digas que no puedes enviar WhatsApp."
        ),
        "instruccion_montos": (
            "Al hablar montos, di SIEMPRE las cantidades en palabras en español "
            f"(ej. {cupo_txt}"
            + (f", cuota {cuota_txt}" if cuota_txt else "")
            + "). Nunca digas el símbolo de dólar ni leas cifras con puntos "
            "como cuatro punto doscientos. Si no hay monto en ficha, ofrece "
            "enviar el detalle por WhatsApp."
        ),
    }


def display_name_from_contact(contact: dict[str, Any] | None, fallback: str = "Asociado") -> str:
    if not contact:
        return fallback
    raw_payload = contact.get("payload")
    payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else contact
    nombre = _s(payload.get("nombre") or payload.get("first_name") or contact.get("first_name"))
    if not nombre:
        return fallback
    return nombre.split()[0].title()

"""contacts domain — import preview/validate/commit with SQLite persistence."""

from __future__ import annotations

import re
from typing import Any
from uuid import uuid4

from pilot_core import ops_store
from pilot_core.phone import normalize_phone

_E164 = re.compile(r"^\+[1-9]\d{7,14}$")
_PREVIEW_LIMIT = 200

_EXTRA_KEYS = (
    "apellido1",
    "apellido2",
    "documento",
    "programa",
    "semestre",
    "ciudad",
    "email",
    "obligacion",
    "producto",
    "linea_credito",
    "estado_credito",
    "agencia",
    "saldo_total",
    "cuota_actual",
    "cupo_preaprobado",
    "mora_actual",
    "fecha_apertura",
    "notas_agente",
    "flujo",
)


class ContactsService:
    name: str = "contacts"

    def ping(self) -> str:
        return self.name

    def parse_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        parsed: list[dict[str, Any]] = []
        for raw in rows:
            phone_raw = str(
                raw.get("phone") or raw.get("telefono") or raw.get("celular") or ""
            ).strip()
            phone = normalize_phone(phone_raw) or phone_raw
            first = str(raw.get("first_name") or raw.get("nombre") or "").strip() or "Asociado"
            apellido1 = str(raw.get("apellido1") or raw.get("apellido") or "").strip()
            apellido2 = str(raw.get("apellido2") or "").strip()
            segment = str(raw.get("segment") or raw.get("segmento") or "Renovacion").strip()
            university = raw.get("university") or raw.get("universidad")
            errors: list[str] = []
            if not _E164.match(phone):
                errors.append("phone_not_e164")
            row: dict[str, Any] = {
                "id": f"ct_{uuid4().hex[:10]}",
                "phone": phone,
                "first_name": first,
                "apellido1": apellido1 or None,
                "apellido2": apellido2 or None,
                "segment": segment,
                "university": str(university) if university else None,
                "universidad": str(university) if university else None,
                "valid": not errors,
                "errors": errors,
            }
            for key in _EXTRA_KEYS:
                if key in raw and raw.get(key) not in (None, ""):
                    row[key] = raw.get(key)
            # Convenience aliases used by lead_context
            if university and "universidad" not in row:
                row["universidad"] = university
            parsed.append(row)
        return parsed

    def preview_rows(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        parsed = self.parse_rows(rows)
        valid = [c for c in parsed if c["valid"]]
        invalid = [c for c in parsed if not c["valid"]]
        return {
            "total": len(parsed),
            "valid": len(valid),
            "invalid": len(invalid),
            "rows": parsed[:_PREVIEW_LIMIT],
            "truncated": len(parsed) > _PREVIEW_LIMIT,
        }

    def commit_valid(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        # AUD-030: atomic batch — preview cap must not truncate persistence.
        if len(rows) > 5000:
            return {
                "committed": 0,
                "valid": 0,
                "invalid": 0,
                "total": len(rows),
                "error": "too_many_rows",
                "max_rows": 5000,
            }
        parsed = self.parse_rows(rows)
        valid_rows = [r for r in parsed if r["valid"]]
        committed = ops_store.insert_contacts_batch(valid_rows)
        return {
            "committed": committed,
            "valid": len(valid_rows),
            "invalid": sum(1 for r in parsed if not r["valid"]),
            "total": len(parsed),
            "store_size": len(ops_store.list_contacts(10_000)),
            "atomic": True,
        }

    def list_contacts(self, limit: int = 100) -> dict[str, Any]:
        items = ops_store.list_contacts(limit)
        return {"items": items, "total": len(items)}


contacts_service = ContactsService()

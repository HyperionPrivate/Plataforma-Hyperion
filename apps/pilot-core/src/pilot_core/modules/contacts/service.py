"""contacts domain — import preview/validate/commit with SQLite persistence."""

from __future__ import annotations

import re
from typing import Any
from uuid import uuid4

from pilot_core import ops_store

_E164 = re.compile(r"^\+[1-9]\d{7,14}$")


class ContactsService:
    name: str = "contacts"

    def ping(self) -> str:
        return self.name

    def preview_rows(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        parsed: list[dict[str, Any]] = []
        for raw in rows:
            phone = str(raw.get("phone") or raw.get("telefono") or "").strip()
            first = str(raw.get("first_name") or raw.get("nombre") or "").strip() or "Asociado"
            segment = str(raw.get("segment") or raw.get("segmento") or "Renovacion").strip()
            university = raw.get("university") or raw.get("universidad")
            errors: list[str] = []
            if not _E164.match(phone):
                errors.append("phone_not_e164")
            parsed.append(
                {
                    "id": f"ct_{uuid4().hex[:10]}",
                    "phone": phone,
                    "first_name": first,
                    "segment": segment,
                    "university": str(university) if university else None,
                    "valid": not errors,
                    "errors": errors,
                }
            )
        valid = [c for c in parsed if c["valid"]]
        invalid = [c for c in parsed if not c["valid"]]
        return {
            "total": len(parsed),
            "valid": len(valid),
            "invalid": len(invalid),
            "rows": parsed[:200],
        }

    def commit_valid(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        preview = self.preview_rows(rows)
        committed = 0
        for row in preview["rows"]:
            if row["valid"]:
                ops_store.insert_contact(row)
                committed += 1
        return {"committed": committed, "store_size": len(ops_store.list_contacts(10_000))}

    def list_contacts(self, limit: int = 100) -> dict[str, Any]:
        items = ops_store.list_contacts(limit)
        return {"items": items, "total": len(items)}


contacts_service = ContactsService()

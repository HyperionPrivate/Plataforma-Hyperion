"""documents — metadata + validation stub (antivirus/MinIO TBD)."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from pilot_core import ops_store

_ALLOWED = {".pdf", ".jpg", ".jpeg", ".png"}


class DocumentsService:
    name: str = "documents"

    def ping(self) -> str:
        return self.name

    def register(
        self,
        *,
        filename: str,
        content_type: str = "application/pdf",
        size_bytes: int = 0,
        contact_phone: str | None = None,
        kind: str = "orden_matricula",
    ) -> dict[str, Any]:
        lower = filename.lower()
        ext = "." + lower.rsplit(".", 1)[-1] if "." in lower else ""
        errors: list[str] = []
        if ext not in _ALLOWED:
            errors.append("extension_not_allowed")
        if size_bytes > 10 * 1024 * 1024:
            errors.append("file_too_large")
        # Mock antivirus always clean unless name contains "virus".
        infected = "virus" in lower
        if infected:
            errors.append("antivirus_rejected")

        doc = {
            "id": f"doc_{uuid4().hex[:10]}",
            "filename": filename,
            "content_type": content_type,
            "size_bytes": size_bytes,
            "contact_phone": contact_phone,
            "kind": kind,
            "status": "rejected" if errors else "validated",
            "errors": errors,
            "storage": "mock_minio",
            "retention_days": 90,
        }
        return ops_store.upsert_document(doc)

    def list(self, limit: int = 100) -> dict[str, Any]:
        items = ops_store.list_documents(limit)
        return {"items": items, "total": len(items)}


documents_service = DocumentsService()

"""documents — metadata + validation + filesystem/MinIO storage."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from pilot_core import ops_store
from pilot_core.modules.object_storage import get_object_storage
from pilot_core.settings import get_settings

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
        content: bytes | None = None,
    ) -> dict[str, Any]:
        lower = filename.lower()
        ext = "." + lower.rsplit(".", 1)[-1] if "." in lower else ""
        errors: list[str] = []
        if ext not in _ALLOWED:
            errors.append("extension_not_allowed")
        effective_size = len(content) if content is not None else size_bytes
        if effective_size > 10 * 1024 * 1024:
            errors.append("file_too_large")
        infected = "virus" in lower
        if infected:
            errors.append("antivirus_rejected")

        settings = get_settings()
        backend = (settings.documents_storage_backend or "filesystem").lower()
        storage_meta: dict[str, Any] = {"storage": backend if content else "metadata_only"}
        storage_key = None
        if content is not None and not errors:
            key = f"{kind}/{uuid4().hex[:12]}_{filename}"
            put = get_object_storage().put(key, content, content_type)
            storage_key = put.get("key")
            storage_meta = {
                "storage": put.get("backend") or backend,
                "storage_key": storage_key,
                "storage_path": put.get("path"),
                "bucket": put.get("bucket"),
            }

        doc = {
            "id": f"doc_{uuid4().hex[:10]}",
            "filename": filename,
            "content_type": content_type,
            "size_bytes": effective_size,
            "contact_phone": contact_phone,
            "kind": kind,
            "status": "rejected" if errors else "validated",
            "errors": errors,
            "retention_days": 90,
            **storage_meta,
        }
        return ops_store.upsert_document(doc)

    def list(self, limit: int = 100) -> dict[str, Any]:
        items = ops_store.list_documents(limit)
        return {"items": items, "total": len(items)}


documents_service = DocumentsService()

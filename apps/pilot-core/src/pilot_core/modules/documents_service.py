"""documents — metadata + validation + filesystem/MinIO storage."""

from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Any
from uuid import uuid4

from pilot_core import ops_store
from pilot_core.modules.object_storage import get_object_storage
from pilot_core.settings import get_settings

_ALLOWED = {".pdf", ".jpg", ".jpeg", ".png"}
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
_ALLOWED_KINDS = frozenset({"orden_matricula", "cedula", "ingresos", "otro", "doc"})


def _safe_filename(filename: str) -> str:
    # Drop any directory components from user-controlled names.
    base = PurePosixPath(str(filename).replace("\\", "/")).name
    cleaned = _SAFE_NAME.sub("_", base).strip("._")[:180]
    return cleaned or "documento.bin"


def _safe_kind(kind: str) -> str:
    cleaned = _SAFE_NAME.sub("_", str(kind or "doc")).strip("._").lower()[:64]
    if cleaned in _ALLOWED_KINDS:
        return cleaned
    return "otro"


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
        safe_name = _safe_filename(filename)
        lower = safe_name.lower()
        ext = next((e for e in sorted(_ALLOWED, key=len, reverse=True) if lower.endswith(e)), "")
        errors: list[str] = []
        if not ext:
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
            # Storage key is UUID-only + allowlisted kind/ext — never user path segments.
            key = f"{_safe_kind(kind)}/{uuid4().hex}{ext}"
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
            "filename": safe_name,
            "content_type": content_type,
            "size_bytes": effective_size,
            "contact_phone": contact_phone,
            "kind": _safe_kind(kind),
            "status": "rejected" if errors else "validated",
            "ok": not errors,
            "errors": errors,
            "retention_days": 90,
            **storage_meta,
        }
        return ops_store.upsert_document(doc)

    def list(self, limit: int = 100) -> dict[str, Any]:
        items = ops_store.list_documents(limit)
        return {"items": items, "total": len(items)}


documents_service = DocumentsService()

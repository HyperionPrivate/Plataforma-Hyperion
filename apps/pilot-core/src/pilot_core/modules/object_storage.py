"""Object storage backends for documents (mock | filesystem | minio)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Protocol

from pilot_core.settings import get_settings

# Keys must be generated server-side (UUID + allowlisted kind/ext). Reject anything else.
_KEY_RE = re.compile(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$")


def sanitize_storage_key(key: str) -> str:
    """Accept only already-safe relative keys; never trust raw user paths."""
    candidate = str(key).replace("\\", "/").strip("/")
    if not candidate or ".." in candidate.split("/") or not _KEY_RE.fullmatch(candidate):
        raise ValueError("invalid_storage_key")
    return candidate


class ObjectStorage(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> dict[str, Any]: ...

    def get(self, key: str) -> bytes | None: ...


class MockObjectStorage:
    def __init__(self) -> None:
        self._store: dict[str, bytes] = {}

    def put(self, key: str, data: bytes, content_type: str) -> dict[str, Any]:
        safe = sanitize_storage_key(key)
        self._store[safe] = data
        return {"key": safe, "size": len(data), "content_type": content_type, "backend": "mock"}

    def get(self, key: str) -> bytes | None:
        try:
            safe = sanitize_storage_key(key)
        except ValueError:
            return None
        return self._store.get(safe)


class FilesystemObjectStorage:
    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, key: str) -> Path:
        safe = sanitize_storage_key(key)
        # Join only validated segments (no user path separators left).
        path = self.root.joinpath(*safe.split("/")).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("path_escape")
        return path

    def put(self, key: str, data: bytes, content_type: str) -> dict[str, Any]:
        path = self._resolve(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return {
            "key": sanitize_storage_key(key),
            "size": len(data),
            "content_type": content_type,
            "backend": "filesystem",
            "path": str(path),
        }

    def get(self, key: str) -> bytes | None:
        try:
            path = self._resolve(key)
        except ValueError:
            return None
        if not path.is_file():
            return None
        return path.read_bytes()


class MinioObjectStorage:
    """Optional MinIO/S3 via boto3 if installed and configured."""

    def __init__(self) -> None:
        s = get_settings()
        try:
            import boto3  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("boto3 required for minio backend") from exc
        self.bucket = s.minio_bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=s.minio_endpoint,
            aws_access_key_id=s.minio_access_key,
            aws_secret_access_key=s.minio_secret_key,
            region_name="us-east-1",
        )
        try:
            self._client.head_bucket(Bucket=self.bucket)
        except Exception:
            self._client.create_bucket(Bucket=self.bucket)

    def put(self, key: str, data: bytes, content_type: str) -> dict[str, Any]:
        safe = sanitize_storage_key(key)
        self._client.put_object(
            Bucket=self.bucket,
            Key=safe,
            Body=data,
            ContentType=content_type,
        )
        return {
            "key": safe,
            "size": len(data),
            "content_type": content_type,
            "backend": "minio",
            "bucket": self.bucket,
        }

    def get(self, key: str) -> bytes | None:
        try:
            safe = sanitize_storage_key(key)
            obj = self._client.get_object(Bucket=self.bucket, Key=safe)
            return obj["Body"].read()
        except Exception:
            return None


_storage: ObjectStorage | None = None


def get_object_storage() -> ObjectStorage:
    global _storage
    if _storage is not None:
        return _storage
    s = get_settings()
    backend = (s.documents_storage_backend or "filesystem").lower()
    if backend == "minio" and s.minio_endpoint and s.minio_access_key:
        _storage = MinioObjectStorage()
    elif backend == "mock":
        _storage = MockObjectStorage()
    else:
        root = (s.documents_local_root or "").strip()
        if not root:
            from pilot_core.ops_store import data_root

            root = str(data_root() / "documents")
        _storage = FilesystemObjectStorage(root)
    return _storage

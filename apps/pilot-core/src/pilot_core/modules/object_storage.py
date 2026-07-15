"""Object storage backends for documents (mock | filesystem | minio)."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

from pilot_core.settings import get_settings


class ObjectStorage(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> dict[str, Any]: ...

    def get(self, key: str) -> bytes | None: ...


class MockObjectStorage:
    def __init__(self) -> None:
        self._store: dict[str, bytes] = {}

    def put(self, key: str, data: bytes, content_type: str) -> dict[str, Any]:
        self._store[key] = data
        return {"key": key, "size": len(data), "content_type": content_type, "backend": "mock"}

    def get(self, key: str) -> bytes | None:
        return self._store.get(key)


class FilesystemObjectStorage:
    def __init__(self, root: str) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, key: str, data: bytes, content_type: str) -> dict[str, Any]:
        safe = key.replace("..", "_").lstrip("/\\")
        path = self.root / safe
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return {
            "key": safe,
            "size": len(data),
            "content_type": content_type,
            "backend": "filesystem",
            "path": str(path),
        }

    def get(self, key: str) -> bytes | None:
        safe = key.replace("..", "_").lstrip("/\\")
        path = self.root / safe
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
        self._client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
        )
        return {
            "key": key,
            "size": len(data),
            "content_type": content_type,
            "backend": "minio",
            "bucket": self.bucket,
        }

    def get(self, key: str) -> bytes | None:
        try:
            obj = self._client.get_object(Bucket=self.bucket, Key=key)
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
        root = s.documents_local_root or ".local-secrets-tmp/documents"
        _storage = FilesystemObjectStorage(root)
    return _storage

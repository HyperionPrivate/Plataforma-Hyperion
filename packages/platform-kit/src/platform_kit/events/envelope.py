from __future__ import annotations

import json
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator


class DataClassification(StrEnum):
    PUBLIC = "public"
    INTERNAL = "internal"
    CONFIDENTIAL = "confidential"
    RESTRICTED_PII = "restricted_pii"


class EventEnvelope(BaseModel):
    event_id: str = Field(default_factory=lambda: str(uuid4()))
    event_type: str
    schema_version: str = "v1"
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    producer: str
    tenant_id: str
    correlation_id: str
    causation_id: str | None = None
    business_idempotency_key: str
    data_classification: DataClassification = DataClassification.INTERNAL
    payload: dict[str, Any]

    @field_validator("event_type")
    @classmethod
    def _non_empty_type(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("event_type required")
        return v

    @field_validator("business_idempotency_key")
    @classmethod
    def _idem_key(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("business_idempotency_key required and must not equal event_id alone")
        return v

    def to_json(self) -> str:
        return self.model_dump_json()

    @classmethod
    def from_json(cls, raw: str | bytes) -> EventEnvelope:
        return cls.model_validate_json(raw)

    def as_redis_fields(self) -> dict[str, str]:
        return {"envelope": self.to_json()}


MAX_EVENT_BYTES = 64_000


def validate_event_size(envelope: EventEnvelope) -> None:
    size = len(envelope.to_json().encode("utf-8"))
    if size > MAX_EVENT_BYTES:
        raise ValueError(f"event exceeds MAX_EVENT_BYTES ({MAX_EVENT_BYTES})")


def build_synthetic_ping(
    *,
    producer: str,
    tenant_id: str,
    correlation_id: str,
    marker: str,
) -> EventEnvelope:
    """Technical synthetic event for architecture tests — not a commercial event."""
    return EventEnvelope(
        event_type="platform.synthetic.ping",
        producer=producer,
        tenant_id=tenant_id,
        correlation_id=correlation_id,
        business_idempotency_key=f"synthetic-ping:{marker}",
        data_classification=DataClassification.INTERNAL,
        payload={"marker": marker, "kind": "architecture_test"},
    )


def dumps_payload(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)

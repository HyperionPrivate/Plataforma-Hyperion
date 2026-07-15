"""Deterministic external mocks — no network I/O."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Mode = Literal["success", "timeout", "error", "retryable"]


@dataclass
class MockDialerClient:
    """MOCK — Dialer/ElevenLabs. Never opens sockets."""

    mode: Mode = "success"
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def dispatch_call(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(payload)
        if self.mode == "timeout":
            raise TimeoutError("mock dialer timeout")
        if self.mode == "error":
            raise RuntimeError("mock dialer error")
        if self.mode == "retryable":
            raise RuntimeError("mock dialer 503")
        return {
            "mock": True,
            "status": "queued",
            "provider_call_id": f"mock-{len(self.calls)}",
            "idempotency_key": payload.get("idempotency_key"),
        }


@dataclass
class MockWhatsAppProvider:
    """MOCK — LIWA/WABA. Never sends messages."""

    mode: Mode = "success"
    sent: list[dict[str, Any]] = field(default_factory=list)

    async def send_message(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.sent.append(payload)
        if self.mode != "success":
            raise RuntimeError(f"mock wa {self.mode}")
        return {"mock": True, "message_id": f"wa-mock-{len(self.sent)}", "status": "accepted"}


@dataclass
class MockObjectStorage:
    """MOCK — object storage in memory."""

    mode: Mode = "success"
    objects: dict[str, bytes] = field(default_factory=dict)

    async def put(self, key: str, data: bytes, content_type: str) -> dict[str, Any]:
        if self.mode != "success":
            raise RuntimeError(f"mock storage {self.mode}")
        self.objects[key] = data
        return {"mock": True, "key": key, "size": len(data), "content_type": content_type}

    async def get(self, key: str) -> bytes:
        return self.objects[key]


@dataclass
class MockLiwaHandoff:
    """MOCK — LIWA handoff. Never contacts advisors."""

    mode: Mode = "success"
    cases: list[dict[str, Any]] = field(default_factory=list)

    async def create_case(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.cases.append(payload)
        if self.mode != "success":
            raise RuntimeError(f"mock handoff {self.mode}")
        return {"mock": True, "case_id": f"ho-mock-{len(self.cases)}", "status": "created"}


@dataclass
class MockCoreAdapter:
    """MOCK — Coopfuturo financial core."""

    mode: Mode = "success"
    outcomes: list[dict[str, Any]] = field(default_factory=list)

    async def record_outcome(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.outcomes.append(payload)
        if self.mode != "success":
            raise RuntimeError(f"mock core {self.mode}")
        return {"mock": True, "accepted": True}

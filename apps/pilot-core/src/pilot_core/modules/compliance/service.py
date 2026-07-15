"""Compliance gate — policies for outbound contact (piloto)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, time, timezone
from typing import Any

from pilot_core import ops_store

# Colombia aproximada UTC-5 (sin depender de tzdata en Windows).
_CO = timezone(timedelta(hours=-5), name="COT")


@dataclass
class PolicyDecision:
    allowed: bool
    reasons: list[str] = field(default_factory=list)
    policy_id: str = "pulso_outbound_v1"


class ComplianceService:
    name: str = "compliance"
    window_start: time = time(8, 0)
    window_end: time = time(20, 0)

    def __init__(self) -> None:
        self.suppressed: set[str] = set()
        self._hydrated = False

    def ping(self) -> str:
        return self.name

    def hydrate(self) -> None:
        """Load opt-outs from SQLite into memory."""
        try:
            ops_store.init_db()
            self.suppressed = set(ops_store.list_opt_outs())
            self._hydrated = True
        except Exception:
            self._hydrated = False

    def _ensure_hydrated(self) -> None:
        if not self._hydrated:
            self.hydrate()

    def suppress(self, phone: str) -> dict[str, Any]:
        phone = phone.strip()
        ops_store.add_opt_out(phone)
        self.suppressed.add(phone)
        self._hydrated = True
        return {"phone": phone, "suppressed": True}

    def evaluate(
        self, *, phone: str, channel: str = "voz", now: datetime | None = None
    ) -> PolicyDecision:
        self._ensure_hydrated()
        reasons: list[str] = []
        phone = phone.strip()
        if phone in self.suppressed:
            reasons.append("opt_out_suppressed")
        channels = ops_store.get_setting("channels") or {}
        if isinstance(channels, dict):
            if channel == "voz" and channels.get("voz_enabled") is False:
                reasons.append("channel_disabled_voz")
            if channel == "whatsapp" and channels.get("whatsapp_enabled") is False:
                reasons.append("channel_disabled_whatsapp")
        current = now or datetime.now(tz=_CO)
        local = current.astimezone(_CO)
        if not (self.window_start <= local.time() <= self.window_end):
            reasons.append("outside_contact_window")
        if channel not in {"voz", "whatsapp"}:
            reasons.append("channel_not_allowed")
        return PolicyDecision(allowed=not reasons, reasons=reasons)

    def as_dict(self, decision: PolicyDecision) -> dict[str, Any]:
        return {
            "allowed": decision.allowed,
            "reasons": decision.reasons,
            "policy_id": decision.policy_id,
        }

    def list_suppressed(self) -> list[str]:
        self._ensure_hydrated()
        return sorted(self.suppressed)


compliance_service = ComplianceService()

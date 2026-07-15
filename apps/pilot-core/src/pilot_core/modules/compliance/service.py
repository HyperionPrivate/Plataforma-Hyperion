"""Compliance gate — policies for outbound contact (piloto)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, time, timezone
from typing import Any

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

    def ping(self) -> str:
        return self.name

    def suppress(self, phone: str) -> None:
        self.suppressed.add(phone.strip())

    def evaluate(
        self, *, phone: str, channel: str = "voz", now: datetime | None = None
    ) -> PolicyDecision:
        reasons: list[str] = []
        phone = phone.strip()
        if phone in self.suppressed:
            reasons.append("opt_out_suppressed")
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


compliance_service = ComplianceService()

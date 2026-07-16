"""Compliance gate — policies for outbound contact (piloto), per tenant."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time, timedelta, timezone
from typing import Any

from pilot_core import ops_store
from pilot_core.phone import normalize_phone

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
        self._suppressed_by_tenant: dict[str, set[str]] = {}

    @property
    def suppressed(self) -> set[str]:
        """Backward-compatible view of the current tenant opt-out set."""
        try:
            tid = ops_store.require_tenant()
        except RuntimeError:
            return set()
        return self._suppressed_by_tenant.setdefault(tid, set())

    @suppressed.setter
    def suppressed(self, value: set[str]) -> None:
        try:
            tid = ops_store.require_tenant()
        except RuntimeError:
            tid = "tenant-dev"
        self._suppressed_by_tenant[tid] = set(value)

    def ping(self) -> str:
        return self.name

    def hydrate(self) -> None:
        """Load opt-outs for the current tenant from durable store."""
        tid = ops_store.require_tenant()
        ops_store.init_db()
        self._suppressed_by_tenant[tid] = {
            normalize_phone(p) or p.strip() for p in ops_store.list_opt_outs() if p
        }

    def _ensure_hydrated(self) -> set[str]:
        # AUD-018: always re-read SQLite so multi-instance sees fresh opt-outs.
        self.hydrate()
        tid = ops_store.require_tenant()
        return self._suppressed_by_tenant.get(tid, set())

    def suppress(self, phone: str) -> dict[str, Any]:
        tid = ops_store.require_tenant()
        phone = normalize_phone(phone) or phone.strip()
        ops_store.add_opt_out(phone)
        bucket = self._suppressed_by_tenant.setdefault(tid, set())
        bucket.add(phone)
        return {"phone": phone, "suppressed": True, "tenant_id": tid}

    def evaluate(
        self, *, phone: str, channel: str = "voz", now: datetime | None = None
    ) -> PolicyDecision:
        # Fail-closed if compliance store is unavailable.
        try:
            suppressed = self._ensure_hydrated()
            channels = ops_store.get_setting("channels") or {}
        except Exception:
            return PolicyDecision(allowed=False, reasons=["compliance_unavailable"])
        reasons: list[str] = []
        phone = normalize_phone(phone) or phone.strip()
        if phone in suppressed:
            reasons.append("opt_out_suppressed")
        if isinstance(channels, dict):
            if channel == "voz" and channels.get("voz_enabled") is False:
                reasons.append("channel_disabled_voz")
            if channel == "whatsapp" and channels.get("whatsapp_enabled") is False:
                reasons.append("channel_disabled_whatsapp")
        current = now or datetime.now(tz=_CO)
        local = current.astimezone(_CO)
        # AUD-028: window from durable channels setting (not process-global mutate).
        ventana_on = True
        if isinstance(channels, dict) and "ventana_8_20" in channels:
            ventana_on = bool(channels.get("ventana_8_20"))
        start = time(8, 0) if ventana_on else time(0, 0)
        end = time(20, 0) if ventana_on else time(23, 59)
        if not (start <= local.time() <= end):
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
        return sorted(self._ensure_hydrated())


compliance_service = ComplianceService()

"""campaigns domain — create/list backed by ops_store."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from pilot_core import ops_store


class CampaignsService:
    name: str = "campaigns"

    def ping(self) -> str:
        return self.name

    def create(
        self,
        *,
        name: str,
        segment: str = "Renovacion",
        channels: list[str] | None = None,
        total: int = 0,
    ) -> dict[str, Any]:
        # AUD-030: no roster → draft (not an active callable campaign).
        status = "activa" if int(total or 0) > 0 else "draft"
        campaign = {
            "id": f"c_{uuid4().hex[:8]}",
            "name": name,
            "segment": segment,
            "channels": channels or ["voz"],
            "contacted": 0,
            "total": total,
            "conversion": 0,
            "status": status,
            "ab": {"a": 0, "b": 0, "winner": None},
        }
        return ops_store.upsert_campaign(campaign)

    def list(self) -> list[dict[str, Any]]:
        return ops_store.list_campaigns()

    def bump_contacted(self, campaign_id: str, by: int = 1) -> dict[str, Any] | None:
        for c in ops_store.list_campaigns():
            if c.get("id") == campaign_id:
                c["contacted"] = int(c.get("contacted") or 0) + by
                return ops_store.upsert_campaign(c)
        return None


campaigns_service = CampaignsService()

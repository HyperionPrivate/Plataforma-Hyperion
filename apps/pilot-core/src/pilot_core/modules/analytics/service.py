"""analytics domain service — implementación de dominio en fases posteriores."""

from __future__ import annotations


class AnalyticsService:
    """Placeholder tipado; sin side-effects."""

    name: str = "analytics"

    def ping(self) -> str:
        return self.name

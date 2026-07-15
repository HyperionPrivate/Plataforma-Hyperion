"""contacts domain service — implementación de dominio en fases posteriores."""

from __future__ import annotations


class ContactsService:
    """Placeholder tipado; sin side-effects."""

    name: str = "contacts"

    def ping(self) -> str:
        return self.name

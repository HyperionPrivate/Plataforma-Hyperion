"""Fetch ElevenLabs ConvAI conversation status/transcript for post-call polling."""

from __future__ import annotations

from typing import Any

import httpx

from pilot_core.settings import get_settings

_API = "https://api.elevenlabs.io/v1/convai/conversations"


async def fetch_conversation(conversation_id: str) -> dict[str, Any] | None:
    """GET conversation details. Returns None on 404 / missing key / transport errors."""
    cid = (conversation_id or "").strip()
    if not cid:
        return None
    settings = get_settings()
    api_key = (getattr(settings, "elevenlabs_api_key", None) or "").strip()
    if not api_key:
        return None
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{_API}/{cid}",
                headers={"xi-api-key": api_key},
            )
    except httpx.HTTPError:
        return None
    if resp.status_code == 404:
        return None
    if not resp.is_success:
        return None
    try:
        data = resp.json()
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def conversation_is_finished(conv: dict[str, Any] | None) -> bool:
    if not conv:
        return False
    status = str(conv.get("status") or "").strip().lower()
    return status in {"done", "completed", "failed", "error"}


def conversation_has_usable_content(conv: dict[str, Any] | None) -> bool:
    """Prefer waiting until transcript or analysis is present after hangup."""
    if not conv:
        return False
    if conversation_is_finished(conv) and str(conv.get("status") or "").lower() in {
        "failed",
        "error",
    }:
        return True
    if conv.get("analysis"):
        return True
    transcript = conv.get("transcript")
    return isinstance(transcript, list) and len(transcript) > 0

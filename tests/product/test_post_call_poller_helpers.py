"""Unit tests for ElevenLabs conversation poller helpers."""

from __future__ import annotations

from pilot_core.modules.elevenlabs_conversations import (
    conversation_has_usable_content,
    conversation_is_finished,
)


def test_conversation_is_finished() -> None:
    assert conversation_is_finished({"status": "done"})
    assert conversation_is_finished({"status": "failed"})
    assert not conversation_is_finished({"status": "in-progress"})
    assert not conversation_is_finished(None)


def test_conversation_has_usable_content() -> None:
    assert conversation_has_usable_content(
        {"status": "done", "transcript": [{"role": "agent", "message": "hola"}]}
    )
    assert conversation_has_usable_content({"status": "done", "analysis": {"x": 1}})
    assert conversation_has_usable_content({"status": "failed"})
    assert not conversation_has_usable_content({"status": "done", "transcript": []})

"""Tests for spoken COP amounts used in voice TTS."""

from __future__ import annotations

from pilot_core.modules.lead_context import money_to_spoken_cop


def test_money_to_spoken_millions() -> None:
    assert money_to_spoken_cop(4_200_000) == "cuatro millones doscientos mil pesos"
    assert money_to_spoken_cop("$4.200.000") == "cuatro millones doscientos mil pesos"
    assert money_to_spoken_cop(385_000) == "trescientos ochenta y cinco mil pesos"
    assert money_to_spoken_cop(1_000_000) == "un millón de pesos"


def test_money_to_spoken_edge() -> None:
    assert money_to_spoken_cop(0) == "cero pesos"
    assert "pesos" in money_to_spoken_cop(2500)

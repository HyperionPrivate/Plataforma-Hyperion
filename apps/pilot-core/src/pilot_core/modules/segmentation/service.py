"""segmentation — propensity/urgency scores for Ops UI."""

from __future__ import annotations

import hashlib
from typing import Any

from pilot_core import ops_store


def _score(seed: str, salt: str) -> int:
    h = hashlib.sha256(f"{salt}:{seed}".encode()).hexdigest()
    return int(h[:8], 16) % 101


class SegmentationService:
    name: str = "segmentation"

    def ping(self) -> str:
        return self.name

    def scoreboard(self) -> dict[str, Any]:
        contacts = ops_store.list_contacts(200)
        points: list[dict[str, Any]] = []
        for c in contacts:
            phone = c.get("phone") or c.get("id") or "x"
            propensity = _score(phone, "propensity")
            urgency = _score(phone, "urgency")
            segment_raw = str(c.get("segment") or "Renovacion").lower()
            segment = "reactivacion" if "reactiva" in segment_raw else "renovacion"
            points.append(
                {
                    "x": propensity,
                    "y": urgency,
                    "z": 40,
                    "segment": segment,
                    "name": c.get("first_name") or phone,
                    "phone": phone,
                }
            )

        # Fallback demo cloud if empty store.
        if not points:
            for i in range(24):
                points.append(
                    {
                        "x": (i * 7) % 100,
                        "y": (i * 11) % 100,
                        "z": 40,
                        "segment": "renovacion" if i % 2 == 0 else "reactivacion",
                        "name": f"P-{i}",
                    }
                )

        waves = [
            {
                "ola": "Ola 1",
                "registros": sum(1 for p in points if p["y"] >= 50 and p["x"] < 50),
                "score": 82,
                "cierre": "próxima",
                "canal": "Voz",
            },
            {
                "ola": "Ola 2",
                "registros": sum(1 for p in points if p["y"] >= 50 and p["x"] >= 50),
                "score": 71,
                "cierre": "próxima",
                "canal": "WhatsApp",
            },
            {
                "ola": "Ola 3",
                "registros": sum(1 for p in points if p["y"] < 50),
                "score": 64,
                "cierre": "próxima",
                "canal": "Mixto",
            },
        ]
        retries = [
            "No contesta → WhatsApp en 2h",
            "Buzón → reintento voz mañana 10:00",
            "Objeción económica → nutrir 7 días",
            "Opt-out → exclusión permanente",
        ]
        heatmap = {
            "days": ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"],
            "hours": ["8", "10", "12", "14", "16", "18"],
            "values": [
                [0.2, 0.4, 0.5, 0.6, 0.7, 0.5],
                [0.3, 0.5, 0.6, 0.7, 0.8, 0.4],
                [0.4, 0.6, 0.7, 0.8, 0.7, 0.5],
                [0.3, 0.5, 0.6, 0.7, 0.6, 0.4],
                [0.2, 0.4, 0.5, 0.6, 0.5, 0.3],
                [0.1, 0.2, 0.3, 0.3, 0.2, 0.1],
            ],
        }
        return {"points": points, "waves": waves, "retries": retries, "heatmap": heatmap}


segmentation_service = SegmentationService()

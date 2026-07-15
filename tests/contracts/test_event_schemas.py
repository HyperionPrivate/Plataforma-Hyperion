from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
EVENTS = ROOT / "contracts" / "events" / "v1"
EXAMPLES = ROOT / "contracts" / "examples"


def test_envelope_requires_architecture_fields() -> None:
    schema = json.loads((EVENTS / "_envelope.json").read_text(encoding="utf-8"))
    required = set(schema["required"])
    for field in (
        "event_id",
        "event_type",
        "schema_version",
        "occurred_at",
        "producer",
        "tenant_id",
        "correlation_id",
        "business_idempotency_key",
        "data_classification",
        "payload",
    ):
        assert field in required


@pytest.mark.parametrize("path", sorted(EXAMPLES.glob("*.json")))
def test_examples_validate_against_envelope(path: Path) -> None:
    envelope = json.loads((EVENTS / "_envelope.json").read_text(encoding="utf-8"))
    example = json.loads(path.read_text(encoding="utf-8"))
    # Validate required envelope fields present
    for field in envelope["required"]:
        assert field in example
    assert example["business_idempotency_key"] != example["event_id"]
    assert example["data_classification"] in {
        "public",
        "internal",
        "confidential",
        "restricted_pii",
    }


def test_commercial_schemas_exist() -> None:
    needed = [
        "contact.imported.json",
        "contact.scored.json",
        "lead.qualified.json",
        "platform.synthetic.ping.json",
    ]
    for name in needed:
        assert (EVENTS / name).exists()

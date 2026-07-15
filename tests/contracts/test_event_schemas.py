from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
EVENTS = ROOT / "contracts" / "events" / "v1"
EXAMPLES = ROOT / "contracts" / "examples"
OPENAPI = ROOT / "contracts" / "openapi"


def _registry() -> Registry:
    resources = []
    for path in EVENTS.glob("*.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        uri = data.get("$id") or f"https://coopfuturo.local/contracts/events/v1/{path.name}"
        resources.append((uri, Resource.from_contents(data, default_specification=DRAFT202012)))
        # Also allow relative file resolution used by $ref: ./_envelope.json
        resources.append(
            (
                f"https://coopfuturo.local/contracts/events/v1/{path.name}",
                Resource.from_contents(data, default_specification=DRAFT202012),
            )
        )
    reg: Registry = Registry()
    for uri, resource in resources:
        reg = reg.with_resource(uri, resource)
    return reg


def _validator_for(schema_name: str) -> Draft202012Validator:
    schema = json.loads((EVENTS / schema_name).read_text(encoding="utf-8"))

    # Rewrite relative $ref to absolute ids so referencing can resolve them
    def _rewrite(node: object) -> object:
        if isinstance(node, dict):
            if "$ref" in node and isinstance(node["$ref"], str) and node["$ref"].startswith("./"):
                node = {
                    **node,
                    "$ref": f"https://coopfuturo.local/contracts/events/v1/{node['$ref'][2:]}",
                }
            return {k: _rewrite(v) for k, v in node.items()}
        if isinstance(node, list):
            return [_rewrite(v) for v in node]
        return node

    schema = _rewrite(schema)  # type: ignore[assignment]
    return Draft202012Validator(
        schema,
        registry=_registry(),
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )


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
def test_examples_validate_against_event_schema(path: Path) -> None:
    example = json.loads(path.read_text(encoding="utf-8"))
    event_type = example["event_type"]
    schema_file = f"{event_type}.json"
    assert (EVENTS / schema_file).exists(), f"missing schema for {event_type}"
    validator = _validator_for(schema_file)
    errors = sorted(validator.iter_errors(example), key=lambda e: e.path)
    assert not errors, "; ".join(f"{list(e.path)}: {e.message}" for e in errors)
    assert example["business_idempotency_key"] != example["event_id"]
    assert example["data_classification"] in {
        "public",
        "internal",
        "confidential",
        "restricted_pii",
    }


def test_invalid_payload_is_rejected() -> None:
    validator = _validator_for("platform.synthetic.ping.json")
    bad = {
        "event_id": "not-a-uuid",
        "event_type": "platform.synthetic.ping",
        "schema_version": "v1",
        "occurred_at": "not-a-date",
        "producer": "x",
        "tenant_id": "t",
        "correlation_id": "c",
        "business_idempotency_key": "k",
        "data_classification": "internal",
        "payload": {"unexpected": True},
    }
    assert not validator.is_valid(bad)


def test_wa_message_received_producer_is_adapter() -> None:
    example = json.loads((EXAMPLES / "wa.message.received.json").read_text(encoding="utf-8"))
    assert example["producer"] == "whatsapp-adapter"
    assert example["data_classification"] == "confidential"


def test_commercial_schemas_exist() -> None:
    needed = [
        "contact.imported.json",
        "contact.scored.json",
        "lead.qualified.json",
        "platform.synthetic.ping.json",
    ]
    for name in needed:
        assert (EVENTS / name).exists()


@pytest.mark.parametrize(
    "name",
    ["whatsapp-provider.yaml", "liwa-handoff.yaml", "core-coopfuturo.yaml"],
)
def test_openapi_has_auth_and_typed_errors(name: str) -> None:
    doc = yaml.safe_load((OPENAPI / name).read_text(encoding="utf-8"))
    assert "components" in doc
    assert "securitySchemes" in doc["components"] or name == "core-coopfuturo.yaml"
    assert "schemas" in doc["components"]
    assert "Error" in doc["components"]["schemas"]
    # At least one path documents 401 or security
    assert doc.get("security") or any(
        "401" in (op or {}).get("responses", {})
        for path_item in doc.get("paths", {}).values()
        for op in path_item.values()
        if isinstance(op, dict)
    )

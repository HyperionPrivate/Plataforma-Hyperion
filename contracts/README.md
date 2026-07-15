# Event catalog rules (architecture foundation)

## Envelope

See `events/v1/_envelope.json`. Required: event_id, event_type, schema_version, occurred_at, producer, tenant_id, correlation_id, business_idempotency_key, data_classification, payload. causation_id when applicable.

## Concepts

| Field | Meaning |
|---|---|
| `funnel_type` | renovacion \| reactivacion \| nuevo \| microcredito |
| `segment_code` | cohorte/segmento comercial |
| `score`, `score_version`, `reason_codes` | resultado de segmentación |

## Ownership (future product)

- `contact.imported` → importer/CRM (pilot-core.contacts)
- `contact.scored` → segmentation consumes imported, publishes scored
- Dialer events only via orchestration

## Limits

- Max envelope size: 64KB
- Breaking change → v2 + CHANGELOG
- Analytics must not receive raw text, documents, audio, or unrestricted PII
- `dynamic_variables` must be allowlisted when product implements voice

## Synthetic test event

`platform.synthetic.ping` — technical only; used by architecture tests.

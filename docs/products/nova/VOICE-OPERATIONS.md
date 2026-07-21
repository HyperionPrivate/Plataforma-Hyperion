---
documentType: runbook
status: engineering-baseline
owner: nova-voice
reviewDue: 2026-09-30
---

# NOVA Calls operational readiness

This runbook covers NOVA Core orchestration and Voice transport. WhatsApp delivery is outside this operational
scope; only the durable boundary events described in `VOICE-ORCHESTRATOR-SCOPE.md` apply.

## Alertable tenant checks

An authenticated NOVA admin can poll these BFF routes without reading call audio, transcripts, phone numbers or
other contact PII:

- `GET /v1/tenants/:tenantId/nova/operations/readiness`
- `GET /v1/tenants/:tenantId/voice/operations/readiness`

Both return `status: ok|degraded`, a measurement timestamp, explicit thresholds and integer metrics. Alert when
either response is unavailable or reports `degraded` twice consecutively. The initial engineering thresholds are:

| Signal                          |      Threshold |
| ------------------------------- | -------------: |
| Pending outbox event age        |      5 minutes |
| Failed outbox or unresolved DLQ | greater than 0 |
| Voice reconciliation age        |     15 minutes |
| Non-terminal call age           |     30 minutes |

These are initial engineering thresholds, not measured SLOs. Production owners must approve them after a load
test and record the monitoring destination, escalation rotation and dashboard link.

## Triage order

1. Pause the affected campaign in NOVA Core. This prevents new call authorizations; it does not cancel calls
   already accepted by the provider.
2. Inspect Core and Voice readiness metrics and correlate by durable event/call identifiers.
3. Resolve `needs_reconciliation` before redriving related events. An ambiguous provider response must never be
   treated as permission to redial.
4. Inspect the tenant-scoped DLQ through the admin endpoints. Redrive only after the destination is healthy and
   the event identity is understood.
5. Resume the campaign and confirm that the eligible enrollment backlog decreases without violating tenant
   concurrency or frequency policy.

## Retention decision required

No automatic deletion policy is enabled by this remediation. Retention for call records, provider identifiers,
outbox payloads and DLQ payloads may affect audit, consumer-protection and privacy duties. Before production,
Coopfuturo and the platform privacy/legal owner must approve durations and a deletion/hold procedure. Until that
decision exists, NOVA Calls is not approved for production retention even when the software checks are green.

## Evidence required for cutover

Capture the exact release digest, tenant policy revision, operator-grant projection receipt, readiness responses,
one consented test call correlation chain, terminal outcome and the absence of unresolved DLQ/reconciliation.
Evidence must exclude secrets, raw phone numbers, transcripts and customer documents.

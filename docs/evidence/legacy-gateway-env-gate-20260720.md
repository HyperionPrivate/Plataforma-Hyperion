# Legacy gateway env gate (DEBT-020 / 023 / 032)

Default: `LEGACY_GATEWAY_ENABLED=false` (fail-closed for new multiproduct facade paths).

When false, the API Gateway refuses legacy multiproduct proxy/snapshot activation and emits deprecation telemetry counters instead of serving transitional routes.

Restore of push/schedule CI triggers remains blocked on Actions quota (see Wave F audit).

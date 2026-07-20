# Legacy multiproduct gateway gate (DEBT-020 / 023 / 032)

Default: `LEGACY_GATEWAY_ENABLED` unset/false → product-scoped routes return `410` and increment
`legacyGatewayTelemetry.disabledRejects`.

When explicitly enabled (`true`), deprecated route hits increment `legacyGatewayTelemetry.deprecatedRouteHits`
for drain observation before proxy/snapshot retirement.

## Residual ops

1. Export/observe counters in the deployment environment until hits ≈ 0.
2. Delete legacy proxies + N-1 snapshot in `apps/api-gateway` and close DEBT-020/023/032.

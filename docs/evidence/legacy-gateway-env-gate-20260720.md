# Legacy multiproduct gateway product facade retired (DEBT-020 / DEBT-032)

The multiproduct legacy API gateway **product facade is permanently retired**.

- `isLegacyGatewayEnabled()` always returns `false` (environment variable ignored).
- Any product-scoped path detected by `readLegacyProductRequestScope` returns **HTTP 410** and increments
  `legacyGatewayTelemetry.disabledRejects`.
- Product proxy wildcards (pulso-iris / lumen / nova / voice / liwa / documents / WhatsApp integration /
  Sofia readiness via gateway) are removed from `apps/api-gateway`.
- Platform auth routes (login / me / logout / operators / tenants list / platform catalog / health) and
  public LIWA webhooks remain.

Clients must use product-owned BFFs. DEBT-020 / DEBT-032 closed in `docs/catalogs/debt.v1.json` (v1.12.0).

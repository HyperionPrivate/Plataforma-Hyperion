# PULSO BFF

Same-origin edge for `pulso-console`. It exposes only the tenant-scoped PULSO
Core (`pulso-iris`) and Integration namespaces that exist today. SOFIA, Prompt
Flow, Knowledge, Integration and WhatsApp are registered as cell-owned
upstreams, but services without a tenant-scoped customer API remain internal.

The Access JWT stays in a host-only `HttpOnly; Secure; SameSite=Strict` cookie.
The BFF validates RS256 locally through cached JWKS, enforces PULSO grants and
CSRF, then uses a dedicated workload credential plus a `PULSO_IRIS`-bound
operator assertion.

Required environment:

- `ACCESS_JWKS_URL`, `ACCESS_TOKEN_ISSUER`, `ACCESS_TOKEN_AUDIENCE=pulso-bff`
- `PULSO_BFF_TO_ACCESS_TOKEN`, `PULSO_OPERATOR_ASSERTION_KEY`
- `PULSO_BFF_TO_CORE_TOKEN`, `PULSO_BFF_TO_INTEGRATION_TOKEN` for the currently
  exposed namespaces

Owned upstream URLs and credentials are named `PULSO_BFF_TO_{SOFIA,
PROMPT_FLOW,KNOWLEDGE,WHATSAPP}_TOKEN` plus the corresponding `*_SERVICE_URL`.
Optional `HOST` and `PORT` default to `0.0.0.0:8097`.

JWKS requires HTTPS. Local/test/CI Compose may opt in to the exact private
`identity-service`/loopback hosts with `ACCESS_JWKS_ALLOW_PRIVATE_HTTP=true`;
the process rejects that flag in staging and production.

# LUMEN BFF

Same-origin edge for `lumen-console`. It accepts only the LUMEN tenant route
namespace, keeps the Access JWT in a host-only `HttpOnly; Secure;
SameSite=Strict` cookie, validates it locally from Access JWKS, enforces LUMEN
grants/capabilities, and signs a product-bound operator assertion for
`lumen-service`.

The edge exposes the minimal public provider-readiness projection at
`GET /v1/lumen/health`. Authenticated tenant traffic is limited to the exact
worklist, encounter detail, start, transcription, structure, record patch, and
approval method/route pairs owned by `lumen-service`; no wildcard product proxy
is registered.

Required environment:

- `ACCESS_JWKS_URL`, `ACCESS_TOKEN_ISSUER`, `ACCESS_TOKEN_AUDIENCE=lumen-bff`
- `LUMEN_BFF_TO_ACCESS_TOKEN`, `LUMEN_BFF_TO_LUMEN_TOKEN`
- `LUMEN_OPERATOR_ASSERTION_KEY` (at least 24 characters)

Optional environment: `ACCESS_SERVICE_URL`, `LUMEN_SERVICE_URL`, `HOST`, and
`PORT` (defaults to `8096`). Access and service URLs must be credential-free;
JWKS requires HTTPS. Local/test/CI Compose may opt in to the exact private
`identity-service`/loopback hosts with `ACCESS_JWKS_ALLOW_PRIVATE_HTTP=true`;
the process rejects that flag in staging and production.

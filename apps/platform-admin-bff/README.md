# Platform Admin BFF

Same-origin edge for `platform-admin-console`. It stores the Access JWT only in `__Host-hyperion-platform-admin-session` (`HttpOnly; Secure; SameSite=Strict; Path=/`, no `Domain`) and uses the readable `__Host-hyperion-platform-admin-csrf` cookie for double-submit CSRF protection.

The browser login must send `x-requested-with: platform-admin-console`. Browser bearer headers are ignored. Every administrative resource requires the exact `platform-admin` role and `manage:platform` capability on the reserved platform control tenant `00000000-0000-4000-8000-000000000001`; a role, capability, or customer-tenant `PLATFORM` grant alone is insufficient.

The BFF rejects any session cookie above 4,096 bytes before emitting `Set-Cookie`. Access currently keeps the JWT below 3,500 bytes by audience-filtering grants; future scale must use a tenant-scoped exchange.

The route allowlist contains only authentication, identity operators, tenant inventory, product grants, and the neutral catalog. Product routes and Audit reads return 404. Audit remains an asynchronous platform capability, but it is not a user/tenant/grant/catalog workflow and therefore is not exposed by this administration plane.

## Exact route inventory

The application checks this inventory against Fastify registrations during startup; drift fails readiness instead of silently widening the edge.

| Method   | Path                                                   | Authorization          | Owner                       |
| -------- | ------------------------------------------------------ | ---------------------- | --------------------------- |
| `GET`    | `/health`                                              | public                 | local                       |
| `GET`    | `/ready`                                               | public                 | local                       |
| `POST`   | `/v1/auth/login`                                       | public console request | Access                      |
| `GET`    | `/v1/auth/me`                                          | session                | local                       |
| `POST`   | `/v1/auth/logout`                                      | session + CSRF         | local                       |
| `GET`    | `/v1/platform/catalog`                                 | platform admin         | versioned platform contract |
| `GET`    | `/v1/identity/operators`                               | platform admin         | Identity/Access             |
| `POST`   | `/v1/identity/operators`                               | platform admin + CSRF  | Identity/Access             |
| `PATCH`  | `/v1/identity/operators/:operatorId`                   | platform admin + CSRF  | Identity/Access             |
| `GET`    | `/v1/tenants`                                          | platform admin         | Tenant                      |
| `GET`    | `/v1/platform/grants`                                  | platform admin         | Identity/Access             |
| `PUT`    | `/v1/platform/grants/:operatorId/:tenantId/:productId` | platform admin + CSRF  | Identity/Access             |
| `DELETE` | `/v1/platform/grants/:operatorId/:tenantId/:productId` | platform admin + CSRF  | Identity/Access             |

`tenant-service` currently exposes only `GET /v1/tenants`. Tenant creation and mutation remain tracked by `HYP-FED-001`; the console intentionally presents a read-only inventory and never provisions through direct SQL.

`GET /v1/platform/catalog` serves the provider-owned `@hyperion/platform-contracts/product-catalog` payload. The response always includes `schemaVersion`, SemVer `catalogVersion`, and `updatedAt`; the console renders those values and selects grant product IDs from the returned catalog rather than a local list.

Required runtime configuration:

- `ACCESS_SERVICE_URL`, `ACCESS_JWKS_URL`, `ACCESS_TOKEN_ISSUER`
- `PLATFORM_ADMIN_BFF_TO_ACCESS_TOKEN`
- `PLATFORM_ADMIN_BFF_TO_IDENTITY_TOKEN`, `PLATFORM_ADMIN_BFF_TO_TENANT_TOKEN`
- `PLATFORM_ADMIN_OPERATOR_ASSERTION_KEY`
- `IDENTITY_SERVICE_URL`, `TENANT_SERVICE_URL`

`ACCESS_JWKS_ALLOW_PRIVATE_HTTP=true` is accepted only in local/test/CI and only for loopback or the `identity-service` Compose hostname. Staging and production always require HTTPS.

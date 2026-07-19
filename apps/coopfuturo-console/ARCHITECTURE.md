# Coopfuturo Console — cliente NOVA

## Alcance

Esta aplicación es un cliente específico de Coopfuturo dentro de NOVA. Puede
contener copy, flujos y vistas propias del cliente, pero no rutas, contexto ni
endpoints de LUMEN o PULSO.

## Frontera HTTP

```text
navegador
  └─ /pilot-core/* (same-origin)
       └─ adapter Coopfuturo server-only
            └─ NOVA_BFF_URL
                 ├─ Access/session
                 ├─ nova-core
                 ├─ voice
                 ├─ liwa
                 └─ documents
```

`src/app/pilot-core/[...slug]/route.ts` es un delegador mínimo. Las formas
customer-facing `/ops/*` se adaptan en `src/server/coopfuturo-nova-adapter.ts`.
Una allowlist por método y ruta rechaza cualquier superficie desconocida con
404 antes de consultar la sesión.

El tenant se deriva de un único grant NOVA activo. Nunca se selecciona por slug,
variable pública o valor por defecto. Si existen varios tenants, se requiere un
selector explícito validado por grant.

## Sesión

NOVA BFF conserva el JWT en una cookie `__Host-*` HttpOnly. El navegador solo
envía cookies con `credentials: "include"`; las mutaciones presentan el token
CSRF de double-submit. No se admiten tokens en URL, storage del navegador,
headers bearer creados por JavaScript ni OAuth implicit flow.

## Modo mock

Los fixtures locales son solo para desarrollo y pruebas. Los despliegues live
deben usar `NOVA_BFF_URL` server-only y `NEXT_PUBLIC_REQUIRE_AUTH=true`.

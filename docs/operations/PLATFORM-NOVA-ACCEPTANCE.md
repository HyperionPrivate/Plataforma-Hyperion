---
documentType: runbook
status: draft
owner: platform-nova-operations
issue: HYP-FED-001
reviewDue: 2026-10-31
---

# Ensayo autenticado Platform ↔ NOVA

Este ensayo levanta dos proyectos Compose independientes y acredita la integración real entre el plano neutral y
la celda NOVA. Platform conserva Identity, Audit, Tenant y la administración neutral; NOVA conserva su BFF, core,
canales, documentos y datos. No fusiona los descriptores y no usa el fixture JWKS de readiness.

Los overlays provider-owned son:

- [Platform](../../infra/docker-compose.platform-nova.acceptance.yml): conecta únicamente `identity-service` y
  `audit-service` a la red compartida.
- [NOVA](../../infra/docker-compose.nova-platform.acceptance.yml): conecta únicamente `nova-bff` y
  `nova-core-service` a esa red.

El orquestador crea una red bridge externa con `--internal`. Cada workload conserva además la red `default` de su
propio proyecto. Los únicos aliases entre proyectos son `identity-service` y `audit-service`. Identity firma para
las audiences `platform-admin-bff` y `nova-bff` con el mismo issuer que valida NOVA; los tokens internos
`NOVA_BFF_TO_ACCESS_TOKEN` y `NOVA_TO_AUDIT_TOKEN` se generan por ejecución y se entregan sólo a sus dos extremos.

## Precondiciones

- Docker Engine y Docker Compose deben estar disponibles.
- El workspace debe poder construir los contextos provider-owned de Platform y NOVA.
- Docker Desktop debe tener espacio suficiente para ambos cierres. Los builds son secuenciales por servicio para
  evitar saturar BuildKit.
- No ejecute este ensayo contra bases, redes o proyectos persistentes. El script acepta únicamente sus nombres
  aleatorios bajo el namespace `hyperion-*-acceptance-<12 hex>`.

No copie los ejemplos de entorno ni cree una clave manual: el orquestador genera credenciales y una clave RSA de
2048 bits dentro de un directorio temporal único. Nunca ejecuta `docker compose config`, no imprime secretos y no
persiste el entorno completo.

## Ejecución explícita

Desde PowerShell, en la raíz del repositorio:

```powershell
$env:RUN_PLATFORM_NOVA_ACCEPTANCE = "1"
pnpm federation:platform-nova:acceptance
Remove-Item Env:RUN_PLATFORM_NOVA_ACCEPTANCE
```

La ejecución puede tardar varios minutos porque materializa ambos contextos y construye cada imagen de forma
secuencial. Los puertos publicados usan `127.0.0.1:0`; Docker elige un puerto libre y el orquestador rechaza
cualquier binding que no sea loopback.

## Flujo acreditado

1. Crea proyectos Platform/NOVA, red interna, directorio temporal, clave RSA e imágenes de migración Platform con
   tags únicos `acceptance-<runId>`.
2. Arranca Platform y deja que Identity cree el administrador inicial en la base Access efímera.
3. Hace login real por `platform-admin-bff`, valida los atributos emitidos de sus cookies aisladas, las reinyecta
   manualmente con el CSRF y obtiene el operador. Antes de crear el grant comprueba que la misma mutación sin CSRF
   responde 403.
4. Crea el tenant cliente mediante SQL transaccional parametrizado y luego otorga el grant NOVA exclusivamente por
   la API administrativa, con cookies y doble-submit CSRF.
5. Arranca NOVA contra el JWKS y el endpoint de login reales de Identity; hace login por `nova-bff` y verifica 403
   para un tenant ajeno y 404 para una ruta LUMEN. Después detiene Identity y comprueba `/v1/auth/me` con el JWT
   ya emitido y el JWKS cacheado localmente antes de recuperar el servicio.
6. Ejecuta bootstrap e import de un contacto NOVA.
7. Detiene el contenedor real de Audit durante el import, comprueba el outbox en
   `pending/network_error`, recupera Audit y espera `completed`.
8. Comprueba que el inbox y `platform.audit_events` contienen exactamente una fila lógica para el mismo `eventId`
   después de la recuperación.

El resultado exitoso es una sola línea JSON con identificadores opacos, contadores de intentos y
`logicalAuditRecords: 1`. No contiene contraseñas, tokens, claves ni configuración Compose.

Este ensayo integrado acredita caída real, retry, drain y unicidad observable para esa entrega. No inyecta pérdida
de ACK ni replay explícito, por lo que no acredita por sí solo la deduplicación ante duplicados. Ese caso se cubre
por separado en `scripts/autonomy/nova-audit-http.e2e.mjs`, que fuerza commit de Audit + ACK perdido, reenvía el
mismo cuerpo/eventId y exige respuestas 201/200 con una sola fila lógica.

Las cookies se capturan y reinyectan con un cliente HTTP sobre loopback. Se validan nombres, atributos `Secure`,
`HttpOnly`, `SameSite=Strict`, ausencia de `Domain` y el doble-submit CSRF funcional, pero no la aceptación de
`__Host-` por un navegador real ni el transporte TLS. Esa validación pertenece al smoke de navegador sobre el
hostname HTTPS de staging.

## Deuda HYP-FED-001

`tenant-service` expone hoy únicamente lectura y todavía no existe una API neutral de aprovisionamiento de tenant.
Por eso este ensayo crea **sólo** la fila `platform.tenants` mediante SQL parametrizado dentro de la base Access
desechable. No inserta operadores, membresías ni grants por SQL: el administrador inicial pertenece a Identity y el
grant NOVA se escribe mediante `PUT /v1/platform/grants/:operatorId/:tenantId/NOVA`.

Retire esta excepción cuando exista la operación provider-owned de aprovisionamiento. Hasta entonces, queda
prohibido reutilizar el bloque SQL fuera de este proyecto efímero o seleccionar tenants por slug conocido.

## Cleanup y diagnóstico

El bloque `finally` valida los nombres antes de ejecutar `down --volumes --remove-orphans --rmi local` para cada
proyecto. Después elimina únicamente los dos tags de migración, la red externa y el directorio temporal creados por
esa ejecución. Finalmente exige ausencia de contenedores, volúmenes, redes e imágenes con los labels de ambos
proyectos. El mismo cleanup se intenta si falla un build, una aserción HTTP/SQL o si se recibe `SIGINT`/`SIGTERM`.

Si el ensayo falla, conserve sólo el mensaje de fase y de error. No ejecute `docker system prune`, no borre por
glob y no vuelque `docker compose config` o el entorno para depurar. Revise recursos por el `runId` mostrado en los
nombres de proyecto y confirme que las postcondiciones del cleanup quedaron satisfechas antes de reintentar.

Las pruebas normales validan overlays, aliases, audiencias, orden secuencial, opt-in y guards de cleanup sin
levantar contenedores:

```powershell
node --test scripts/autonomy/platform-nova-acceptance.test.mjs
```

# Plataforma Hyperion

Hyperion es un monorepo en transición hacia celdas de producto federadas. El destino no es una aplicación
multiproducto: cada producto debe poder construir, migrar, desplegar, respaldar y restaurar su propia clausura sin
incorporar fuentes ni credenciales de los demás.

Este monorepo TypeScript es la fuente de verdad versionada para el código, la infraestructura local y las
decisiones arquitectónicas de la plataforma.

## Propósito y productos

El plano neutral se limita a Access/SSO y aprovisionamiento, Audit asíncrono y administración de usuarios, tenants,
grants y catálogo. La administración neutral puede enlazar a otros orígenes, pero no contiene flujos de producto.
El portafolio de software tiene tres productos:

- **PULSO IRIS**: agenda, conversaciones, operación y automatización para atención al cliente. **SOFÍA** es su
  agente conversacional. Prompt Flow, Knowledge, Integration y WhatsApp pertenecen a esta celda mientras solo la
  consuman.
- **LUMEN**: flujos clínicos asistidos, con revisión humana y datos sintéticos en su demostración actual.
- **NOVA**: campañas de contacto proactivo por voz y WhatsApp. Voice, LIWA y Documents son componentes NOVA;
  Coopfuturo es un cliente/tenant y conserva su consola específica.

Neutral Dialer continúa como sistema externo. La consultoría y otros servicios profesionales pertenecen al
portafolio comercial, pero no se modelan como productos técnicos ni microservicios.

La plataforma está diseñada para incorporar nuevos productos mediante contratos HTTP o eventos versionados,
propiedad explícita de datos y despliegues por servicio.

## Arquitectura actual

- Gateway HTTP global como fachada temporal de compatibilidad; el destino es routing por hostname hacia BFFs sin
  lógica de dominio compartida.
- Catorce runtimes con base de datos, tres consolas de producto y una consola administrativa neutral ya separadas,
  además de la consola específica Coopfuturo y el edge legado de redirects pendiente de retirar.
- Contratos provider-owned separados para plataforma, Audit, NOVA, LUMEN y PULSO; el paquete agregado heredado
  continúa únicamente durante la ventana de compatibilidad N/N−1.
- PostgreSQL compartido como clúster de transición, no como unidad de migración: la base heredada conserva
  `001–046` para compatibilidad, mientras Access, Audit, NOVA, LUMEN y PULSO tienen bases lógicas, migradores,
  ledgers, roles y readiness provider-owned. PULSO crea `hyperion_pulso`; el detector de límites efectivo reporta
  **0 grupos de deuda preexistente** (`pnpm architecture:check`), y el cutover/recuperación sobre el entorno
  objetivo productivo siguen pendientes aunque el drill PostgreSQL 001–016 ya tiene recibo local verificado.
- Outbox/inbox en los handoffs durables implementados: mensajes inbound, resultados de entrega Channel → PULSO,
  procesamiento PULSO → SOFÍA y auditorías de Channel, PULSO y SOFÍA → Audit. PULSO encola la auditoría
  dentro de la misma transacción que la mutación relevante y Audit aplica el evento con inbox idempotente.
- LUMEN con esquema, readiness, proyecciones, inbox y outbox propios, sin SQL de runtime sobre Access o PULSO.
- NOVA con esquemas/roles separados para core, Voice, LIWA y Documents, `nova-bff`, `nova-console`, consola
  Coopfuturo, contexto Docker y manifiesto de release propios; todavía convive con el gateway y el stack completo
  de compatibilidad.
- PULSO con `pulso-console`, `pulso-bff`, contexto Docker allowlisted, Compose y migrador propios. Los seis
  runtimes con base de datos validan `pulso_iris.schema_version`; SOFÍA accede al dominio PULSO mediante contratos
  owner-owned y Access ya no ejecuta un trigger de inicialización PULSO. El stack global sigue disponible sólo
  durante el cutover transicional. La deuda restante está en
  [`docs/catalogs/debt.v1.json`](docs/catalogs/debt.v1.json) (`findingGroups=0` en el baseline efectivo).
- Los clientes web no conservan un bearer compartido en `localStorage`: usan requests same-origin con cookies de
  sesión aisladas por origen; NOVA y la administración neutral añaden protección CSRF explícita en sus BFF.
- Runtimes con readiness HTTP real, cierre drenado y confianza de proxy desactivada salvo IP/CIDR explícito.
- Llamadas HTTP internas autenticadas por vínculo productor→consumidor: cada receptor valida conjuntamente la
  identidad `x-hyperion-caller` y una credencial exclusiva de ese vínculo, sin token global reutilizable.
- Barreras de CI sobre SQL literal de runtimes, todos los migradores descubiertos, claves foráneas, objetos,
  PL/pgSQL, triggers, `SECURITY DEFINER` y acoplamientos de arranque, además de smokes del stack base y del overlay
  JetStream. El SQL dinámico continúa sujeto a políticas fail-closed y revisión adicional.

> **Madurez arquitectónica:** Hyperion está en una migración incremental hacia microservicios autónomos. Las
> celdas provider-owned todavía conviven con el clúster y la cadena globales de compatibilidad; el cutover, los
> drills de recuperación y la extracción física no están completos. La deuda restante está registrada en el
> [catálogo versionado](docs/catalogs/debt.v1.json) y el baseline arquitectónico.

El transporte predeterminado de eventos durables sigue siendo HTTP. El overlay JetStream es opt-in y actualmente
se evalúa como piloto de un nodo; no representa alta disponibilidad ni debe habilitarse en producción sin
réplicas, TLS interno, observabilidad, redrive auditado y recuperación probada. Esta limitación describe un
componente concreto y no la finalidad general de la plataforma.

## Estructura del repositorio

| Ruta        | Responsabilidad                                                              |
| ----------- | ---------------------------------------------------------------------------- |
| `apps/`     | Gateway de compatibilidad, BFFs y consolas con entrypoints independientes.   |
| `services/` | Runtimes de dominio y adaptadores, asignados a una celda en el catálogo.     |
| `packages/` | Contratos provider-owned y capacidades técnicas transicionales.              |
| `infra/`    | Docker Compose, imágenes y configuración de NATS durante la convivencia.     |
| `releases/` | Manifiestos por celda y catálogos de componentes fijados por versión/digest. |
| `scripts/`  | Controles arquitectónicos, documentales, CI, pruebas E2E y operaciones.      |
| `docs/`     | Arquitectura, catálogos versionados, decisiones y procedimientos operativos. |

## Desarrollo

Requisitos:

- Node.js 22 o superior.
- pnpm 11.7 mediante Corepack.
- Docker con Docker Compose para el stack completo.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm dev:gateway
pnpm dev:services
pnpm --filter @hyperion/nova-bff dev
pnpm --filter @hyperion/nova-console dev
pnpm --filter @hyperion/lumen-bff dev
pnpm --filter @hyperion/lumen-console dev
pnpm --filter @hyperion/pulso-bff dev
pnpm --filter @hyperion/pulso-console dev
pnpm --filter @hyperion/platform-admin-bff dev
pnpm --filter @hyperion/platform-admin-console dev
```

`dev:gateway` y `dev:services` conservan el stack de compatibilidad. No usar `dev:web` como entrada de una consola
multiproducto nueva; cada consola debe ejecutarse contra el BFF de su propia celda.

Para preparar el archivo local de entorno:

```bash
# Bash
cp .env.example .env
```

```powershell
# PowerShell
Copy-Item .env.example .env
```

Antes de iniciar Compose se deben sustituir todos los placeholders, incluidos el secreto administrador, las
credenciales HTTP separadas por vínculo `*_TO_*_TOKEN`, `GATEWAY_OPERATOR_ASSERTION_KEY`,
`WHATSAPP_PHONE_HASH_KEY` y las contraseñas PostgreSQL
de servicio. Ningún valor puede reutilizarse para otro propósito y las credenciales reales nunca se guardan en
Git.

```bash
docker compose --env-file .env -f infra/docker-compose.yml up --build
```

Los datasets sintéticos nunca resuelven clientes por nombre o slug. En un entorno local, el operador debe pasar
el UUID opaco provisionado por Access de forma explícita:

```bash
PULSO_DEMO_TENANT_ID=<tenant-uuid> pnpm db:seed:demo
LUMEN_DEMO_TENANT_ID=<tenant-uuid> pnpm db:seed:lumen-demo
```

Compose hace cumplir la secuencia `migrations` → `db-role-bootstrap` → runtimes con base de datos. El stack base
usa el transporte HTTP reversible y no incluye NATS. La activación y el ensayo aislado de JetStream están
documentados por separado; el overlay continúa siendo un piloto, aunque CI también comprueba que puede
construirse y arrancar.

La definición standalone de PULSO se valida sin arrancar contenedores con:

```bash
node scripts/docker/generate-cell-contexts.mjs --cell pulso
docker compose --env-file infra/pulso.env.example -f infra/docker-compose.pulso.yml config --quiet
```

`infra/pulso.env.example` contiene únicamente placeholders. La presencia del Compose y de los tres one-shots
`pulso-database-bootstrap` → `pulso-migrations` → `pulso-role-bootstrap` no acredita por sí sola un despliegue ni
un restore ejecutado.

## Documentación

- [Catálogos versionados de productos, servicios y deuda](docs/catalogs/README.md)
- [Evidencia y pendientes del primer corte federado](docs/FEDERATION-ACCEPTANCE.md)
- [Productos y estados de cobertura](docs/products/README.md)
- [Especificación de PULSO IRIS y SOFÍA](docs/products/PULSO-IRIS.md)
- [Especificación de LUMEN](docs/products/LUMEN.md)
- [Matriz de trazabilidad de requisitos](docs/products/REQUIREMENTS-TRACEABILITY.md)
- [Arquitectura general](docs/ARCHITECTURE.md)
- [Evolución hacia microservicios autónomos](docs/architecture/AUTONOMOUS-MICROSERVICES.md)
- [Decisiones arquitectónicas](docs/architecture/decisions/README.md)
- [Roles PostgreSQL por contexto](docs/architecture/POSTGRESQL-SERVICE-ROLES.md)
- [Operación y producción (no vigente hasta revalidación)](docs/PRODUCTION.md)
- [Aislamiento NATS y JetStream](infra/nats/README.md)
- [Canal privado de WhatsApp](services/whatsapp-channel-service/README.md)

## Alcance operativo

El repositorio contiene software desplegable y procedimientos versionados, pero no demuestra por sí solo que un
commit determinado esté activo en un ambiente. El estado de cada despliegue debe identificarse mediante su
commit, imágenes y registro operativo correspondiente.

No se versionan secretos, sesiones de proveedores, audio, datos clínicos reales ni backups.

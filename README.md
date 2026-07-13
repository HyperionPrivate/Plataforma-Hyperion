# Plataforma Hyperion

Hyperion es una plataforma multiproducto para construir y operar soluciones de automatización, inteligencia
artificial y gestión de procesos sobre un núcleo común. Su objetivo es que cada producto pueda evolucionar y
desplegarse con contratos, datos y operación claramente delimitados, sin convertir la plataforma completa en un
monolito.

Este monorepo TypeScript es la fuente de verdad versionada para el código, la infraestructura local y las
decisiones arquitectónicas de la plataforma.

## Propósito y productos

El núcleo de Hyperion proporciona acceso, tenants, gateway, auditoría, integraciones, conocimiento, flujos de
prompts y una consola operativa compartida. Sobre ese núcleo viven dos productos de software con límites propios:

- **PULSO IRIS**: agenda, conversaciones, operación y automatización para atención al cliente. **SOFÍA** es su
  agente conversacional y de ejecución controlada; opera en un contexto técnico separado, pero no es un producto
  comercial independiente.
- **LUMEN**: flujos clínicos asistidos, con revisión humana y datos sintéticos en su demostración actual.

Canales e integraciones son capacidades compartidas de la plataforma. La consultoría y otros servicios
profesionales pertenecen al portafolio comercial, pero no se modelan como microservicios.

La plataforma está diseñada para incorporar nuevos productos mediante contratos HTTP o eventos versionados,
propiedad explícita de datos y despliegues por servicio.

## Arquitectura actual

- Gateway HTTP como entrada pública prevista, sin dependencia de arranque sobre los productos.
- Diez runtimes de servicio y una consola web, con targets Docker independientes.
- Contratos compartidos TypeScript/Zod, validaciones de contratos y controles arquitectónicos en CI.
- PostgreSQL compartido como etapa de transición, con identidades y privilegios restringidos por contexto.
- Outbox/inbox para efectos asíncronos y un primer flujo durable Channel -> PULSO -> SOFÍA -> Audit.
- LUMEN con esquema, readiness, proyecciones, inbox y outbox propios, sin SQL de runtime sobre Access o PULSO.
- Barreras de CI que impiden aumentar accesos SQL, claves foráneas cruzadas y acoplamientos de arranque ya
  inventariados.

> **Madurez arquitectónica:** Hyperion está en una migración incremental hacia microservicios autónomos. El
> clúster PostgreSQL y la cadena principal de migraciones todavía son compartidos, y existe deuda heredada
> registrada en el baseline arquitectónico.

El transporte predeterminado de eventos durables sigue siendo HTTP. El overlay JetStream es opt-in y actualmente
se evalúa como piloto de un nodo; no representa alta disponibilidad ni debe habilitarse en producción sin
réplicas, TLS interno, observabilidad, redrive auditado y recuperación probada. Esta limitación describe un
componente concreto y no la finalidad general de la plataforma.

## Estructura del repositorio

| Ruta        | Responsabilidad                                       |
| ----------- | ----------------------------------------------------- |
| `apps/`     | Gateway y consola web.                                |
| `services/` | Runtimes de dominio y adaptadores.                    |
| `packages/` | Contratos y capacidades técnicas compartidas.         |
| `infra/`    | Docker Compose, imágenes y configuración de NATS.     |
| `scripts/`  | Controles arquitectónicos, pruebas E2E y operaciones. |
| `docs/`     | Arquitectura, decisiones y procedimientos operativos. |

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
pnpm dev:web
```

Para preparar el archivo local de entorno:

```bash
# Bash
cp .env.example .env
```

```powershell
# PowerShell
Copy-Item .env.example .env
```

Antes de iniciar Compose se deben sustituir todos los placeholders, incluidos el secreto administrador, el token
interno y las contraseñas PostgreSQL de servicio. Las credenciales reales nunca se guardan en Git.

```bash
docker compose --env-file .env -f infra/docker-compose.yml up --build
```

El stack base usa el transporte HTTP reversible y no incluye NATS. La activación y el ensayo aislado de
JetStream están documentados por separado.

## Documentación

- [Productos y estados de cobertura](docs/products/README.md)
- [Especificación de PULSO IRIS y SOFÍA](docs/products/PULSO-IRIS.md)
- [Especificación de LUMEN](docs/products/LUMEN.md)
- [Matriz de trazabilidad de requisitos](docs/products/REQUIREMENTS-TRACEABILITY.md)
- [Arquitectura general](docs/ARCHITECTURE.md)
- [Evolución hacia microservicios autónomos](docs/architecture/AUTONOMOUS-MICROSERVICES.md)
- [Decisiones arquitectónicas](docs/architecture/decisions/README.md)
- [Roles PostgreSQL por contexto](docs/architecture/POSTGRESQL-SERVICE-ROLES.md)
- [Operación y producción](docs/PRODUCTION.md)
- [Aislamiento NATS y JetStream](infra/nats/README.md)
- [Canal privado de WhatsApp](services/whatsapp-channel-service/README.md)

## Alcance operativo

El repositorio contiene software desplegable y procedimientos versionados, pero no demuestra por sí solo que un
commit determinado esté activo en un ambiente. El estado de cada despliegue debe identificarse mediante su
commit, imágenes y registro operativo correspondiente.

No se versionan secretos, sesiones de proveedores, audio, datos clínicos reales ni backups.

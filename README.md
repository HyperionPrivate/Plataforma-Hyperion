# Plataforma Hyperion

Base de producto para Hyperion con arquitectura de microservicios. Esta carpeta es la superficie de desarrollo real; los documentos viejos quedan solo como referencia.

## Que contiene

- Gateway HTTP para exponer la plataforma.
- Servicios separados para identidad, tenants, agentes, flujos, conocimiento, integraciones y auditoria.
- Contratos compartidos TypeScript/Zod.
- PostgreSQL como almacenamiento inicial.
- Consola web operativa para ver estado real de servicios.
- Docker Compose listo para variables reales de produccion.

## Comandos

```bash
pnpm install
pnpm check
pnpm dev:gateway
pnpm dev:web
```

Para levantar todo con contenedores:

```bash
copy .env.example .env
docker compose -f infra/docker-compose.yml up --build
```

No se deben guardar credenciales reales en Git.

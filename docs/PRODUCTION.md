# Produccion

Este repo esta preparado para datos reales, no para demos con datos inventados.

## Secretos

- No se guardan claves reales en Git.
- Toda clave compartida por chat, correo o canal no secreto debe rotarse antes de dejarla como acceso permanente.
- `.env.example` solo muestra nombres de variables.
- `INTERNAL_SERVICE_TOKEN`, `POSTGRES_PASSWORD` y credenciales de proveedores deben vivir fuera del repositorio.

## VPS

El VPS debe quedar con acceso por llave SSH, firewall activo y login root por password deshabilitado despues del primer aprovisionamiento. El despliegue debe usar las variables reales del ambiente y no valores de ejemplo.

## Puertos

- Gateway: `${API_GATEWAY_HOST_PORT:-8080}`.
- Consola web: `${WEB_CONSOLE_HOST_PORT:-3000}`.
- PostgreSQL no se publica al host; solo queda disponible dentro de la red Docker.

## Backup antes de migraciones

Antes de aplicar cualquier migracion nueva en el VPS se debe crear un dump comprimido de PostgreSQL fuera de Git:

```bash
mkdir -p /opt/hyperion-platform/backups
docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  | gzip > "/opt/hyperion-platform/backups/hyperion-$(date +%Y%m%d-%H%M%S).sql.gz"
```

Luego se verifica el log del servicio `migrations`, se despliega y se validan endpoints publicos.

## Comando base

```bash
docker compose -f infra/docker-compose.yml up --build -d
```

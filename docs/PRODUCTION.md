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

- `8080`: gateway.
- `3000`: consola web.
- `5432`: PostgreSQL ligado a `127.0.0.1` por defecto.

## Comando base

```bash
docker compose -f infra/docker-compose.yml up --build -d
```

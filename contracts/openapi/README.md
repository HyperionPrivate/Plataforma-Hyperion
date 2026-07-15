# OpenAPI snapshots

Cada microservicio expone su OpenAPI en runtime (`/openapi.json`).

Cuando un contrato HTTP se estabilice, copiar el snapshot aquí como:

```text
contracts/openapi/<service>-v1.json
```

No hay cliente Python compartido: cada servicio genera o escribe su propio cliente HTTP si lo necesita.

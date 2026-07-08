# Arquitectura

La plataforma se construye como monorepo TypeScript con microservicios HTTP. El gateway es la unica entrada publica prevista; los servicios de dominio quedan en red interna.

## Servicios

| Puerto | Servicio | Responsabilidad |
| --- | --- | --- |
| 8080 | api-gateway | Entrada publica, catalogo y health agregado. |
| 8081 | identity-service | Operadores, autenticacion, sesiones y permisos. |
| 8082 | tenant-service | Clientes, organizaciones y configuracion por tenant. |
| 8083 | agent-service | Agentes IA, productos, canales y ciclo operacional. |
| 8084 | prompt-flow-service | Prompts, versiones y flujos conversacionales. |
| 8085 | knowledge-service | Fuentes de conocimiento e ingesta. |
| 8086 | audit-service | Eventos, bitacora y evidencia operacional. |
| 8087 | integration-service | Voz, WhatsApp, GLPI, ERP, activos y conectores. |
| 8088 | pulso-iris-service | Producto PULSO IRIS: Sofia, agenda, handoff y RPA para CEDCO. |

## Datos

PostgreSQL arranca con el esquema core `platform` y el esquema de producto `pulso_iris` (sites, professionals, payers, administrative_patients, conversations, messages, appointments, rpa_actions, handoffs, operational_kpi_snapshots). No hay datos de muestra. Los productos reales se cargan cuando exista la informacion operativa real de cada cliente.

## Despliegue

Una sola imagen multi-stage para los servicios Node (produccion sin devDependencies, proceso como usuario `node`) y una imagen nginx sin privilegios para la consola web estatica. Cada servicio expone `/health` y `/ready`; el compose usa healthchecks y `depends_on: service_healthy` para ordenar el arranque.

## Producto inicial

La plataforma primero entrega el nucleo: identidad, tenants, agentes, integraciones y auditoria. CEDCO R02 se monta encima del `agent-service`, `prompt-flow-service`, `knowledge-service` e `integration-service`.

## Regla para agregar productos

1. Registrar el producto en `platform.products`.
2. Crear tenants y operadores reales.
3. Crear agentes por tenant en `platform.agents`.
4. Versionar flujos en `platform.prompt_flows`.
5. Conectar fuentes reales mediante `platform.knowledge_sources` e `platform.integrations`.
6. Registrar cambios y operaciones en `platform.audit_events`.

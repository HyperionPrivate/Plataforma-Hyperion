# QA — Ops UI NOVA

Checklist por pantalla. Estados obligatorios: loading, empty, error, success/notice.

| Pantalla              | Loading | Empty     | Error  | Acciones clave                          | Roles                   |
| --------------------- | ------- | --------- | ------ | --------------------------------------- | ----------------------- |
| Dashboard             | ✓       | KPIs en 0 | banner | Bootstrap + funnel/analytics charts     | todos                   |
| Campañas              | ✓       | empty     | banner | Wizard 5 pasos / enroll / start / pause | admin/supervisor        |
| Conversaciones        | ✓       | empty     | banner | Claim + reply 24h                       | admin/supervisor/asesor |
| Revisión post-llamada | ✓       | empty     | banner | Approve / skip reviews                  | admin/supervisor        |
| CRM                   | ✓       | empty     | banner | Kanban por etapa + tipificación         | admin/supervisor        |
| Handoff por sede      | ✓       | empty     | banner | Claim filtrado por sede                 | admin/supervisor/asesor |
| Segmentación          | ✓       | empty     | banner | Score contact / leads                   | admin/supervisor        |
| Importar              | —       | —         | banner | CSV/JSON → contacts/import              | admin/supervisor        |
| Reportes              | —       | —         | —      | Export JSON/CSV local                   | admin/supervisor        |
| Laboratorio           | ✓       | empty     | banner | Call + eligibility + reconciliación     | admin/supervisor        |
| Configuración         | ✓       | —         | banner | Catálogo + flags mock/real              | admin                   |

## No-regresión

- Nav PULSO IRIS / LUMEN sin cambios de rutas existentes.
- Capabilidades `view:nova` / `write:nova` no otorgan acceso a config clínica LUMEN.
- Copy en español CO; sin PII en toasts ni consola.

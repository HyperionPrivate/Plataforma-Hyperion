## Objetivo

<!-- Explica el problema y el resultado observable. Enlaza el issue o ADR aplicable. -->

## Celda y alcance

- Celda: <!-- platform | nova | lumen | pulso | transversal -->
- Componentes afectados:
- Fuera de alcance:

## Riesgo y reversión

- Riesgo operativo:
- Compatibilidad de contratos (N/N-1):
- Migraciones, respaldo y restauración:
- Plan de reversión:

## Evidencia

<!-- Incluye comandos, resultados de pruebas, capturas o telemetría. -->

## Checklist del autor

- [ ] El cambio tiene un alcance único y no introduce imports, rutas, endpoints, navegación ni datos de otra celda.
- [ ] Añadí o actualicé pruebas proporcionales al riesgo (lint, tipos, unitarias, integración, imagen y/o smoke).
- [ ] Los contratos siguen siendo propiedad del proveedor y mantienen la compatibilidad N/N-1 declarada.
- [ ] Las migraciones y el rollback pertenecen a la celda afectada y no requieren credenciales de otros productos.
- [ ] No añadí secretos, tokens ni datos sensibles; tampoco secretos en query strings ni webhooks HTTP públicos.
- [ ] Revisé permisos, autenticación, aislamiento de tenant/producto y manejo de datos personales.
- [ ] Actualicé documentación, ADR, runbook o manifiesto de release cuando corresponde.
- [ ] Las acciones de GitHub nuevas o modificadas están fijadas a un SHA completo e inmutable.
- [ ] Solicité revisión humana al CODEOWNER y resolveré todas las conversaciones antes de fusionar.

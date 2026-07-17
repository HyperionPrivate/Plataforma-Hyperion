# ADR-0005: Retiro de deuda de fronteras heredada

- Estado: Aceptada
- Fecha: 2026-07-16

## Contexto

Hyperion arrastra excepciones en `boundary-baseline.json` (SQL cruzado SOFÍA→PULSO,
Integration→PULSO, FKs a `platform.tenants`, cadena única de migraciones). NOVA y LUMEN
nacen sin esa deuda y son la referencia.

## Decisión

1. Cada corrección de deuda **retira su entrada del baseline en el mismo cambio**.
2. Orden de ataque:
   1. Cortar lecturas SQL cruzadas listadas en el baseline (empezar por Integration→PULSO).
   2. Convertir FKs a `platform.tenants` en identificadores lógicos (proyecciones locales).
   3. Separar cadena de migraciones por servicio (expandir el patrón `*.schema_version`).
   4. Formalizar transporte HTTP durable como default; JetStream opt-in documentado.
3. NOVA no puede introducir nuevas entradas al baseline.

## Consecuencias

- El progreso se mide por reducción del baseline, no por ADRs futuros.
- Los cambios son pequeños y verificables con `check-boundaries`.

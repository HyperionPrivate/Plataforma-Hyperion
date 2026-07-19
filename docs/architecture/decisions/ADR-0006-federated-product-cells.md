# ADR-0006: Transición a células de producto federadas

- Estado: Aceptada
- Fecha: 2026-07-17
- Reemplaza parcialmente: [ADR-0001](ADR-0001-product-service-boundaries.md) y
  [ADR-0003](ADR-0003-nova-product-boundaries.md)

## Contexto

Hyperion separó conceptualmente producto comercial y contexto técnico, pero la implementación todavía coordina
los productos mediante una consola Vite multiproducto, un gateway con conocimiento de dominios, contratos y
migraciones globales, builds recursivos y una entrega común. Ocultar rutas con una variable de build no crea una
frontera: el artefacto, su grafo de dependencias y su ciclo de liberación continúan incluyendo capacidades de
otros productos.

NOVA debe ser la primera célula que pueda construirse, migrarse, desplegarse, recuperarse y operar sin PULSO IRIS
ni LUMEN. La transición debe conservar el servicio y permitir convivencia temporal, pero su destino no es un
monorepo multiproducto permanente: es una federación con un repositorio y un ciclo de entrega por producto, más
un plano neutral mínimo de plataforma.

## Decisión

### Topología objetivo

| Célula     | Repositorio objetivo | Componentes y responsabilidades propias                                                                                                                 |
| ---------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plataforma | `hyperion-platform`  | Access/SSO, aprovisionamiento de tenants, operadores y grants; Audit asíncrono; `platform-admin-console` neutral.                                       |
| NOVA       | `nova`               | `nova-console`, `coopfuturo-console`, `nova-bff`, core, Voice, LIWA y Documents; contratos, migraciones, datos, CI y releases propios.                  |
| LUMEN      | `lumen`              | `lumen-console`, `lumen-bff`, servicio clínico, datos, contratos, migraciones, CI y entrega propios.                                                    |
| PULSO IRIS | `pulso-iris`         | `pulso-console`, `pulso-bff`, core, SOFÍA, Prompt Flow, Knowledge, Integration y WhatsApp; contratos, migraciones, datos, CI y releases propios.        |
| Externo    | Repositorio externo  | Neutral Dialer v3, fuera de los repositorios Hyperion y accedido únicamente mediante Voice según [ADR-0004](ADR-0004-neutral-dialer-external-voice.md). |

`coopfuturo-console` continúa siendo una aplicación específica del cliente dentro de NOVA. No se renombra ni se
convierte en la consola genérica de NOVA.

### Fronteras de interfaz y borde

1. Se prohíbe una consola _customer-facing_ multiproducto. Cada aplicación tiene entrypoint, router, estilos,
   cliente API, origen, imagen y release de una sola célula.
2. Se prohíbe `VITE_PRODUCT=all`. El filtrado por `VITE_PRODUCT` no es una frontera aceptable y se retirará al
   extraer las consolas.
3. Una aplicación no puede incluir navegación, contexto de sesión, contratos, endpoints, CSS ni chunks de otro
   producto. Puede enlazar a otro origen sin representar sus flujos.
4. `platform-admin-console` se limita a usuarios, tenants, grants y catálogo de productos. No muestra ni
   orquesta campañas, citas, historias clínicas, conversaciones u otros flujos de producto.
5. Cada producto expone un BFF con una allowlist de rutas y dependencias de su propia célula. El gateway global
   queda solamente como fachada temporal de compatibilidad; el destino es routing por hostname sin lógica de
   dominio ni conocimiento del catálogo completo de servicios.
6. Las sesiones de navegador se aíslan por origen mediante cookies `HttpOnly`, `Secure` y `SameSite`. Ninguna
   consola nueva conserva un bearer común en `localStorage`.

### Propiedad de capacidades y artefactos

- Voice, LIWA y Documents son componentes de NOVA mientras no exista un segundo consumidor real. Una intención
  de reutilización no los convierte en plataforma; un cambio de propietario requiere evidencia de consumo y un
  ADR posterior.
- SOFÍA, Prompt Flow, Knowledge, Integration y WhatsApp pertenecen a PULSO IRIS mientras solo soporten ese
  producto. Sus límites técnicos pueden seguir siendo desplegables sin cambiar su pertenencia comercial.
- Audit permanece neutral y asíncrono, fuera del camino crítico de las mutaciones de producto. Access conserva
  SSO y aprovisionamiento, no lógica de los dominios.
- Los contratos son propiedad del proveedor y se publican por plataforma/autenticación, auditoría, NOVA, LUMEN
  o PULSO con SemVer y compatibilidad N/N-1. Ningún catálogo cerrado obliga a una célula a conocer todos los
  productos.
- Cada célula posee sus migradores, roles, ledgers, bootstrap, imágenes y manifiesto de release. Compartir
  temporalmente un clúster PostgreSQL solo es admisible con bases lógicas, credenciales, migraciones, backup y
  restore independientes.
- Un Dockerfile se construye con la clausura del componente afectado. Se prohíben builds de imagen basados en
  `pnpm -r build` y contextos de NOVA que contengan fuentes de LUMEN o PULSO.

Access emitirá tokens breves verificables localmente por JWKS. La autorización normativa es la intersección
`tenantId × productId × roles/capabilities`; seleccionar un tenant mediante un slug hardcoded no es autorización.

### Transición sin caída

1. Las células se aíslan primero dentro del monorepo: frontend, BFF, contratos, migraciones, CI, imagen y release
   con límites comprobables. La convivencia puede usar redirects desde rutas antiguas y una fachada de gateway,
   ambos temporales y observados.
2. NOVA es el primer corte completo. Debe arrancar y migrar sin secretos, migraciones ni servicios de PULSO o
   LUMEN antes de extraerse.
3. Cuando NOVA cumpla los criterios de independencia, se extrae con historial preservado a un repositorio de la
   organización. Los contratos compartidos se publican en un registry y las dependencias `workspace:*` se
   sustituyen por versiones explícitas.
4. Se repite el patrón con LUMEN y finalmente PULSO IRIS. La extracción no autoriza accesos SQL cruzados: PULSO
   debe retirar los accesos SOFÍA/Integration/Channel mediante APIs, eventos y proyecciones locales.

Los redirects conservarán los parámetros existentes, especialmente los de LUMEN, y solo se retirarán después de
validar su telemetría. La fachada temporal no puede adquirir reglas nuevas de dominio.

## Criterios de verificación

Una célula no se considera independiente hasta demostrar que:

- se construye desde un contexto sin fuentes de otros productos y su bundle no contiene rutas, textos,
  endpoints, estilos ni chunks ajenos;
- un cambio exclusivo no ejecuta CI ni publica imágenes de las demás células;
- arranca, migra y opera con los otros productos apagados;
- una ruta ajena devuelve `404` y la ausencia del grant `tenantId × productId` devuelve `403`;
- despliega, revierte, respalda y restaura sin cambiar versiones ni migraciones de otra célula; y
- sus imports, contratos, Dockerfiles y migraciones pasan barreras que rechazan dependencias globales o
  cruzadas nuevas.

## Consecuencias

### Positivas

- Los artefactos y fallos quedan acotados al producto que los origina.
- La pertenencia de capacidades deja de decidirse por una reutilización hipotética.
- NOVA obtiene un camino verificable desde aislamiento interno hasta repositorio independiente.
- El plano neutral conserva aprovisionamiento y evidencia sin convertirse en un dominio multiproducto.

### Costos y obligaciones

- Durante la convivencia habrá redirects, fachada de compatibilidad y más de un modelo de sesión que deberán
  retirarse con telemetría y fechas explícitas.
- Los contratos, migraciones, backups, imágenes y releases dejan de coordinarse mediante una única versión.
- La federación exige registry, gobierno de compatibilidad N/N-1, CODEOWNERS y checks requeridos por repositorio.
- El stack completo permanece únicamente como prueba de integración en `main` y ejecución programada, no como
  unidad de release.

## Decisiones reemplazadas y vigentes

De [ADR-0001](ADR-0001-product-service-boundaries.md) siguen vigentes la separación entre producto comercial y
límite técnico, la clasificación de PULSO/LUMEN/SOFÍA y los criterios de autonomía. Quedan reemplazadas la
autorización de una consola que presente varios productos, la obligación del gateway como borde de dominio común
y la consecuencia que prescribe una consola compartida.

De [ADR-0003](ADR-0003-nova-product-boundaries.md) siguen vigentes NOVA como producto, Coopfuturo como primer
tenant, la propiedad lógica de datos y el método de cortes verticales. Quedan reemplazadas la clasificación de
Voice, LIWA y Documents como capacidades compartidas, la reutilización de `api-gateway`/`web-console` como
destino y el traslado de la interfaz Coopfuturo a la consola común.

[ADR-0004](ADR-0004-neutral-dialer-external-voice.md) permanece vigente: Neutral Dialer v3 es externo y Voice es
su único cliente dentro de Hyperion.

## Regla de revisión

Esta decisión se revisará si una capacidad adquiere un segundo consumidor real, si una restricción regulatoria
exige otra topología o si la evidencia operativa demuestra que un límite propuesto no puede desplegarse y
recuperarse de forma independiente. La revisión debe preservar una frontera explícita y no puede restablecer una
consola, gateway, migrador o release multiproducto como atajo transitorio sin owner, issue y vencimiento.

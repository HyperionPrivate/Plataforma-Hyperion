---
documentType: runbook
status: draft
owner: platform-edge
issue: HYP-FED-004
reviewDue: 2026-10-31
---

# Edge local por hostname

Esta plantilla sustituye la fachada de compatibilidad como destino de tráfico nuevo. Es una capa de routing
neutral: decide únicamente `hostname → consola/BFF` y no contiene catálogo, grants ni lógica de dominio.
`api-gateway` no participa: el Compose global lo excluye por defecto y sólo lo materializa al activar
explícitamente el perfil `legacy-gateway` (auth/plataforma residual; fachada de producto retirada — DEBT-020/032).
Ese perfil no es upstream del edge hostname.

| Host local por defecto | Consola exacta                | BFF same-origin exacto    | UI permitida                                          |
| ---------------------- | ----------------------------- | ------------------------- | ----------------------------------------------------- |
| `admin.hyperion.test`  | `platform-admin-console:8080` | `platform-admin-bff:8098` | `/`, operators, tenants, grants y catálogo            |
| `nova.hyperion.test`   | `nova-console:8080`           | `nova-bff:8095`           | `/`                                                   |
| `lumen.hyperion.test`  | `lumen-console:8080`          | `lumen-bff:8096`          | `/` y rutas propias bajo `/lumen`                     |
| `pulso.hyperion.test`  | `pulso-console:8080`          | `pulso-bff:8097`          | `/`, operación, conversaciones, agenda, RPA, BI, etc. |

Cada `/api/*` pierde el prefijo `/api` y llega exclusivamente al BFF de ese host. Las rutas UI no incluidas
en la allowlist del host responden `404`; un host desconocido también responde `404`. Las consolas reciben
solamente peticiones estáticas y no reciben cookies ni cabeceras de autorización.

El paso browser → BFF conserva la cookie de sesión, `X-CSRF-Token`, `X-Requested-With`, tipo de contenido y
cabeceras HTTP normales. Vacía cualquier bearer y todo contexto interno falsificable (`X-Hyperion-Caller`,
aserción de operador, operador/rol y variantes de tenant/producto); el BFF reconstruye ese contexto únicamente
desde la sesión validada.

## Callbacks públicos de NOVA

El host NOVA acepta únicamente estos request-targets canónicos:

- `POST /v1/liwa/webhooks`
- `POST /v1/voice/webhooks/dialer`
- `POST /v1/voice/webhooks/elevenlabs`

El control compara método y `request_uri` sin normalizar. Por eso `GET`, query strings, percent-encoding,
`/simulate`, rutas bajo `/api` y aliases históricos devuelven `404`. El proxy conserva el body sin
reescribirlo para que `nova-bff` valide HMAC sobre los mismos bytes. Desactiva el reenvío general de cabeceras,
elimina `Cookie`, `Authorization` y `Proxy-Authorization`, y añade sólo el secreto o las firmas propias de la
ruta. Además, reemplaza cualquier identidad de edge enviada por el cliente con
`X-Hyperion-Provider-Edge-Token` y `X-Hyperion-Provider-Client-Ip` propios. `nova-bff` valida el token en tiempo
constante y calcula la cuota por ruta e IP autenticada; una llamada directa, un token forjado o una IP inválida
fallan antes del upstream. El edge no conoce secretos de proveedor, sólo su credencial de workload compartida
con `nova-bff`.

`EDGE_TRUSTED_PROXY_CIDR` limita quién puede hacer autoritativo `X-Forwarded-For`. En local conserva
`127.0.0.1/32`, por lo que una cabecera enviada directamente no sustituye la IP del socket. En producción debe
contener únicamente el CIDR privado o `/32` del terminador TLS, y ese terminador debe sobrescribir (no anexar)
la IP de cliente. El edge elimina `X-Forwarded-For` antes de llegar al BFF y acompaña la IP ya saneada con
`NOVA_PROVIDER_EDGE_TOKEN`; ambas variables son obligatorias en los Compose del edge y NOVA standalone. El
Compose global de convivencia también entrega la credencial a `nova-bff` cuando se configura; si se omite, el BFF
sigue arrancando para tráfico de consola pero rechaza los callbacks provider-owned sin llegar al upstream.

## Ejecución local

El Compose aislado se conecta por defecto a `plataforma-hyperion_default`, la red del stack de convivencia.
No modifica ni amplía el Compose global. El primer comando arranca las células sin la fachada legacy:

```powershell
$env:NOVA_PROVIDER_EDGE_TOKEN = "<credencial-aleatoria-compartida-con-nova-bff>"
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.hostname-edge.yml up -d --build
Remove-Item Env:NOVA_PROVIDER_EDGE_TOKEN
```

Sólo para un ensayo de coexistencia del contrato bearer heredado, la fachada se habilita de forma explícita y
permanece ligada a loopback:

```powershell
docker compose --profile legacy-gateway -f infra/docker-compose.yml up -d --build api-gateway
```

No agregue `api-gateway` como upstream de `infra/docker-compose.hostname-edge.yml`.

La misma credencial debe estar disponible durante ambos `docker compose up`; no copie dos placeholders distintos
ni la sustituya por un secreto HMAC de proveedor.

Puede elegirse una red de ingress explícita con `HYPERION_CELL_INGRESS_NETWORK`. En el destino federado esa red
debe contener únicamente las cuatro consolas y los cuatro BFF; no debe dar acceso lateral a bases de datos ni a
servicios internos.

Los dominios `.test` son reservados y no se publican. Para una prueba sin editar el archivo hosts:

```powershell
curl.exe -H "Host: nova.hyperion.test" http://127.0.0.1:8080/healthz
curl.exe -H "Host: lumen.hyperion.test" http://127.0.0.1:8080/lumen/dictado
```

La configuración versionada liga el puerto a `127.0.0.1`; no es un listener público de producción.

## Responsabilidades externas

Esta capa no aprovisiona DNS, certificados ni WAF. Antes de exponerla fuera del host se requieren, en la
infraestructura aprobada:

1. DNS independiente por producto y para administración.
2. Terminación TLS con certificados válidos, red privada entre terminador y edge, y
   `EDGE_FORWARDED_PROTO=https` fijado por despliegue (nunca desde una cabecera del cliente). El mismo despliegue
   debe limitar `EDGE_TRUSTED_PROXY_CIDR` al terminador y rotar `NOVA_PROVIDER_EDGE_TOKEN` coordinadamente con
   `nova-bff`.
3. WAF/rate limiting, límites de origen y protección DDoS específicos para callbacks.
4. Observabilidad y alertas sobre `404`, `401/403`, latencia y errores upstream usando el log JSON del edge.
5. Resolución/reintento del proveedor y rotación de secretos validada en NOVA.

El despliegue público, DNS/TLS/WAF y el cutover de proveedores siguen siendo cambios externos con aprobación;
esta plantilla sólo entrega la política local comprobable.

## Verificación

La prueba estática valida el template y el modelo Compose sin iniciar servicios. La prueba de integración
opcional construye el contenedor, levanta upstreams efímeros y ejerce routing y políticas de cabeceras:

```powershell
node --test scripts/docker/hostname-edge.test.mjs
$env:RUN_HOSTNAME_EDGE_INTEGRATION='1'
node --test scripts/docker/hostname-edge.test.mjs
Remove-Item Env:RUN_HOSTNAME_EDGE_INTEGRATION
```

# Anti-patrones

Evitar estos patrones; rompen la autonomía o convierten el scaffold en monolito distribuido.

## God orchestrator

Meter reglas de funnel, tipificaciones, guiones WA y scoring dentro de `orchestrator`.  
**Correcto:** orchestrator solo coordina sagas; CRM/canales/satélites poseen el dominio.

## Database compartida

Una sola DB `coopfuturo` con schemas de todos.  
**Correcto:** `db_<servicio>` y acceso solo del dueño.

## Shared kernel Python

Paquete `coopfuturo-common` instalado en todas las imágenes.  
**Correcto:** schemas en `contracts/`; cada servicio genera o escribe su cliente.

## Llamadas cruzadas al Dialer

Que `whatsapp`, `crm` o `handoff` llamen al Dialer.  
**Correcto:** solo `orchestrator`.

## BFF gordo

Gateway FastAPI que agrega 10 servicios y concentra lógica.  
**Correcto:** Traefik como proxy; composición en clientes o sagas explícitas.

## Imports entre servicios

`from services.crm...` dentro de otro servicio.  
**Correcto:** HTTP o eventos.

## Saltar compliance

Despachar llamadas sin chequear opt-out / ventana.  
**Correcto:** saga pasa por `compliance` antes de `call.requested`.

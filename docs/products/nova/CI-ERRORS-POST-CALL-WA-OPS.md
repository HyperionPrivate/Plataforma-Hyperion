# CI errors en `feat/nova-post-call-wa-ops` — causa y prevención

Documento de referencia para futuros despliegues / PRs sobre main (versión limpia).
Surgió al subir el corte post-llamada WhatsApp + reply asesor (PR #20).

## Qué falló en GitHub Actions

| Check                          | Síntoma                            | Causa raíz                                                                               |
| ------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `lint` / `pnpm lint`           | `prettier --check` en ~10 archivos | Código y docs tocados sin pasar Prettier del monorepo                                    |
| `docker-build-and-smoke`       | `tsc` en `apps/web-console`        | Tipado incorrecto de `fetchChannelStatus`                                                |
| `n-minus-one-upgrade-rollback` | compose / postgres no levantan     | **Cascada**: el build Docker falla antes (mismo error TS); no era un bug N-1 de producto |

## 1. Prettier (`Code style issues found in 10 files`)

### Qué pasaba

CI ejecuta:

```bash
eslint . && prettier --check .
```

Si algún archivo del PR no coincide con la config Prettier del repo, el job falla aunque el runtime esté bien.

Archivos que fallaron en este PR (ejemplos):

- `apps/web-console/src/pages/NovaPage.tsx`
- `apps/web-console/src/pages/nova/NovaConversationsTab.tsx` (+ otras tabs Nova)
- `services/nova-core-service/src/routes.ts`
- `services/voice-channel-service/src/routes.ts`
- `docs/products/nova/POST-CALL-WHATSAPP.md` y otros docs

### Cómo evitarlo antes de push

Desde la raíz del monorepo:

```bash
pnpm format
# o solo los tocados:
pnpm exec prettier --write <archivos>
pnpm lint
```

No mezclar formateo “del editor local” con otra versión de Prettier distinta a la del `package.json` del repo.

## 2. TypeScript en web-console (`ChannelStatus`)

### Qué pasaba

`NovaConversationsTab` declara:

```ts
onChannelStatus?: (conversationId: string) => Promise<ChannelStatus>;
```

En `NovaPage`, el helper hacía:

```ts
async function fetchChannelStatus(conversationId: string) {
  return api.get(...); // api.get sin genérico → Promise<unknown>
}
```

`tsc --noEmit` (parte del `build` de `@hyperion/web-console`) rechaza asignar `Promise<unknown>` a `Promise<ChannelStatus>`.

Ese fallo rompe `pnpm -r build` dentro de las imágenes Docker → fallan smoke y checks que dependen del compose.

### Fix aplicado

```ts
async function fetchChannelStatus(conversationId: string): Promise<ChannelStatus> {
  return api.get<ChannelStatus>(novaPath(tenant.id, `conversations/${conversationId}/channel-status`));
}
```

Y exportar el tipo desde `apps/web-console/src/pages/nova/index.ts` para importarlo limpio en `NovaPage`.

### Cómo evitarlo

- Tipar siempre `api.get<T>` / `api.post<T>` cuando el valor se pasa a props tipadas.
- Antes de push: `pnpm --filter @hyperion/web-console build` (o al menos `tsc -p apps/web-console/tsconfig.json --noEmit`).

## 3. Fallos Docker / N-1 que “parecen” de infra

Si el log muestra el mismo error de `NovaPage.tsx` / `ChannelStatus` dentro de `RUN pnpm -r build`, **no** investigues primero el workflow N-1 ni el `docker-compose` de compatibilidad: arregla lint + typecheck; esos jobs suelen reventar en cascada.

Solo si lint y build pasan y N-1 sigue fallando, ahí sí revisar `.ci/n-minus-one/` y el fencing de postgres.

## Checklist mínimo antes de subir a GitHub (rama sobre main limpia)

1. Basarse en `main` sin cambiar la estructura del monorepo.
2. `pnpm format` (o Prettier en archivos tocados).
3. `pnpm lint`.
4. `pnpm --filter @hyperion/web-console build` (o `pnpm build` si el cambio toca varios packages).
5. Push a la feature branch; no pegar PATs en chats/issues — usar `gh auth login` o secretos del entorno.

## Seguridad

Si un Personal Access Token (`ghp_…`) se pegó en chat o logs, **revocarlo de inmediato** en GitHub → Settings → Developer settings → Personal access tokens, y crear uno nuevo solo en el credential helper / CI secrets.

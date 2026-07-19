# NOVA Coopfuturo Console

Aplicación específica de Coopfuturo dentro de la célula NOVA. No es la consola
NOVA genérica ni una consola multiproducto.

## Desarrollo

```bash
cd apps/coopfuturo-console
npm install
npm run dev
```

Abre `http://localhost:3000`; la raíz redirige a `/dashboard`.

## Datos y autenticación

- `NEXT_PUBLIC_API_MODE=mock` usa los fixtures locales para desarrollo visual.
- `NEXT_PUBLIC_API_MODE=live` usa únicamente el adapter same-origin `/pilot-core`.
- `NOVA_BFF_URL` es server-only y apunta al BFF provider-owned de NOVA.
- El navegador nunca recibe el JWT. NOVA BFF entrega una cookie de sesión
  host-only, `HttpOnly`, `Secure`, `SameSite=Strict`, más una cookie CSRF.

Consulta [MODULES.md](./MODULES.md) para el contrato de las pantallas y
[ARCHITECTURE.md](./ARCHITECTURE.md) para los límites de la célula.

## Verificación

```bash
npm run check
```

El check ejecuta lint estricto, TypeScript, pruebas de seguridad y el build
productivo.

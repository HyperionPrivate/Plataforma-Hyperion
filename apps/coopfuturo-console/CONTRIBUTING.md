# Contributing — NOVA Coopfuturo Console

- PascalCase componentes; camelCase variables/funciones
- Hooks con prefijo `use`
- Pages = composición; lógica de datos en `services/` + `hooks/`
- Nunca `fetch` en componentes presentacionales
- Sin colores hardcodeados en JSX (usar tokens CSS)
- Charts solo desde `@/components/charts` (no importar `recharts` en pages)
- Motion solo vía `@/lib/motion`
- Nunca persistir credenciales en URL, Web Storage ni código cliente
- Toda mutación live usa sesión same-origin y protección CSRF
- Copy según `design/COPY_GUIDE.md`; UX según `design/UX_RULES.md`

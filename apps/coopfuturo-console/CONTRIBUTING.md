# Contributing — PULSO Web

- PascalCase componentes; camelCase variables/funciones
- Hooks con prefijo `use`
- Pages = composición; lógica de datos en `services/` + `hooks/`
- Nunca `fetch` en componentes presentacionales
- Sin colores hardcodeados en JSX (usar tokens CSS)
- Charts solo desde `@/components/charts` (no importar `recharts` en pages)
- Motion solo vía `@/lib/motion`
- Copy según `design/COPY_GUIDE.md`; UX según `design/UX_RULES.md`

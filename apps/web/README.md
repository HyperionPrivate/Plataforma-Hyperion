# PULSO Web

Frontend de contactación inteligente (Coopfuturo) — Hyperion One.

## Desarrollo

```bash
cd apps/web
npm install
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000) → redirige a `/dashboard`.

## Modo API

```env
NEXT_PUBLIC_API_MODE=mock
```

`mock` (default): datos de `src/data/*.json`.  
`live`: stubs en `src/services/live` — conectar endpoints reales después.

Contrato por módulo / qué alimenta cada gráfica: **[MODULES.md](./MODULES.md)**.

## Rutas

| Ruta | Mockup |
|---|---|
| `/dashboard` | pulso_01 |
| `/campanas` | pulso_02 |
| `/conversaciones` | pulso_03 |
| `/crm` | pulso_04 |
| `/handoff` | pulso_05 |
| `/segmentacion` | pulso_06 |
| `/configuracion` | pulso_07 |
| `/reportes` | derivado |
| `/dev/kit` | design system preview |

## Demo script

1. Dashboard — KPIs, embudo, live feed  
2. Campañas — tabla + A/B  
3. Conversaciones — Tomar control  
4. Handoff — Atender  
5. CRM — cards por columna  

## Referencias

- Mockups: `../../design/mockups/`
- Spec: Documento Gestión Interna Hyperion

# Publica feat/architecture-foundation en GitHub y abre PR para auditoría.
# Ejecutar cuando haya red y autenticación válida:
#   powershell -ExecutionPolicy Bypass -File .\scripts\publish-architecture-foundation.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

Write-Host "==> Rama actual" -ForegroundColor Cyan
git checkout feat/architecture-foundation
git status -sb
git log -1 --oneline

Write-Host "==> Auth GitHub (si falla, corre: gh auth login)" -ForegroundColor Cyan
gh auth status

Write-Host "==> Push" -ForegroundColor Cyan
git push -u origin feat/architecture-foundation

Write-Host "==> Crear PR (si ya existe, muestra el URL)" -ForegroundColor Cyan
$existing = gh pr list --head feat/architecture-foundation --json url --jq ".[0].url" 2>$null
if ($existing) {
  Write-Host "PR ya existe: $existing" -ForegroundColor Green
  gh pr view --web
  exit 0
}

gh pr create `
  --base main `
  --head feat/architecture-foundation `
  --title "Architecture foundation: modular units, platform-kit, contracts, CI" `
  --body @"
## Summary
- Base arquitectónica ejecutable **sin lógica comercial** de producto.
- ``packages/platform-kit``, 4 unidades ``apps/*``, contratos, Compose endurecido, ADRs/C4/runbooks y CI.
- Stubs ``services/*`` solo con profile ``legacy-stubs``.

## Cómo auditar
1. Revisar diff vs ``main``.
2. Ver CI en Actions.
3. Local: ``make bootstrap && make test && make smoke``.

## External actions
- Rotar credencial LIWA histórica (comprometida).
- Confirmar owners reales (``docs/OWNERSHIP_REQUEST.md``).
- OIDC / Dialer / Core / LIWA según ``docs/EXTERNAL_BLOCKERS.md``.
"@

Write-Host "==> Listo. Abriendo PR..." -ForegroundColor Green
gh pr view --web

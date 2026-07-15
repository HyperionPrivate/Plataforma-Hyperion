# Política de ramas y revisiones

## Ramas

| Rama | Uso |
|---|---|
| `main` | Solo código mergeado vía PR. **Prohibido push directo.** |
| `feat/<tema>` | Funcionalidad |
| `fix/<tema>` | Corrección |
| `chore/<tema>` | Tooling / docs |
| `security/<tema>` | Endurecimiento / CVEs |

## Revisiones

- Mínimo **1 aprobación** de CODEOWNER del área tocada (cuando haya handles reales).
- CI verde obligatoria antes de merge.
- No force-push a `main`.
- Preferir PRs pequeños y desplegables por fase.

## Releases

- Tags semver cuando haya release de plataforma.
- Changelog en `CHANGELOG.md`.

# Legacy stubs — EXPERIMENTAL / DISABLED BY DEFAULT

These FastAPI stubs under `services/` remain until `apps/*` fully replaces them
and smoke tests prove parity for technical concerns.

- Do **not** implement product features here.
- Compose profile: `legacy-stubs` (not started by default).
- Business `501` routes are not part of the public architecture foundation surface.
  Use `apps/*` + `/_tech/*` for technical verification only.

See ADR-001 modular architecture and docs/architecture/.

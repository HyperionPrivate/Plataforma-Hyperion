from __future__ import annotations

import sys
from pathlib import Path

from platform_kit.alembic_path import prepend_alembic_import_paths


def test_container_shallow_path_does_not_raise(tmp_path: Path) -> None:
    """Simulate /app/alembic/env.py — must not IndexError on parents[N]."""
    alembic_dir = tmp_path / "app" / "alembic"
    alembic_dir.mkdir(parents=True)
    env_file = alembic_dir / "env.py"
    env_file.write_text("# stub\n", encoding="utf-8")
    added = prepend_alembic_import_paths(env_file)
    assert isinstance(added, list)


def test_monorepo_layout_finds_kit_src() -> None:
    repo = Path(__file__).resolve().parents[2]
    env_file = repo / "apps" / "pilot-core" / "alembic" / "env.py"
    kit = repo / "packages" / "platform-kit" / "src"
    assert env_file.exists()
    assert kit.is_dir()
    s = str(kit)
    while s in sys.path:
        sys.path.remove(s)
    added = prepend_alembic_import_paths(env_file)
    assert any(p.resolve() == kit.resolve() for p in added)

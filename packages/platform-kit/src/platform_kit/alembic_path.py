from __future__ import annotations

import sys
from pathlib import Path


def prepend_alembic_import_paths(env_file: Path) -> list[Path]:
    """
    Make app + platform-kit importable for Alembic in both layouts:

    - Monorepo: apps/<unit>/alembic/env.py  (kit under packages/platform-kit/src)
    - Container: /app/alembic/env.py        (platform_kit already installed; optional ../src)

    Never indexes parents[N] blindly — that raises IndexError in shallow container trees.
    """
    here = env_file.resolve()
    added: list[Path] = []

    app_src = here.parent.parent / "src"
    if app_src.is_dir():
        _prepend(app_src, added)

    for parent in here.parents:
        kit_src = parent / "packages" / "platform-kit" / "src"
        if kit_src.is_dir():
            _prepend(kit_src, added)
            break

    return added


def _prepend(path: Path, added: list[Path]) -> None:
    s = str(path)
    if s not in sys.path:
        sys.path.insert(0, s)
        added.append(path)

"""PostgreSQL isolation — requires live Postgres with init-databases.sh applied."""

from __future__ import annotations

import os

import asyncpg
import pytest

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_unit_cannot_connect_to_foreign_database() -> None:
    host = os.getenv("POSTGRES_HOST", "127.0.0.1")
    port = int(os.getenv("POSTGRES_PORT", "5432"))
    user = os.getenv("PILOT_CORE_DB_USER", "app_pilot_core")
    password = os.getenv("PILOT_CORE_DB_PASSWORD", "CHANGE_ME_pilot_core")

    # Own DB should work when stack is up
    try:
        conn = await asyncpg.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            database="db_pilot_core",
            timeout=3,
        )
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"postgres not available: {exc}")
    await conn.close()

    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        # Cross-DB connect should fail (no CONNECT grant)
        bad = await asyncpg.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            database="db_whatsapp",
            timeout=3,
        )
        await bad.close()

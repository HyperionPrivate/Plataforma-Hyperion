"""SQLite persistence for Ops product state — tenant-scoped."""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from platform_kit.correlation import tenant_id_ctx

_LOCK = Lock()
_DB_PATH: Path | None = None
_LEGACY_TENANT = "legacy"
# AUD-031: bump when ops SQLite shape changes; init_db refuses newer DBs.
SCHEMA_VERSION = 4


def data_root() -> Path:
    """Writable root for Ops SQLite + local docs (Docker-safe)."""
    env = (os.environ.get("PULSO_DATA_DIR") or "").strip()
    candidates: list[Path] = []
    if env:
        candidates.append(Path(env))
    with contextlib.suppress(IndexError, OSError):
        candidates.append(Path(__file__).resolve().parents[4] / ".local-secrets-tmp")
    candidates.extend([Path("/data"), Path("/tmp/pulso")])
    for root in candidates:
        try:
            root.mkdir(parents=True, exist_ok=True)
            probe = root / ".write_probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            return root
        except OSError:
            continue
    fallback = Path("/tmp/pulso")
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def db_path() -> Path:
    global _DB_PATH
    if _DB_PATH is None:
        _DB_PATH = data_root() / "pulso_ops.sqlite3"
    return _DB_PATH


def _connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def require_tenant(tenant_id: str | None = None) -> str:
    tid = (tenant_id if tenant_id is not None else tenant_id_ctx.get() or "").strip()
    if not tid:
        raise RuntimeError("tenant_id is required for ops_store operations")
    return tid


@contextmanager
def tenant_scope(tenant_id: str) -> Iterator[str]:
    tid = require_tenant(tenant_id)
    token = tenant_id_ctx.set(tid)
    try:
        yield tid
    finally:
        tenant_id_ctx.reset(token)


def init_db() -> None:
    with _LOCK:
        conn = _connect()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS campaigns (
                  id TEXT NOT NULL,
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, id)
                );
                CREATE TABLE IF NOT EXISTS contacts (
                  id TEXT NOT NULL,
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  phone TEXT NOT NULL,
                  first_name TEXT NOT NULL,
                  segment TEXT NOT NULL,
                  university TEXT,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, id)
                );
                CREATE TABLE IF NOT EXISTS dispatches (
                  id TEXT NOT NULL,
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, id)
                );
                CREATE TABLE IF NOT EXISTS handoffs (
                  id TEXT NOT NULL,
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, id)
                );
                CREATE TABLE IF NOT EXISTS crm_leads (
                  id TEXT NOT NULL,
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  funnel TEXT NOT NULL,
                  column_id TEXT NOT NULL,
                  tipificacion TEXT,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, id)
                );
                CREATE TABLE IF NOT EXISTS conversation_claims (
                  id TEXT NOT NULL,
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, id)
                );
                CREATE TABLE IF NOT EXISTS documents (
                  id TEXT NOT NULL,
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  contact_phone TEXT,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, id)
                );
                CREATE TABLE IF NOT EXISTS settings_kv (
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  key TEXT NOT NULL,
                  value TEXT NOT NULL,
                  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, key)
                );
                CREATE TABLE IF NOT EXISTS opt_outs (
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  phone TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, phone)
                );
                CREATE TABLE IF NOT EXISTS post_calls (
                  id TEXT NOT NULL,
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  conversation_id TEXT,
                  phone TEXT,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, id)
                );
                CREATE TABLE IF NOT EXISTS conversation_threads (
                  id TEXT NOT NULL,
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, id)
                );
                CREATE TABLE IF NOT EXISTS conversation_messages (
                  id TEXT NOT NULL,
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  conversation_id TEXT NOT NULL,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, id)
                );
                CREATE TABLE IF NOT EXISTS sagas (
                  id TEXT NOT NULL,
                  tenant_id TEXT NOT NULL DEFAULT 'legacy',
                  kind TEXT NOT NULL,
                  idempotency_key TEXT NOT NULL,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (tenant_id, id)
                );
                """
            )
            _migrate_tenant_schema(conn)
            _migrate_normalize_opt_outs(conn)
            _dedupe_post_calls_by_conversation(conn)
            _recover_stale_post_call_claims(conn)
            conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_tenant_phone
                  ON contacts(tenant_id, phone)
                """
            )
            conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_sagas_tenant_idem
                  ON sagas(tenant_id, kind, idempotency_key)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_messages_tenant_conv
                  ON conversation_messages(tenant_id, conversation_id, created_at)
                """
            )
            conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_post_calls_tenant_conversation
                  ON post_calls(tenant_id, conversation_id)
                  WHERE conversation_id IS NOT NULL AND conversation_id != ''
                """
            )
            current = int(conn.execute("PRAGMA user_version").fetchone()[0] or 0)
            if current > SCHEMA_VERSION:
                raise RuntimeError(f"ops_store schema too new: db={current} code={SCHEMA_VERSION}")
            if current < SCHEMA_VERSION:
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            conn.commit()
        finally:
            conn.close()


def schema_version() -> int:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            return int(conn.execute("PRAGMA user_version").fetchone()[0] or 0)
        finally:
            conn.close()


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(r[1]) for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _migrate_tenant_schema(conn: sqlite3.Connection) -> None:
    """Upgrade legacy single-tenant tables to composite tenant keys."""
    tables = (
        "campaigns",
        "contacts",
        "dispatches",
        "handoffs",
        "crm_leads",
        "conversation_claims",
        "documents",
        "post_calls",
        "conversation_threads",
        "conversation_messages",
    )
    for table in tables:
        cols = _table_columns(conn, table)
        if not cols:
            continue
        if "tenant_id" not in cols:
            conn.execute(
                f"ALTER TABLE {table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '{_LEGACY_TENANT}'"
            )
        # Legacy DBs used id-only PRIMARY KEY; recreate when needed.
        pk = [
            str(r[1])
            for r in conn.execute(f"PRAGMA table_info({table})").fetchall()
            if int(r[5] or 0) > 0
        ]
        if pk == ["id"]:
            _rebuild_entity_table(conn, table)

    # settings_kv / opt_outs may still be key-only / phone-only PK.
    _rebuild_settings_kv(conn)
    _rebuild_opt_outs(conn)
    with contextlib.suppress(sqlite3.OperationalError):
        conn.execute("DROP INDEX IF EXISTS idx_contacts_phone")
    with contextlib.suppress(sqlite3.OperationalError):
        conn.execute("DROP INDEX IF EXISTS idx_post_calls_conversation")


def _rebuild_entity_table(conn: sqlite3.Connection, table: str) -> None:
    cols = _table_columns(conn, table)
    if "tenant_id" not in cols:
        return
    tmp = f"{table}__tenant_mig"
    conn.execute(f"DROP TABLE IF EXISTS {tmp}")
    # Re-read CREATE from empty template by copying rows into new composite PK table.
    col_list = [c for c in cols if c != "tenant_id"]
    # Ensure tenant_id first after rebuild via INSERT SELECT.
    conn.execute(f"ALTER TABLE {table} RENAME TO {tmp}")
    # Recreate using the IF NOT EXISTS script shape — simplest: create from known schemas.
    _create_empty_entity(conn, table)
    select_cols = ", ".join(["tenant_id"] + col_list)
    conn.execute(f"INSERT OR IGNORE INTO {table} ({select_cols}) SELECT {select_cols} FROM {tmp}")
    conn.execute(f"DROP TABLE {tmp}")


def _create_empty_entity(conn: sqlite3.Connection, table: str) -> None:
    schemas = {
        "campaigns": """
            CREATE TABLE campaigns (
              id TEXT NOT NULL, tenant_id TEXT NOT NULL,
              payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (tenant_id, id))""",
        "contacts": """
            CREATE TABLE contacts (
              id TEXT NOT NULL, tenant_id TEXT NOT NULL, phone TEXT NOT NULL,
              first_name TEXT NOT NULL, segment TEXT NOT NULL, university TEXT,
              payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (tenant_id, id))""",
        "dispatches": """
            CREATE TABLE dispatches (
              id TEXT NOT NULL, tenant_id TEXT NOT NULL,
              payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (tenant_id, id))""",
        "handoffs": """
            CREATE TABLE handoffs (
              id TEXT NOT NULL, tenant_id TEXT NOT NULL,
              payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (tenant_id, id))""",
        "crm_leads": """
            CREATE TABLE crm_leads (
              id TEXT NOT NULL, tenant_id TEXT NOT NULL, funnel TEXT NOT NULL,
              column_id TEXT NOT NULL, tipificacion TEXT, payload TEXT NOT NULL,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (tenant_id, id))""",
        "conversation_claims": """
            CREATE TABLE conversation_claims (
              id TEXT NOT NULL, tenant_id TEXT NOT NULL,
              payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (tenant_id, id))""",
        "documents": """
            CREATE TABLE documents (
              id TEXT NOT NULL, tenant_id TEXT NOT NULL, contact_phone TEXT,
              payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (tenant_id, id))""",
        "post_calls": """
            CREATE TABLE post_calls (
              id TEXT NOT NULL, tenant_id TEXT NOT NULL, conversation_id TEXT,
              phone TEXT, payload TEXT NOT NULL,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (tenant_id, id))""",
        "conversation_threads": """
            CREATE TABLE conversation_threads (
              id TEXT NOT NULL, tenant_id TEXT NOT NULL,
              payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (tenant_id, id))""",
        "conversation_messages": """
            CREATE TABLE conversation_messages (
              id TEXT NOT NULL, tenant_id TEXT NOT NULL,
              conversation_id TEXT NOT NULL, payload TEXT NOT NULL,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (tenant_id, id))""",
    }
    conn.execute(schemas[table])


def _rebuild_settings_kv(conn: sqlite3.Connection) -> None:
    cols = _table_columns(conn, "settings_kv")
    if not cols:
        return
    pk = [
        str(r[1])
        for r in conn.execute("PRAGMA table_info(settings_kv)").fetchall()
        if int(r[5] or 0) > 0
    ]
    if pk == ["tenant_id", "key"] or set(pk) == {"tenant_id", "key"}:
        return
    if "tenant_id" not in cols:
        conn.execute(
            f"ALTER TABLE settings_kv ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '{_LEGACY_TENANT}'"
        )
    conn.execute("ALTER TABLE settings_kv RENAME TO settings_kv__old")
    conn.execute(
        """
        CREATE TABLE settings_kv (
          tenant_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (tenant_id, key)
        )
        """
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO settings_kv(tenant_id, key, value, updated_at)
        SELECT COALESCE(NULLIF(tenant_id, ''), 'legacy'), key, value, updated_at
        FROM settings_kv__old
        """
    )
    conn.execute("DROP TABLE settings_kv__old")


def _rebuild_opt_outs(conn: sqlite3.Connection) -> None:
    cols = _table_columns(conn, "opt_outs")
    if not cols:
        return
    pk = [
        str(r[1])
        for r in conn.execute("PRAGMA table_info(opt_outs)").fetchall()
        if int(r[5] or 0) > 0
    ]
    if set(pk) == {"tenant_id", "phone"}:
        return
    if "tenant_id" not in cols:
        conn.execute(
            f"ALTER TABLE opt_outs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '{_LEGACY_TENANT}'"
        )
    conn.execute("ALTER TABLE opt_outs RENAME TO opt_outs__old")
    conn.execute(
        """
        CREATE TABLE opt_outs (
          tenant_id TEXT NOT NULL,
          phone TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (tenant_id, phone)
        )
        """
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO opt_outs(tenant_id, phone, created_at)
        SELECT COALESCE(NULLIF(tenant_id, ''), 'legacy'), phone, created_at
        FROM opt_outs__old
        """
    )
    conn.execute("DROP TABLE opt_outs__old")


def _migrate_normalize_opt_outs(conn: sqlite3.Connection) -> None:
    from pilot_core.phone import normalize_phone

    rows = conn.execute("SELECT tenant_id, phone FROM opt_outs").fetchall()
    for row in rows:
        raw = str(row["phone"] or "")
        canon = normalize_phone(raw) or raw.strip()
        if not canon or canon == raw:
            continue
        tid = str(row["tenant_id"] or _LEGACY_TENANT)
        conn.execute("DELETE FROM opt_outs WHERE tenant_id=? AND phone=?", (tid, raw))
        conn.execute("INSERT OR IGNORE INTO opt_outs(tenant_id, phone) VALUES(?, ?)", (tid, canon))


def _dedupe_post_calls_by_conversation(conn: sqlite3.Connection) -> None:
    dupes = conn.execute(
        """
        SELECT tenant_id, conversation_id, COUNT(*) AS c
        FROM post_calls
        WHERE conversation_id IS NOT NULL AND conversation_id != ''
        GROUP BY tenant_id, conversation_id
        HAVING c > 1
        """
    ).fetchall()
    for group in dupes:
        tid = str(group["tenant_id"])
        cid = str(group["conversation_id"])
        rows = conn.execute(
            """
            SELECT id, payload, created_at FROM post_calls
            WHERE tenant_id=? AND conversation_id=?
            ORDER BY created_at DESC
            """,
            (tid, cid),
        ).fetchall()
        keep_id: str | None = None
        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except json.JSONDecodeError:
                continue
            if payload.get("status") == "completed":
                keep_id = str(row["id"])
                break
        if keep_id is None and rows:
            keep_id = str(rows[0]["id"])
        for row in rows:
            if str(row["id"]) != keep_id:
                conn.execute("DELETE FROM post_calls WHERE tenant_id=? AND id=?", (tid, row["id"]))


def _recover_stale_post_call_claims(conn: sqlite3.Connection, *, max_age_sec: int = 300) -> None:
    """AUD2-002: drop stuck processing only when lease_until elapsed (not row created_at)."""
    from datetime import datetime, timedelta

    now = datetime.now(tz=UTC)
    # Absolute safety net if lease_until missing/unparseable (watcher max ~1200s).
    hard_cutoff = now - timedelta(seconds=max(max_age_sec * 4, 1200))
    rows = conn.execute(
        "SELECT tenant_id, id, payload, created_at FROM post_calls WHERE conversation_id IS NOT NULL"
    ).fetchall()
    for row in rows:
        try:
            payload = json.loads(row["payload"])
        except json.JSONDecodeError:
            continue
        if payload.get("status") != "processing":
            continue
        lease = _parse_lease_until(payload.get("lease_until"))
        if lease is not None:
            if now <= lease:
                continue
        else:
            created_raw = str(row["created_at"] or "")
            try:
                created = datetime.strptime(created_raw, "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC)
            except ValueError:
                created = hard_cutoff
            if created > hard_cutoff:
                continue
        conn.execute(
            "DELETE FROM post_calls WHERE tenant_id=? AND id=?",
            (row["tenant_id"], row["id"]),
        )


def _with_tenant_payload(entry: dict[str, Any], tenant_id: str) -> dict[str, Any]:
    return {**entry, "tenant_id": tenant_id}


# --- unscoped lookups for webhooks (IDs are globally unique / first match) ---


def find_tenant_for_conversation(conversation_id: str) -> str | None:
    """Locate owning tenant for a conversation (webhook / watcher bootstrap)."""
    init_db()
    cid = (conversation_id or "").strip()
    if not cid:
        return None
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                """
                SELECT tenant_id FROM post_calls
                WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1
                """,
                (cid,),
            ).fetchone()
            if row:
                return str(row["tenant_id"])
            rows = conn.execute(
                "SELECT tenant_id, payload FROM dispatches ORDER BY created_at DESC LIMIT 500"
            ).fetchall()
            for r in rows:
                try:
                    payload = json.loads(r["payload"])
                except json.JSONDecodeError:
                    continue
                if str(payload.get("conversation_id") or "") == cid:
                    return str(r["tenant_id"])
            return None
        finally:
            conn.close()


def get_dispatch_unscoped(dispatch_id: str) -> tuple[str, dict[str, Any]] | None:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT tenant_id, payload FROM dispatches WHERE id=? LIMIT 1",
                (dispatch_id,),
            ).fetchone()
            if not row:
                return None
            return str(row["tenant_id"]), json.loads(row["payload"])
        finally:
            conn.close()


def upsert_campaign(campaign: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    campaign = _with_tenant_payload(campaign, tid)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO campaigns(tenant_id, id, payload) VALUES(?, ?, ?)
                ON CONFLICT(tenant_id, id) DO UPDATE SET payload=excluded.payload
                """,
                (tid, campaign["id"], json.dumps(campaign, ensure_ascii=False)),
            )
            conn.commit()
            return campaign
        finally:
            conn.close()


def list_campaigns() -> list[dict[str, Any]]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT payload FROM campaigns
                WHERE tenant_id=? ORDER BY created_at DESC
                """,
                (tid,),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def _upsert_contact_row(
    conn: sqlite3.Connection, tid: str, contact: dict[str, Any]
) -> dict[str, Any]:
    existing = conn.execute(
        "SELECT id FROM contacts WHERE tenant_id=? AND phone=?",
        (tid, contact["phone"]),
    ).fetchone()
    contact_id = existing["id"] if existing else contact["id"]
    contact = _with_tenant_payload({**contact, "id": contact_id}, tid)
    conn.execute(
        """
        INSERT INTO contacts(
          tenant_id, id, phone, first_name, segment, university, payload
        )
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, phone) DO UPDATE SET
          first_name=excluded.first_name,
          segment=excluded.segment,
          university=excluded.university,
          payload=excluded.payload
        """,
        (
            tid,
            contact_id,
            contact["phone"],
            contact["first_name"],
            contact["segment"],
            contact.get("university"),
            json.dumps(contact, ensure_ascii=False),
        ),
    )
    return contact


def insert_contact(contact: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            out = _upsert_contact_row(conn, tid, contact)
            conn.commit()
            return out
        finally:
            conn.close()


def insert_contacts_batch(contacts: list[dict[str, Any]]) -> int:
    """AUD-030: single-transaction import (all-or-nothing)."""
    tid = require_tenant()
    init_db()
    if not contacts:
        return 0
    with _LOCK:
        conn = _connect()
        try:
            for contact in contacts:
                _upsert_contact_row(conn, tid, contact)
            conn.commit()
            return len(contacts)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def get_contact_by_phone(phone: str) -> dict[str, Any] | None:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT payload FROM contacts WHERE tenant_id=? AND phone=? LIMIT 1",
                (tid, phone),
            ).fetchone()
            return json.loads(row["payload"]) if row else None
        finally:
            conn.close()


def list_contacts(limit: int = 200) -> list[dict[str, Any]]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT payload FROM contacts
                WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?
                """,
                (tid, limit),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def insert_dispatch(entry: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    if "id" not in entry:
        entry["id"] = f"d_{uuid4().hex[:10]}"
    entry = _with_tenant_payload(entry, tid)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO dispatches(tenant_id, id, payload) VALUES(?, ?, ?)",
                (tid, entry["id"], json.dumps(entry, ensure_ascii=False)),
            )
            conn.commit()
            return entry
        finally:
            conn.close()


def upsert_dispatch(entry: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    if "id" not in entry:
        entry["id"] = f"d_{uuid4().hex[:10]}"
    entry = _with_tenant_payload(entry, tid)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO dispatches(tenant_id, id, payload) VALUES(?, ?, ?)
                ON CONFLICT(tenant_id, id) DO UPDATE SET payload=excluded.payload
                """,
                (tid, entry["id"], json.dumps(entry, ensure_ascii=False)),
            )
            conn.commit()
            return entry
        finally:
            conn.close()


def get_dispatch(dispatch_id: str) -> dict[str, Any] | None:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT payload FROM dispatches WHERE tenant_id=? AND id=?",
                (tid, dispatch_id),
            ).fetchone()
            return json.loads(row["payload"]) if row else None
        finally:
            conn.close()


def list_dispatches(limit: int = 50, *, offset: int = 0) -> list[dict[str, Any]]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT payload, created_at FROM dispatches
                WHERE tenant_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?
                """,
                (tid, limit, max(0, int(offset))),
            ).fetchall()
            out: list[dict[str, Any]] = []
            for r in rows:
                item = json.loads(r["payload"])
                item["_created_at"] = r["created_at"]
                out.append(item)
            return out
        finally:
            conn.close()


def insert_post_call(entry: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    if "id" not in entry:
        entry["id"] = f"pc_{uuid4().hex[:10]}"
    entry = _with_tenant_payload(entry, tid)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO post_calls(tenant_id, id, conversation_id, phone, payload)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(tenant_id, id) DO UPDATE SET
                  conversation_id=excluded.conversation_id,
                  phone=excluded.phone,
                  payload=excluded.payload
                """,
                (
                    tid,
                    entry["id"],
                    entry.get("conversation_id"),
                    entry.get("phone"),
                    json.dumps(entry, ensure_ascii=False),
                ),
            )
            conn.commit()
            return entry
        finally:
            conn.close()


def _parse_lease_until(raw: Any) -> Any:
    from datetime import datetime

    if not raw:
        return None
    text = str(raw).strip()
    for fmt in (
        "%Y-%m-%dT%H:%M:%S.%f%z",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%dT%H:%M:%S",
    ):
        try:
            parsed = datetime.strptime(text.replace("Z", "+00:00"), fmt)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            return parsed
        except ValueError:
            continue
    return None


def claim_post_call_conversation(
    conversation_id: str,
    placeholder: dict[str, Any],
    *,
    stale_after_sec: int = 300,
) -> tuple[bool, dict[str, Any] | None]:
    from datetime import datetime, timedelta

    tid = require_tenant()
    init_db()
    if "id" not in placeholder:
        placeholder["id"] = f"pc_{uuid4().hex[:10]}"
    owner_id = str(placeholder.get("owner_id") or uuid4().hex)
    lease_until = (datetime.now(tz=UTC) + timedelta(seconds=stale_after_sec)).isoformat()
    with _LOCK:
        conn = _connect()
        try:
            existing = conn.execute(
                """
                SELECT id, payload, created_at FROM post_calls
                WHERE tenant_id=? AND conversation_id=?
                ORDER BY created_at DESC LIMIT 1
                """,
                (tid, conversation_id),
            ).fetchone()
            if existing:
                prior = json.loads(existing["payload"])
                status = str(prior.get("status") or "")
                if status in {"failed", "error"}:
                    resumed = {
                        **prior,
                        "status": "processing",
                        "error": None,
                        "retry_count": int(prior.get("retry_count") or 0) + 1,
                        "tenant_id": tid,
                        "owner_id": owner_id,
                        "lease_until": lease_until,
                    }
                    conn.execute(
                        "UPDATE post_calls SET phone=?, payload=? WHERE tenant_id=? AND id=?",
                        (
                            resumed.get("phone") or placeholder.get("phone"),
                            json.dumps(resumed, ensure_ascii=False),
                            tid,
                            existing["id"],
                        ),
                    )
                    conn.commit()
                    return True, resumed
                if status == "processing":
                    # AUD-014: lease from renewable lease_until (not fixed created_at).
                    lease = _parse_lease_until(prior.get("lease_until"))
                    now = datetime.now(tz=UTC)
                    if lease is None:
                        # Legacy rows: fall back to created_at once.
                        created_raw = str(existing["created_at"] or "")
                        try:
                            lease = datetime.strptime(created_raw, "%Y-%m-%d %H:%M:%S").replace(
                                tzinfo=UTC
                            ) + timedelta(seconds=stale_after_sec)
                        except ValueError:
                            lease = now - timedelta(seconds=1)
                    if now <= lease:
                        return False, prior
                    prior["status"] = "failed"
                    prior["error"] = prior.get("error") or "stale_processing"
                    resumed = {
                        **prior,
                        "status": "processing",
                        "error": None,
                        "retry_count": int(prior.get("retry_count") or 0) + 1,
                        "tenant_id": tid,
                        "owner_id": owner_id,
                        "lease_until": lease_until,
                    }
                    conn.execute(
                        "UPDATE post_calls SET payload=? WHERE tenant_id=? AND id=?",
                        (json.dumps(resumed, ensure_ascii=False), tid, existing["id"]),
                    )
                    conn.commit()
                    return True, resumed
                return False, prior
            try:
                body = _with_tenant_payload(
                    {
                        **placeholder,
                        "status": "processing",
                        "owner_id": owner_id,
                        "lease_until": lease_until,
                    },
                    tid,
                )
                conn.execute(
                    """
                    INSERT INTO post_calls(tenant_id, id, conversation_id, phone, payload)
                    VALUES(?, ?, ?, ?, ?)
                    """,
                    (
                        tid,
                        placeholder["id"],
                        conversation_id,
                        placeholder.get("phone"),
                        json.dumps(body, ensure_ascii=False),
                    ),
                )
                conn.commit()
                return True, None
            except sqlite3.IntegrityError:
                conn.rollback()
                row = conn.execute(
                    """
                    SELECT payload FROM post_calls
                    WHERE tenant_id=? AND conversation_id=?
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    (tid, conversation_id),
                ).fetchone()
                if row:
                    return False, json.loads(row["payload"])
                return False, None
        finally:
            conn.close()


def fail_post_call_claim(entry: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    entry = _with_tenant_payload({**entry, "status": "failed", "ok": False}, tid)
    if "id" not in entry:
        entry["id"] = f"pc_{uuid4().hex[:10]}"
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO post_calls(tenant_id, id, conversation_id, phone, payload)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(tenant_id, id) DO UPDATE SET
                  conversation_id=excluded.conversation_id,
                  phone=excluded.phone,
                  payload=excluded.payload
                """,
                (
                    tid,
                    entry["id"],
                    entry.get("conversation_id"),
                    entry.get("phone"),
                    json.dumps(entry, ensure_ascii=False),
                ),
            )
            conn.commit()
            return entry
        finally:
            conn.close()


def release_post_call_claim(post_call_id: str, *, error: str | None = None) -> None:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT payload FROM post_calls WHERE tenant_id=? AND id=?",
                (tid, post_call_id),
            ).fetchone()
            if not row:
                return
            try:
                payload = json.loads(row["payload"])
            except json.JSONDecodeError:
                conn.execute(
                    "DELETE FROM post_calls WHERE tenant_id=? AND id=?", (tid, post_call_id)
                )
                conn.commit()
                return
            if payload.get("status") != "processing":
                return
            payload["status"] = "failed"
            payload["ok"] = False
            if error:
                payload["error"] = error
            conn.execute(
                "UPDATE post_calls SET payload=? WHERE tenant_id=? AND id=?",
                (json.dumps(payload, ensure_ascii=False), tid, post_call_id),
            )
            conn.commit()
        finally:
            conn.close()


def list_post_calls(limit: int = 100) -> list[dict[str, Any]]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT payload, created_at FROM post_calls
                WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?
                """,
                (tid, limit),
            ).fetchall()
            out: list[dict[str, Any]] = []
            for r in rows:
                item = json.loads(r["payload"])
                item["_created_at"] = r["created_at"]
                out.append(item)
            return out
        finally:
            conn.close()


def get_post_call_by_conversation(conversation_id: str) -> dict[str, Any] | None:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                """
                SELECT payload FROM post_calls
                WHERE tenant_id=? AND conversation_id=?
                ORDER BY created_at DESC LIMIT 1
                """,
                (tid, conversation_id),
            ).fetchone()
            return json.loads(row["payload"]) if row else None
        finally:
            conn.close()


def insert_handoff(entry: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    if "id" not in entry:
        entry["id"] = f"h_{uuid4().hex[:10]}"
    entry = _with_tenant_payload(entry, tid)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO handoffs(tenant_id, id, payload) VALUES(?, ?, ?)",
                (tid, entry["id"], json.dumps(entry, ensure_ascii=False)),
            )
            conn.commit()
            return entry
        finally:
            conn.close()


def list_handoffs(limit: int = 50) -> list[dict[str, Any]]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT payload FROM handoffs
                WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?
                """,
                (tid, limit),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def upsert_crm_lead(lead: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    lead = _with_tenant_payload(lead, tid)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO crm_leads(
                  tenant_id, id, funnel, column_id, tipificacion, payload
                )
                VALUES(?, ?, ?, ?, ?, ?)
                ON CONFLICT(tenant_id, id) DO UPDATE SET
                  funnel=excluded.funnel,
                  column_id=excluded.column_id,
                  tipificacion=excluded.tipificacion,
                  payload=excluded.payload
                """,
                (
                    tid,
                    lead["id"],
                    lead["funnel"],
                    lead["column_id"],
                    lead.get("tipificacion"),
                    json.dumps(lead, ensure_ascii=False),
                ),
            )
            conn.commit()
            return lead
        finally:
            conn.close()


def list_crm_leads(funnel: str | None = None) -> list[dict[str, Any]]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            if funnel:
                rows = conn.execute(
                    """
                    SELECT payload FROM crm_leads
                    WHERE tenant_id=? AND funnel=? ORDER BY created_at DESC
                    """,
                    (tid, funnel),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT payload FROM crm_leads
                    WHERE tenant_id=? ORDER BY created_at DESC
                    """,
                    (tid,),
                ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def upsert_conversation_claim(claim: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    claim = _with_tenant_payload(claim, tid)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO conversation_claims(tenant_id, id, payload) VALUES(?, ?, ?)
                ON CONFLICT(tenant_id, id) DO UPDATE SET payload=excluded.payload
                """,
                (tid, claim["id"], json.dumps(claim, ensure_ascii=False)),
            )
            conn.commit()
            return claim
        finally:
            conn.close()


def list_conversation_claims() -> list[dict[str, Any]]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT payload FROM conversation_claims
                WHERE tenant_id=? ORDER BY created_at DESC
                """,
                (tid,),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def delete_conversation_claim(conversation_id: str) -> bool:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            cur = conn.execute(
                "DELETE FROM conversation_claims WHERE tenant_id=? AND id=?",
                (tid, conversation_id),
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def add_opt_out(phone: str) -> dict[str, Any]:
    from pilot_core.phone import normalize_phone

    tid = require_tenant()
    init_db()
    phone = normalize_phone(phone) or phone.strip()
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO opt_outs(tenant_id, phone) VALUES(?, ?)",
                (tid, phone),
            )
            conn.commit()
            return {"phone": phone, "suppressed": True, "tenant_id": tid}
        finally:
            conn.close()


def list_opt_outs() -> list[str]:
    from pilot_core.phone import normalize_phone

    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT phone FROM opt_outs WHERE tenant_id=? ORDER BY created_at DESC",
                (tid,),
            ).fetchall()
            seen: set[str] = set()
            out: list[str] = []
            for r in rows:
                raw = str(r["phone"])
                canon = normalize_phone(raw) or raw.strip()
                if canon and canon not in seen:
                    seen.add(canon)
                    out.append(canon)
            return out
        finally:
            conn.close()


def upsert_conversation_thread(thread: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    thread = _with_tenant_payload(thread, tid)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO conversation_threads(tenant_id, id, payload) VALUES(?, ?, ?)
                ON CONFLICT(tenant_id, id) DO UPDATE SET payload=excluded.payload
                """,
                (tid, thread["id"], json.dumps(thread, ensure_ascii=False)),
            )
            conn.commit()
            return thread
        finally:
            conn.close()


def list_conversation_threads() -> list[dict[str, Any]]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT payload FROM conversation_threads
                WHERE tenant_id=? ORDER BY created_at DESC
                """,
                (tid,),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def append_conversation_message(conversation_id: str, message: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    if "id" not in message:
        message["id"] = f"m_{uuid4().hex[:10]}"
    message = _with_tenant_payload(message, tid)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO conversation_messages(
                  tenant_id, id, conversation_id, payload
                ) VALUES(?, ?, ?, ?)
                """,
                (
                    tid,
                    message["id"],
                    conversation_id,
                    json.dumps(message, ensure_ascii=False),
                ),
            )
            conn.commit()
            return message
        finally:
            conn.close()


def list_conversation_messages(conversation_id: str, limit: int = 200) -> list[dict[str, Any]]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT payload FROM conversation_messages
                WHERE tenant_id=? AND conversation_id=?
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (tid, conversation_id, limit),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def counts() -> dict[str, int]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            out: dict[str, int] = {}
            for table in (
                "campaigns",
                "contacts",
                "dispatches",
                "handoffs",
                "crm_leads",
                "conversation_claims",
                "documents",
            ):
                out[table] = int(
                    conn.execute(
                        f"SELECT COUNT(*) AS c FROM {table} WHERE tenant_id=?",
                        (tid,),
                    ).fetchone()["c"]
                )
            return out
        finally:
            conn.close()


def upsert_document(doc: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    doc = _with_tenant_payload(doc, tid)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO documents(tenant_id, id, contact_phone, payload)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(tenant_id, id) DO UPDATE SET
                  contact_phone=excluded.contact_phone,
                  payload=excluded.payload
                """,
                (
                    tid,
                    doc["id"],
                    doc.get("contact_phone"),
                    json.dumps(doc, ensure_ascii=False),
                ),
            )
            conn.commit()
            return doc
        finally:
            conn.close()


def list_documents(limit: int = 100) -> list[dict[str, Any]]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT payload FROM documents
                WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?
                """,
                (tid, limit),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def set_setting(key: str, value: Any) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    payload = json.dumps(value, ensure_ascii=False)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO settings_kv(tenant_id, key, value) VALUES(?, ?, ?)
                ON CONFLICT(tenant_id, key) DO UPDATE SET
                  value=excluded.value,
                  updated_at=CURRENT_TIMESTAMP
                """,
                (tid, key, payload),
            )
            conn.commit()
            return {"key": key, "value": value, "tenant_id": tid}
        finally:
            conn.close()


def get_setting(key: str, default: Any = None) -> Any:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT value FROM settings_kv WHERE tenant_id=? AND key=?",
                (tid, key),
            ).fetchone()
            if not row:
                return default
            return json.loads(row["value"])
        finally:
            conn.close()


def all_settings() -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT key, value FROM settings_kv WHERE tenant_id=?",
                (tid,),
            ).fetchall()
            return {r["key"]: json.loads(r["value"]) for r in rows}
        finally:
            conn.close()


def claim_saga(
    kind: str,
    idempotency_key: str,
    placeholder: dict[str, Any],
    *,
    stale_after_sec: int = 300,
) -> tuple[bool, dict[str, Any] | None]:
    """AUD-021: durable saga claim by (tenant, kind, idempotency_key)."""
    from datetime import datetime, timedelta

    tid = require_tenant()
    init_db()
    key = (idempotency_key or "").strip()
    if not key:
        raise ValueError("idempotency_key required")
    sid = str(placeholder.get("id") or f"sg_{uuid4().hex[:10]}")
    lease_until = (datetime.now(tz=UTC) + timedelta(seconds=stale_after_sec)).isoformat()
    with _LOCK:
        conn = _connect()
        try:
            existing = conn.execute(
                """
                SELECT id, payload FROM sagas
                WHERE tenant_id=? AND kind=? AND idempotency_key=?
                LIMIT 1
                """,
                (tid, kind, key),
            ).fetchone()
            if existing:
                prior = json.loads(existing["payload"])
                status = str(prior.get("status") or "")
                if status == "completed":
                    return False, prior
                if status == "processing":
                    lease = _parse_lease_until(prior.get("lease_until"))
                    now = datetime.now(tz=UTC)
                    if lease is not None and now <= lease:
                        return False, prior
                    prior["status"] = "failed"
                    prior["error"] = prior.get("error") or "stale_processing"
                # AUD2-003: reclaim without wiping durable step checkpoints.
                prior_steps: dict[str, Any] = (
                    dict(prior["steps"]) if isinstance(prior.get("steps"), dict) else {}
                )
                ph_steps: dict[str, Any] = (
                    dict(placeholder["steps"]) if isinstance(placeholder.get("steps"), dict) else {}
                )
                merged_steps: dict[str, Any] = {**ph_steps, **prior_steps}  # prior wins
                control_keys = {
                    "id",
                    "kind",
                    "idempotency_key",
                    "status",
                    "error",
                    "lease_until",
                    "retry_count",
                    "tenant_id",
                    "steps",
                    "result",
                }
                overlay = {k: v for k, v in placeholder.items() if k not in control_keys}
                resumed = {
                    **prior,
                    **overlay,
                    "id": existing["id"],
                    "kind": kind,
                    "idempotency_key": key,
                    "status": "processing",
                    "error": None,
                    "lease_until": lease_until,
                    "retry_count": int(prior.get("retry_count") or 0) + 1,
                    "tenant_id": tid,
                    "steps": merged_steps,
                }
                conn.execute(
                    "UPDATE sagas SET payload=? WHERE tenant_id=? AND id=?",
                    (json.dumps(resumed, ensure_ascii=False), tid, existing["id"]),
                )
                conn.commit()
                return True, resumed
            body = _with_tenant_payload(
                {
                    **placeholder,
                    "id": sid,
                    "kind": kind,
                    "idempotency_key": key,
                    "status": "processing",
                    "lease_until": lease_until,
                    "steps": placeholder.get("steps") or {},
                },
                tid,
            )
            conn.execute(
                """
                INSERT INTO sagas(tenant_id, id, kind, idempotency_key, payload)
                VALUES(?, ?, ?, ?, ?)
                """,
                (tid, sid, kind, key, json.dumps(body, ensure_ascii=False)),
            )
            conn.commit()
            return True, body
        finally:
            conn.close()


def save_saga(entry: dict[str, Any]) -> dict[str, Any]:
    tid = require_tenant()
    init_db()
    entry = _with_tenant_payload(entry, tid)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "UPDATE sagas SET payload=? WHERE tenant_id=? AND id=?",
                (json.dumps(entry, ensure_ascii=False), tid, entry["id"]),
            )
            conn.commit()
            return entry
        finally:
            conn.close()


def get_saga(kind: str, idempotency_key: str) -> dict[str, Any] | None:
    tid = require_tenant()
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                """
                SELECT payload FROM sagas
                WHERE tenant_id=? AND kind=? AND idempotency_key=?
                LIMIT 1
                """,
                (tid, kind, (idempotency_key or "").strip()),
            ).fetchone()
            return json.loads(row["payload"]) if row else None
        finally:
            conn.close()

"""SQLite persistence for Ops product demo (campaigns, contacts, dispatches)."""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
from datetime import UTC
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

_LOCK = Lock()
_DB_PATH: Path | None = None


def data_root() -> Path:
    """Writable root for Ops SQLite + local docs (Docker-safe).

    Prefer ``PULSO_DATA_DIR``. Fall back to monorepo ``.local-secrets-tmp``,
    then ``/data``, then ``/tmp/pulso``.
    """
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
    # Last resort — may still fail on read-only FS; callers surface the error.
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


def init_db() -> None:
    with _LOCK:
        conn = _connect()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS campaigns (
                  id TEXT PRIMARY KEY,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS contacts (
                  id TEXT PRIMARY KEY,
                  phone TEXT NOT NULL,
                  first_name TEXT NOT NULL,
                  segment TEXT NOT NULL,
                  university TEXT,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS dispatches (
                  id TEXT PRIMARY KEY,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS handoffs (
                  id TEXT PRIMARY KEY,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS crm_leads (
                  id TEXT PRIMARY KEY,
                  funnel TEXT NOT NULL,
                  column_id TEXT NOT NULL,
                  tipificacion TEXT,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS conversation_claims (
                  id TEXT PRIMARY KEY,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS documents (
                  id TEXT PRIMARY KEY,
                  contact_phone TEXT,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS settings_kv (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL,
                  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS opt_outs (
                  phone TEXT PRIMARY KEY,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS post_calls (
                  id TEXT PRIMARY KEY,
                  conversation_id TEXT,
                  phone TEXT,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS conversation_threads (
                  id TEXT PRIMARY KEY,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS conversation_messages (
                  id TEXT PRIMARY KEY,
                  conversation_id TEXT NOT NULL,
                  payload TEXT NOT NULL,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
                CREATE INDEX IF NOT EXISTS idx_messages_conv
                  ON conversation_messages(conversation_id, created_at);
                """
            )
            _migrate_normalize_opt_outs(conn)
            _dedupe_post_calls_by_conversation(conn)
            _recover_stale_post_call_claims(conn)
            # Unique index AFTER dedupe — legacy DBs may already have duplicates.
            conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_post_calls_conversation
                  ON post_calls(conversation_id)
                  WHERE conversation_id IS NOT NULL AND conversation_id != ''
                """
            )
            conn.commit()
        finally:
            conn.close()


def _migrate_normalize_opt_outs(conn: sqlite3.Connection) -> None:
    """Rewrite legacy opt-out rows to canonical E.164 phones."""
    from pilot_core.phone import normalize_phone

    rows = conn.execute("SELECT phone FROM opt_outs").fetchall()
    for row in rows:
        raw = str(row["phone"] or "")
        canon = normalize_phone(raw) or raw.strip()
        if not canon or canon == raw:
            continue
        conn.execute("DELETE FROM opt_outs WHERE phone=?", (raw,))
        conn.execute("INSERT OR IGNORE INTO opt_outs(phone) VALUES(?)", (canon,))


def _dedupe_post_calls_by_conversation(conn: sqlite3.Connection) -> None:
    """Keep one row per conversation_id before creating the unique index."""
    dupes = conn.execute(
        """
        SELECT conversation_id, COUNT(*) AS c
        FROM post_calls
        WHERE conversation_id IS NOT NULL AND conversation_id != ''
        GROUP BY conversation_id
        HAVING c > 1
        """
    ).fetchall()
    for group in dupes:
        cid = str(group["conversation_id"])
        rows = conn.execute(
            """
            SELECT id, payload, created_at FROM post_calls
            WHERE conversation_id=?
            ORDER BY created_at DESC
            """,
            (cid,),
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
                conn.execute("DELETE FROM post_calls WHERE id=?", (row["id"],))


def _recover_stale_post_call_claims(conn: sqlite3.Connection, *, max_age_sec: int = 300) -> None:
    """Drop abandoned ``processing`` claims so webhooks can be retried."""
    from datetime import datetime, timedelta

    cutoff = datetime.now(tz=UTC) - timedelta(seconds=max_age_sec)
    rows = conn.execute(
        "SELECT id, payload, created_at FROM post_calls WHERE conversation_id IS NOT NULL"
    ).fetchall()
    for row in rows:
        try:
            payload = json.loads(row["payload"])
        except json.JSONDecodeError:
            continue
        if payload.get("status") != "processing":
            continue
        created_raw = str(row["created_at"] or "")
        try:
            # SQLite CURRENT_TIMESTAMP is UTC ``YYYY-MM-DD HH:MM:SS``
            created = datetime.strptime(created_raw, "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC)
        except ValueError:
            created = cutoff  # treat unparseable as stale
        if created <= cutoff:
            conn.execute("DELETE FROM post_calls WHERE id=?", (row["id"],))


def upsert_campaign(campaign: dict[str, Any]) -> dict[str, Any]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO campaigns(id, payload) VALUES(?, ?)",
                (campaign["id"], json.dumps(campaign, ensure_ascii=False)),
            )
            conn.commit()
            return campaign
        finally:
            conn.close()


def list_campaigns() -> list[dict[str, Any]]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute("SELECT payload FROM campaigns ORDER BY created_at DESC").fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def insert_contact(contact: dict[str, Any]) -> dict[str, Any]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone)")
            existing = conn.execute(
                "SELECT id FROM contacts WHERE phone=?", (contact["phone"],)
            ).fetchone()
            contact_id = existing["id"] if existing else contact["id"]
            contact = {**contact, "id": contact_id}
            conn.execute(
                """
                INSERT INTO contacts(id, phone, first_name, segment, university, payload)
                VALUES(?, ?, ?, ?, ?, ?)
                ON CONFLICT(phone) DO UPDATE SET
                  first_name=excluded.first_name,
                  segment=excluded.segment,
                  university=excluded.university,
                  payload=excluded.payload
                """,
                (
                    contact_id,
                    contact["phone"],
                    contact["first_name"],
                    contact["segment"],
                    contact.get("university"),
                    json.dumps(contact, ensure_ascii=False),
                ),
            )
            conn.commit()
            return contact
        finally:
            conn.close()


def get_contact_by_phone(phone: str) -> dict[str, Any] | None:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT payload FROM contacts WHERE phone=? LIMIT 1", (phone,)
            ).fetchone()
            return json.loads(row["payload"]) if row else None
        finally:
            conn.close()


def list_contacts(limit: int = 200) -> list[dict[str, Any]]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT payload FROM contacts ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def insert_dispatch(entry: dict[str, Any]) -> dict[str, Any]:
    init_db()
    if "id" not in entry:
        entry["id"] = f"d_{uuid4().hex[:10]}"
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO dispatches(id, payload) VALUES(?, ?)",
                (entry["id"], json.dumps(entry, ensure_ascii=False)),
            )
            conn.commit()
            return entry
        finally:
            conn.close()


def upsert_dispatch(entry: dict[str, Any]) -> dict[str, Any]:
    init_db()
    if "id" not in entry:
        entry["id"] = f"d_{uuid4().hex[:10]}"
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO dispatches(id, payload) VALUES(?, ?)",
                (entry["id"], json.dumps(entry, ensure_ascii=False)),
            )
            conn.commit()
            return entry
        finally:
            conn.close()


def get_dispatch(dispatch_id: str) -> dict[str, Any] | None:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT payload FROM dispatches WHERE id=?", (dispatch_id,)
            ).fetchone()
            return json.loads(row["payload"]) if row else None
        finally:
            conn.close()


def list_dispatches(limit: int = 50) -> list[dict[str, Any]]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT payload FROM dispatches ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def insert_post_call(entry: dict[str, Any]) -> dict[str, Any]:
    init_db()
    if "id" not in entry:
        entry["id"] = f"pc_{uuid4().hex[:10]}"
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT OR REPLACE INTO post_calls(id, conversation_id, phone, payload)
                VALUES(?, ?, ?, ?)
                """,
                (
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


def claim_post_call_conversation(
    conversation_id: str,
    placeholder: dict[str, Any],
    *,
    stale_after_sec: int = 300,
) -> tuple[bool, dict[str, Any] | None]:
    """Atomically claim a conversation_id for post-call processing.

    Returns (True, None) for a fresh claim, (True, prior) when reclaiming a
    ``failed`` row (prior keeps CRM/WA effects for idempotent resume), or
    (False, existing) when another owner holds a fresh ``processing`` /
    ``completed`` claim.
    """
    from datetime import datetime, timedelta

    init_db()
    if "id" not in placeholder:
        placeholder["id"] = f"pc_{uuid4().hex[:10]}"
    with _LOCK:
        conn = _connect()
        try:
            existing = conn.execute(
                """
                SELECT id, payload, created_at FROM post_calls
                WHERE conversation_id=?
                ORDER BY created_at DESC LIMIT 1
                """,
                (conversation_id,),
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
                    }
                    conn.execute(
                        "UPDATE post_calls SET phone=?, payload=? WHERE id=?",
                        (
                            resumed.get("phone") or placeholder.get("phone"),
                            json.dumps(resumed, ensure_ascii=False),
                            existing["id"],
                        ),
                    )
                    conn.commit()
                    return True, resumed
                if status == "processing":
                    created_raw = str(existing["created_at"] or "")
                    try:
                        created = datetime.strptime(created_raw, "%Y-%m-%d %H:%M:%S").replace(
                            tzinfo=UTC
                        )
                    except ValueError:
                        created = datetime.now(tz=UTC) - timedelta(seconds=stale_after_sec + 1)
                    age_ok = datetime.now(tz=UTC) - created > timedelta(seconds=stale_after_sec)
                    if age_ok:
                        prior["status"] = "failed"
                        prior["error"] = prior.get("error") or "stale_processing"
                        resumed = {
                            **prior,
                            "status": "processing",
                            "error": None,
                            "retry_count": int(prior.get("retry_count") or 0) + 1,
                        }
                        conn.execute(
                            "UPDATE post_calls SET payload=? WHERE id=?",
                            (json.dumps(resumed, ensure_ascii=False), existing["id"]),
                        )
                        conn.commit()
                        return True, resumed
                    return False, prior
                return False, prior
            try:
                conn.execute(
                    """
                    INSERT INTO post_calls(id, conversation_id, phone, payload)
                    VALUES(?, ?, ?, ?)
                    """,
                    (
                        placeholder["id"],
                        conversation_id,
                        placeholder.get("phone"),
                        json.dumps({**placeholder, "status": "processing"}, ensure_ascii=False),
                    ),
                )
                conn.commit()
                return True, None
            except sqlite3.IntegrityError:
                conn.rollback()
                row = conn.execute(
                    """
                    SELECT payload FROM post_calls
                    WHERE conversation_id=?
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    (conversation_id,),
                ).fetchone()
                if row:
                    return False, json.loads(row["payload"])
                return False, None
        finally:
            conn.close()


def fail_post_call_claim(entry: dict[str, Any]) -> dict[str, Any]:
    """Persist a failed claim with partial effects so retries can resume."""
    init_db()
    entry = {**entry, "status": "failed", "ok": False}
    if "id" not in entry:
        entry["id"] = f"pc_{uuid4().hex[:10]}"
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT OR REPLACE INTO post_calls(id, conversation_id, phone, payload)
                VALUES(?, ?, ?, ?)
                """,
                (
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
    """Mark an in-flight claim as failed (keep row + effects for resume)."""
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT payload FROM post_calls WHERE id=?", (post_call_id,)
            ).fetchone()
            if not row:
                return
            try:
                payload = json.loads(row["payload"])
            except json.JSONDecodeError:
                conn.execute("DELETE FROM post_calls WHERE id=?", (post_call_id,))
                conn.commit()
                return
            if payload.get("status") != "processing":
                return
            payload["status"] = "failed"
            payload["ok"] = False
            if error:
                payload["error"] = error
            conn.execute(
                "UPDATE post_calls SET payload=? WHERE id=?",
                (json.dumps(payload, ensure_ascii=False), post_call_id),
            )
            conn.commit()
        finally:
            conn.close()


def list_post_calls(limit: int = 100) -> list[dict[str, Any]]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT payload FROM post_calls ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def get_post_call_by_conversation(conversation_id: str) -> dict[str, Any] | None:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute(
                """
                SELECT payload FROM post_calls
                WHERE conversation_id=?
                ORDER BY created_at DESC LIMIT 1
                """,
                (conversation_id,),
            ).fetchone()
            return json.loads(row["payload"]) if row else None
        finally:
            conn.close()


def insert_handoff(entry: dict[str, Any]) -> dict[str, Any]:
    init_db()
    if "id" not in entry:
        entry["id"] = f"h_{uuid4().hex[:10]}"
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO handoffs(id, payload) VALUES(?, ?)",
                (entry["id"], json.dumps(entry, ensure_ascii=False)),
            )
            conn.commit()
            return entry
        finally:
            conn.close()


def list_handoffs(limit: int = 50) -> list[dict[str, Any]]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT payload FROM handoffs ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def upsert_crm_lead(lead: dict[str, Any]) -> dict[str, Any]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO crm_leads(id, funnel, column_id, tipificacion, payload)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  funnel=excluded.funnel,
                  column_id=excluded.column_id,
                  tipificacion=excluded.tipificacion,
                  payload=excluded.payload
                """,
                (
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
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            if funnel:
                rows = conn.execute(
                    "SELECT payload FROM crm_leads WHERE funnel=? ORDER BY created_at DESC",
                    (funnel,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT payload FROM crm_leads ORDER BY created_at DESC"
                ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def upsert_conversation_claim(claim: dict[str, Any]) -> dict[str, Any]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO conversation_claims(id, payload) VALUES(?, ?)",
                (claim["id"], json.dumps(claim, ensure_ascii=False)),
            )
            conn.commit()
            return claim
        finally:
            conn.close()


def list_conversation_claims() -> list[dict[str, Any]]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT payload FROM conversation_claims ORDER BY created_at DESC"
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def delete_conversation_claim(conversation_id: str) -> bool:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            cur = conn.execute("DELETE FROM conversation_claims WHERE id=?", (conversation_id,))
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def add_opt_out(phone: str) -> dict[str, Any]:
    from pilot_core.phone import normalize_phone

    init_db()
    phone = normalize_phone(phone) or phone.strip()
    with _LOCK:
        conn = _connect()
        try:
            conn.execute("INSERT OR REPLACE INTO opt_outs(phone) VALUES(?)", (phone,))
            conn.commit()
            return {"phone": phone, "suppressed": True}
        finally:
            conn.close()


def list_opt_outs() -> list[str]:
    from pilot_core.phone import normalize_phone

    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute("SELECT phone FROM opt_outs ORDER BY created_at DESC").fetchall()
            # Normalize on read so legacy mixed formats still match.
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
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO conversation_threads(id, payload) VALUES(?, ?)",
                (thread["id"], json.dumps(thread, ensure_ascii=False)),
            )
            conn.commit()
            return thread
        finally:
            conn.close()


def list_conversation_threads() -> list[dict[str, Any]]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT payload FROM conversation_threads ORDER BY created_at DESC"
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def append_conversation_message(conversation_id: str, message: dict[str, Any]) -> dict[str, Any]:
    init_db()
    if "id" not in message:
        message["id"] = f"m_{uuid4().hex[:10]}"
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO conversation_messages(id, conversation_id, payload)
                VALUES(?, ?, ?)
                """,
                (
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
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT payload FROM conversation_messages
                WHERE conversation_id=?
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (conversation_id, limit),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def counts() -> dict[str, int]:
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
                out[table] = int(conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"])
            return out
        finally:
            conn.close()


def upsert_document(doc: dict[str, Any]) -> dict[str, Any]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO documents(id, contact_phone, payload) VALUES(?, ?, ?)",
                (doc["id"], doc.get("contact_phone"), json.dumps(doc, ensure_ascii=False)),
            )
            conn.commit()
            return doc
        finally:
            conn.close()


def list_documents(limit: int = 100) -> list[dict[str, Any]]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT payload FROM documents ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def set_setting(key: str, value: Any) -> dict[str, Any]:
    init_db()
    payload = json.dumps(value, ensure_ascii=False)
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO settings_kv(key, value) VALUES(?, ?)",
                (key, payload),
            )
            conn.commit()
            return {"key": key, "value": value}
        finally:
            conn.close()


def get_setting(key: str, default: Any = None) -> Any:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            row = conn.execute("SELECT value FROM settings_kv WHERE key=?", (key,)).fetchone()
            if not row:
                return default
            return json.loads(row["value"])
        finally:
            conn.close()


def all_settings() -> dict[str, Any]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute("SELECT key, value FROM settings_kv").fetchall()
            return {r["key"]: json.loads(r["value"]) for r in rows}
        finally:
            conn.close()

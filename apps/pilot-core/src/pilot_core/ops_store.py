"""SQLite persistence for Ops product demo (campaigns, contacts, dispatches)."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

_LOCK = Lock()
_DB_PATH = Path(__file__).resolve().parents[4] / ".local-secrets-tmp" / "pulso_ops.sqlite3"


def _connect() -> sqlite3.Connection:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
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
            conn.commit()
        finally:
            conn.close()


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
            rows = conn.execute(
                "SELECT payload FROM campaigns ORDER BY created_at DESC"
            ).fetchall()
            return [json.loads(r["payload"]) for r in rows]
        finally:
            conn.close()


def insert_contact(contact: dict[str, Any]) -> dict[str, Any]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
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
                    contact["id"],
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
            cur = conn.execute(
                "DELETE FROM conversation_claims WHERE id=?", (conversation_id,)
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def add_opt_out(phone: str) -> dict[str, Any]:
    init_db()
    phone = phone.strip()
    with _LOCK:
        conn = _connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO opt_outs(phone) VALUES(?)", (phone,)
            )
            conn.commit()
            return {"phone": phone, "suppressed": True}
        finally:
            conn.close()


def list_opt_outs() -> list[str]:
    init_db()
    with _LOCK:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT phone FROM opt_outs ORDER BY created_at DESC"
            ).fetchall()
            return [str(r["phone"]) for r in rows]
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


def append_conversation_message(
    conversation_id: str, message: dict[str, Any]
) -> dict[str, Any]:
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


def list_conversation_messages(
    conversation_id: str, limit: int = 200
) -> list[dict[str, Any]]:
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
                out[table] = int(
                    conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"]
                )
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
            row = conn.execute(
                "SELECT value FROM settings_kv WHERE key=?", (key,)
            ).fetchone()
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

"""technical tables: outbox, inbox, probe

Revision ID: 0001_technical
Revises:
Create Date: 2026-07-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0001_technical"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "outbox_events",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("event_id", sa.String(length=36), nullable=False),
        sa.Column("event_type", sa.String(length=128), nullable=False),
        sa.Column("tenant_id", sa.String(length=128), nullable=False),
        sa.Column("producer", sa.String(length=128), nullable=False),
        sa.Column("business_idempotency_key", sa.String(length=256), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_outbox_events"),
        sa.UniqueConstraint("event_id", name="uq_outbox_events_event_id"),
    )
    op.create_index(
        "ix_outbox_events_business_idempotency_key", "outbox_events", ["business_idempotency_key"]
    )
    op.create_index("ix_outbox_events_status", "outbox_events", ["status"])
    op.create_table(
        "inbox_events",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("event_id", sa.String(length=36), nullable=False),
        sa.Column("tenant_id", sa.String(length=128), nullable=False),
        sa.Column("producer", sa.String(length=128), nullable=False),
        sa.Column("business_idempotency_key", sa.String(length=256), nullable=False),
        sa.Column("event_type", sa.String(length=128), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("effect_marker", sa.String(length=128), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_inbox_events"),
        sa.UniqueConstraint("event_id", name="uq_inbox_events_event_id"),
        sa.UniqueConstraint(
            "tenant_id",
            "producer",
            "event_type",
            "business_idempotency_key",
            name="uq_inbox_events_tenant_producer_type_bizkey",
        ),
    )
    op.create_index(
        "ix_inbox_events_business_idempotency_key", "inbox_events", ["business_idempotency_key"]
    )
    op.create_table(
        "technical_probe",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("marker", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_technical_probe"),
    )


def downgrade() -> None:
    op.drop_table("technical_probe")
    op.drop_index("ix_inbox_events_business_idempotency_key", table_name="inbox_events")
    op.drop_table("inbox_events")
    op.drop_index("ix_outbox_events_status", table_name="outbox_events")
    op.drop_index("ix_outbox_events_business_idempotency_key", table_name="outbox_events")
    op.drop_table("outbox_events")

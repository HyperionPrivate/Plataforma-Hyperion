-- One persisted SOFIA message may have at most one WhatsApp outbox row.
-- Abort without deleting or choosing among pre-existing duplicates so an
-- operator can reconcile them explicitly before retrying the migration.

lock table channel_runtime.outbound_messages in share row exclusive mode;

do $$
begin
  if exists (
    select 1
    from channel_runtime.outbound_messages
    group by tenant_id, provider, message_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Cannot enforce unique WhatsApp outbound source message invariant';
  end if;
end;
$$;

create unique index uq_channel_runtime_outbound_source_message
  on channel_runtime.outbound_messages(tenant_id, provider, message_id);

-- A provider receipt can race ahead of the transaction that stores its
-- provider_message_id. Persist the body-free evidence so markOutboundSent can
-- reconcile it atomically instead of losing it or pinning the encrypted spool.
create table channel_runtime.delivery_receipts (
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  provider text not null check (provider in ('whatsapp_web_test')),
  provider_message_id text not null check (char_length(provider_message_id) between 1 and 512),
  status text not null check (status in ('delivered', 'read', 'failed')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (tenant_id, provider, provider_message_id, status)
);

create index ix_channel_runtime_delivery_receipts_retention
  on channel_runtime.delivery_receipts(tenant_id, received_at desc);

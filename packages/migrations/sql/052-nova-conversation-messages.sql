-- Ops Conversaciones: burbujas inbound/outbound (clon LIWA → Hyperion)
create table if not exists nova.conversation_messages (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  conversation_id uuid not null,
  message_id uuid not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null,
  kind text not null default 'text' check (kind in ('text', 'document', 'system')),
  external_id text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, message_id),
  foreign key (tenant_id, conversation_id)
    references nova.conversations(tenant_id, conversation_id) on delete cascade
);

create unique index if not exists ux_nova_conversation_messages_external
  on nova.conversation_messages (tenant_id, external_id)
  where external_id is not null;

create index if not exists ix_nova_conversation_messages_thread
  on nova.conversation_messages (tenant_id, conversation_id, created_at);

grant select, insert, update, delete on all tables in schema nova to hyperion_nova;

insert into nova.service_migrations(version, name)
values (5, '052-nova-conversation-messages.sql')
on conflict (version) do update set name = excluded.name;

update nova.schema_version
set current_version = 5, migration_name = '052-nova-conversation-messages.sql', updated_at = now()
where service_name = 'nova';

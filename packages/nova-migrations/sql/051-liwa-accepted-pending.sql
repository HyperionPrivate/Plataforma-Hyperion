-- AUD-016: LIWA 200 without message_id → accepted_pending (terminal, no infinite redrive)
alter table liwa.messages drop constraint if exists messages_status_check;

alter table liwa.messages
  add constraint messages_status_check
  check (status in ('requested', 'sent', 'accepted_pending', 'delivered', 'failed', 'received'));

grant select, insert, update, delete on all tables in schema liwa to hyperion_liwa;

insert into liwa.service_migrations(version, name)
values (3, '051-liwa-accepted-pending.sql')
on conflict (version) do update set name = excluded.name;

update liwa.schema_version
set current_version = 3, migration_name = '051-liwa-accepted-pending.sql', updated_at = now()
where service_name = 'liwa';



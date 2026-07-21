-- Tenant-owned voice orchestration and contact policy.

alter table nova.compliance_settings
  add column if not exists time_zone text not null default 'America/Bogota',
  add column if not exists allowed_weekdays smallint[] not null default array[1, 2, 3, 4, 5, 6]::smallint[],
  add column if not exists max_attempts_per_day integer not null default 2,
  add column if not exists rolling_window_days integer not null default 7,
  add column if not exists max_concurrent_calls integer not null default 10;

alter table nova.compliance_settings
  alter column window_end_hour set default 19,
  alter column max_attempts_per_contact set default 4,
  alter column min_hours_between_attempts set default 4;

alter table nova.compliance_settings drop constraint if exists compliance_settings_time_zone_check;
alter table nova.compliance_settings
  add constraint compliance_settings_time_zone_check check (length(btrim(time_zone)) between 1 and 80);

alter table nova.compliance_settings drop constraint if exists compliance_settings_allowed_weekdays_check;
alter table nova.compliance_settings
  add constraint compliance_settings_allowed_weekdays_check
  check (
    cardinality(allowed_weekdays) between 1 and 7
    and allowed_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
  );

alter table nova.compliance_settings drop constraint if exists compliance_settings_max_attempts_per_day_check;
alter table nova.compliance_settings
  add constraint compliance_settings_max_attempts_per_day_check check (max_attempts_per_day between 1 and 20);

alter table nova.compliance_settings drop constraint if exists compliance_settings_rolling_window_days_check;
alter table nova.compliance_settings
  add constraint compliance_settings_rolling_window_days_check check (rolling_window_days between 1 and 90);

alter table nova.compliance_settings drop constraint if exists compliance_settings_max_concurrent_calls_check;
alter table nova.compliance_settings
  add constraint compliance_settings_max_concurrent_calls_check check (max_concurrent_calls between 1 and 500);

alter table nova.campaign_enrollments
  add column if not exists next_attempt_at timestamptz,
  add column if not exists last_block_reason text;

alter table nova.contacts
  add column if not exists voice_suppressed_at timestamptz,
  add column if not exists voice_suppression_reason text;

create table if not exists nova.tenant_holidays (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  holiday_date date not null,
  name text not null check (length(btrim(name)) between 1 and 160),
  created_at timestamptz not null default now(),
  primary key (tenant_id, holiday_date)
);

create index if not exists ix_nova_campaign_enrollments_dispatch
  on nova.campaign_enrollments(tenant_id, campaign_id, status, next_attempt_at, last_attempt_at);

grant select, insert, update, delete on all tables in schema nova to hyperion_nova;

insert into nova.service_migrations(version, name)
values (7, '054-nova-voice-orchestration-policy.sql')
on conflict (version) do update set name = excluded.name;

update nova.schema_version
set current_version = 7, migration_name = '054-nova-voice-orchestration-policy.sql', updated_at = now()
where service_name = 'nova';

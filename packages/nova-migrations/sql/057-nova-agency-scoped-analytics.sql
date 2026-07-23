-- Agency-scoped analytics read model for NOVA operator grants.
-- The existing nova.analytics_daily table remains the tenant-wide admin view.
-- Historical tenant-wide aggregates cannot be assigned to a real agency safely,
-- so they are preserved in a reserved bucket that scoped reads always exclude.

do $reserved_bucket_guard$
begin
  if exists (select 1 from nova.agencies where code = '__UNATTRIBUTED__')
     or exists (
       select 1
         from nova.operator_grants
        where '__UNATTRIBUTED__' = any(agency_codes)
     ) then
    raise exception '__UNATTRIBUTED__ is reserved for non-assignable analytics history'
      using errcode = '23514';
  end if;
end
$reserved_bucket_guard$;

alter table nova.agencies
  add constraint agencies_reserved_analytics_bucket_check
  check (code <> '__UNATTRIBUTED__');

alter table nova.operator_grants
  add constraint operator_grants_reserved_analytics_bucket_check
  check (not ('__UNATTRIBUTED__' = any(agency_codes)));

create table if not exists nova.analytics_daily_by_agency (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  agency_code text not null check (length(btrim(agency_code)) between 2 and 40),
  day date not null,
  channel text not null check (channel in ('voice', 'whatsapp', 'all')),
  contacts_imported integer not null default 0,
  calls_requested integer not null default 0,
  calls_completed integer not null default 0,
  calls_failed integer not null default 0,
  wa_sent integer not null default 0,
  leads_contacted integer not null default 0,
  leads_interested integer not null default 0,
  leads_won integer not null default 0,
  leads_lost integer not null default 0,
  handoffs_queued integer not null default 0,
  csat_sum numeric(12,2) not null default 0,
  csat_count integer not null default 0,
  primary key (tenant_id, agency_code, day, channel)
);

create table if not exists nova.analytics_agency_coverage (
  tenant_id uuid primary key references nova.tenant_snapshots(tenant_id) on delete cascade,
  applied_at timestamptz not null,
  coverage_from date not null,
  cutover_time_zone text not null
);

create index if not exists ix_nova_analytics_daily_by_agency_recent
  on nova.analytics_daily_by_agency(tenant_id, agency_code, day desc);

grant select, insert, update, delete on nova.analytics_daily_by_agency to hyperion_nova;
revoke update, delete on nova.analytics_agency_coverage from hyperion_nova;
grant select, insert on nova.analytics_agency_coverage to hyperion_nova;

revoke insert, update, delete on nova.migration_ledger from hyperion_nova;
grant select on nova.migration_ledger to hyperion_nova;

comment on table nova.analytics_daily_by_agency is
  'Agency-attributed analytics. __UNATTRIBUTED__ preserves pre-cutover tenant totals and is never exposed through agency grants.';

comment on table nova.analytics_agency_coverage is
  'Immutable per-tenant agency analytics cutover; coverage_from remains stable if compliance time_zone changes later.';

insert into nova.analytics_agency_coverage (tenant_id, applied_at, coverage_from, cutover_time_zone)
select snapshot.tenant_id,
       now(),
       timezone(coalesce(settings.time_zone, 'America/Bogota'), now())::date + 1,
       coalesce(settings.time_zone, 'America/Bogota')
  from nova.tenant_snapshots snapshot
  left join nova.compliance_settings settings on settings.tenant_id = snapshot.tenant_id
on conflict (tenant_id) do nothing;

create or replace function nova.backfill_agency_analytics_unattributed(
  p_tenant_id uuid
)
returns integer
language plpgsql
as $function$
declare
  affected_rows integer := 0;
  deleted_rows integer := 0;
  has_negative_delta boolean := false;
begin
  if p_tenant_id is not null and not exists (
    select 1 from nova.analytics_agency_coverage where tenant_id = p_tenant_id
  ) then
    raise exception 'agency analytics coverage is not initialized for tenant %', p_tenant_id
      using errcode = '23503';
  end if;

  with agency_totals as (
    select tenant_id, day, channel,
           sum(contacts_imported) as contacts_imported,
           sum(calls_requested) as calls_requested,
           sum(calls_completed) as calls_completed,
           sum(calls_failed) as calls_failed,
           sum(wa_sent) as wa_sent,
           sum(leads_contacted) as leads_contacted,
           sum(leads_interested) as leads_interested,
           sum(leads_won) as leads_won,
           sum(leads_lost) as leads_lost,
           sum(handoffs_queued) as handoffs_queued,
           sum(csat_sum) as csat_sum,
           sum(csat_count) as csat_count
      from nova.analytics_daily_by_agency
     where agency_code <> '__UNATTRIBUTED__'
       and (p_tenant_id is null or tenant_id = p_tenant_id)
     group by tenant_id, day, channel
  )
  select exists (
    select 1
      from agency_totals scoped_daily
      join nova.analytics_agency_coverage coverage
        on coverage.tenant_id = scoped_daily.tenant_id
      left join nova.analytics_daily global_daily
        on global_daily.tenant_id = scoped_daily.tenant_id
       and global_daily.day = scoped_daily.day
       and global_daily.channel = scoped_daily.channel
     where scoped_daily.day < coverage.coverage_from
       and (
         global_daily.tenant_id is null
         or global_daily.contacts_imported < scoped_daily.contacts_imported
         or global_daily.calls_requested < scoped_daily.calls_requested
         or global_daily.calls_completed < scoped_daily.calls_completed
         or global_daily.calls_failed < scoped_daily.calls_failed
         or global_daily.wa_sent < scoped_daily.wa_sent
         or global_daily.leads_contacted < scoped_daily.leads_contacted
         or global_daily.leads_interested < scoped_daily.leads_interested
         or global_daily.leads_won < scoped_daily.leads_won
         or global_daily.leads_lost < scoped_daily.leads_lost
         or global_daily.handoffs_queued < scoped_daily.handoffs_queued
         or global_daily.csat_sum < scoped_daily.csat_sum
         or global_daily.csat_count < scoped_daily.csat_count
       )
  ) into has_negative_delta;

  if has_negative_delta then
    raise exception 'agency analytics exceed the tenant-wide aggregate; refusing unattributed backfill'
      using errcode = '23514';
  end if;

  with agency_totals as (
    select tenant_id, day, channel,
           sum(contacts_imported) as contacts_imported,
           sum(calls_requested) as calls_requested,
           sum(calls_completed) as calls_completed,
           sum(calls_failed) as calls_failed,
           sum(wa_sent) as wa_sent,
           sum(leads_contacted) as leads_contacted,
           sum(leads_interested) as leads_interested,
           sum(leads_won) as leads_won,
           sum(leads_lost) as leads_lost,
           sum(handoffs_queued) as handoffs_queued,
           sum(csat_sum) as csat_sum,
           sum(csat_count) as csat_count
      from nova.analytics_daily_by_agency
     where agency_code <> '__UNATTRIBUTED__'
       and (p_tenant_id is null or tenant_id = p_tenant_id)
     group by tenant_id, day, channel
  ), deltas as (
    select global_daily.tenant_id, global_daily.day, global_daily.channel,
           global_daily.contacts_imported - coalesce(scoped_daily.contacts_imported, 0) as contacts_imported,
           global_daily.calls_requested - coalesce(scoped_daily.calls_requested, 0) as calls_requested,
           global_daily.calls_completed - coalesce(scoped_daily.calls_completed, 0) as calls_completed,
           global_daily.calls_failed - coalesce(scoped_daily.calls_failed, 0) as calls_failed,
           global_daily.wa_sent - coalesce(scoped_daily.wa_sent, 0) as wa_sent,
           global_daily.leads_contacted - coalesce(scoped_daily.leads_contacted, 0) as leads_contacted,
           global_daily.leads_interested - coalesce(scoped_daily.leads_interested, 0) as leads_interested,
           global_daily.leads_won - coalesce(scoped_daily.leads_won, 0) as leads_won,
           global_daily.leads_lost - coalesce(scoped_daily.leads_lost, 0) as leads_lost,
           global_daily.handoffs_queued - coalesce(scoped_daily.handoffs_queued, 0) as handoffs_queued,
           global_daily.csat_sum - coalesce(scoped_daily.csat_sum, 0) as csat_sum,
           global_daily.csat_count - coalesce(scoped_daily.csat_count, 0) as csat_count
      from nova.analytics_daily global_daily
      join nova.analytics_agency_coverage coverage
        on coverage.tenant_id = global_daily.tenant_id
      left join agency_totals scoped_daily
        on scoped_daily.tenant_id = global_daily.tenant_id
       and scoped_daily.day = global_daily.day
       and scoped_daily.channel = global_daily.channel
     where (p_tenant_id is null or global_daily.tenant_id = p_tenant_id)
       and global_daily.day < coverage.coverage_from
  )
  insert into nova.analytics_daily_by_agency (
    tenant_id, agency_code, day, channel, contacts_imported, calls_requested, calls_completed,
    calls_failed, wa_sent, leads_contacted, leads_interested, leads_won, leads_lost,
    handoffs_queued, csat_sum, csat_count
  )
  select tenant_id, '__UNATTRIBUTED__', day, channel, contacts_imported, calls_requested,
         calls_completed, calls_failed, wa_sent, leads_contacted, leads_interested, leads_won,
         leads_lost, handoffs_queued, csat_sum, csat_count
    from deltas
   where contacts_imported <> 0
      or calls_requested <> 0
      or calls_completed <> 0
      or calls_failed <> 0
      or wa_sent <> 0
      or leads_contacted <> 0
      or leads_interested <> 0
      or leads_won <> 0
      or leads_lost <> 0
      or handoffs_queued <> 0
      or csat_sum <> 0
      or csat_count <> 0
  on conflict (tenant_id, agency_code, day, channel) do update set
    contacts_imported = excluded.contacts_imported,
    calls_requested = excluded.calls_requested,
    calls_completed = excluded.calls_completed,
    calls_failed = excluded.calls_failed,
    wa_sent = excluded.wa_sent,
    leads_contacted = excluded.leads_contacted,
    leads_interested = excluded.leads_interested,
    leads_won = excluded.leads_won,
    leads_lost = excluded.leads_lost,
    handoffs_queued = excluded.handoffs_queued,
    csat_sum = excluded.csat_sum,
    csat_count = excluded.csat_count
  where (
    nova.analytics_daily_by_agency.contacts_imported,
    nova.analytics_daily_by_agency.calls_requested,
    nova.analytics_daily_by_agency.calls_completed,
    nova.analytics_daily_by_agency.calls_failed,
    nova.analytics_daily_by_agency.wa_sent,
    nova.analytics_daily_by_agency.leads_contacted,
    nova.analytics_daily_by_agency.leads_interested,
    nova.analytics_daily_by_agency.leads_won,
    nova.analytics_daily_by_agency.leads_lost,
    nova.analytics_daily_by_agency.handoffs_queued,
    nova.analytics_daily_by_agency.csat_sum,
    nova.analytics_daily_by_agency.csat_count
  ) is distinct from (
    excluded.contacts_imported,
    excluded.calls_requested,
    excluded.calls_completed,
    excluded.calls_failed,
    excluded.wa_sent,
    excluded.leads_contacted,
    excluded.leads_interested,
    excluded.leads_won,
    excluded.leads_lost,
    excluded.handoffs_queued,
    excluded.csat_sum,
    excluded.csat_count
  );

  get diagnostics affected_rows = row_count;

  with agency_totals as (
    select tenant_id, day, channel,
           sum(contacts_imported) as contacts_imported,
           sum(calls_requested) as calls_requested,
           sum(calls_completed) as calls_completed,
           sum(calls_failed) as calls_failed,
           sum(wa_sent) as wa_sent,
           sum(leads_contacted) as leads_contacted,
           sum(leads_interested) as leads_interested,
           sum(leads_won) as leads_won,
           sum(leads_lost) as leads_lost,
           sum(handoffs_queued) as handoffs_queued,
           sum(csat_sum) as csat_sum,
           sum(csat_count) as csat_count
      from nova.analytics_daily_by_agency
     where agency_code <> '__UNATTRIBUTED__'
       and (p_tenant_id is null or tenant_id = p_tenant_id)
     group by tenant_id, day, channel
  )
  delete from nova.analytics_daily_by_agency bucket
   using nova.analytics_agency_coverage coverage
   where bucket.tenant_id = coverage.tenant_id
     and bucket.agency_code = '__UNATTRIBUTED__'
     and bucket.day < coverage.coverage_from
     and (p_tenant_id is null or bucket.tenant_id = p_tenant_id)
     and (
       not exists (
         select 1
           from nova.analytics_daily global_daily
           left join agency_totals scoped_daily
             on scoped_daily.tenant_id = global_daily.tenant_id
            and scoped_daily.day = global_daily.day
            and scoped_daily.channel = global_daily.channel
          where global_daily.tenant_id = bucket.tenant_id
            and global_daily.day = bucket.day
            and global_daily.channel = bucket.channel
            and (
              global_daily.contacts_imported - coalesce(scoped_daily.contacts_imported, 0) <> 0
              or global_daily.calls_requested - coalesce(scoped_daily.calls_requested, 0) <> 0
              or global_daily.calls_completed - coalesce(scoped_daily.calls_completed, 0) <> 0
              or global_daily.calls_failed - coalesce(scoped_daily.calls_failed, 0) <> 0
              or global_daily.wa_sent - coalesce(scoped_daily.wa_sent, 0) <> 0
              or global_daily.leads_contacted - coalesce(scoped_daily.leads_contacted, 0) <> 0
              or global_daily.leads_interested - coalesce(scoped_daily.leads_interested, 0) <> 0
              or global_daily.leads_won - coalesce(scoped_daily.leads_won, 0) <> 0
              or global_daily.leads_lost - coalesce(scoped_daily.leads_lost, 0) <> 0
              or global_daily.handoffs_queued - coalesce(scoped_daily.handoffs_queued, 0) <> 0
              or global_daily.csat_sum - coalesce(scoped_daily.csat_sum, 0) <> 0
              or global_daily.csat_count - coalesce(scoped_daily.csat_count, 0) <> 0
            )
       )
     );
  get diagnostics deleted_rows = row_count;
  affected_rows := affected_rows + deleted_rows;
  return affected_rows;
end
$function$;

revoke all on function nova.backfill_agency_analytics_unattributed(uuid) from public;

-- now() is transaction-stable, so persisted applied_at values equal the ledger
-- applied_at written by the runner immediately after this migration succeeds.
select nova.backfill_agency_analytics_unattributed(null);

insert into nova.service_migrations(version, name)
values (10, '057-nova-agency-scoped-analytics.sql')
on conflict (version) do update set name = excluded.name;

update nova.schema_version
set current_version = 10,
    migration_name = '057-nova-agency-scoped-analytics.sql',
    updated_at = now()
where service_name = 'nova';

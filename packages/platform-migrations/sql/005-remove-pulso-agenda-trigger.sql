-- Access owns platform.tenants. Remove the historical product callback from
-- the Access write path; PULSO now initializes its defaults on first use.

drop trigger if exists trg_initialize_agenda_settings on platform.tenants;

do $migration$
begin
  if exists (
    select 1
      from pg_catalog.pg_trigger trigger_row
     where trigger_row.tgrelid = 'platform.tenants'::regclass
       and trigger_row.tgname = 'trg_initialize_agenda_settings'
       and not trigger_row.tgisinternal
  ) then
    raise exception using
      errcode = '23514',
      message = 'Access tenant table still has the historical PULSO agenda trigger';
  end if;
end
$migration$;

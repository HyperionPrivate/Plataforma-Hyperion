-- Keep audit evidence append-only across the Access boundary.
-- tenant_id is an immutable external identifier; deleting an Access tenant must
-- not rewrite historical Audit rows through a cascading foreign-key action.

alter table platform.audit_events
  drop constraint if exists audit_events_tenant_id_fkey;

do $$
begin
  if exists (
    select 1
      from pg_constraint constraint_record
     where constraint_record.contype = 'f'
       and constraint_record.conrelid = 'platform.audit_events'::regclass
       and constraint_record.confrelid = 'platform.tenants'::regclass
  ) then
    raise exception 'Audit ledger must not retain a foreign key to Access tenants';
  end if;
end
$$;

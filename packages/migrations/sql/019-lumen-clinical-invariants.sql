-- LUMEN remains a synthetic-only clinical demo until a separate production
-- data-governance migration explicitly changes this boundary.

do $$
begin
  if exists (
    select 1
    from lumen.encounters e
    left join pulso_iris.administrative_patients patient
      on patient.tenant_id = e.tenant_id and patient.id = e.patient_id
    left join pulso_iris.professionals professional
      on professional.tenant_id = e.tenant_id and professional.id = e.professional_id
    where not e.is_demo
      or e.demo_key is null
      or coalesce(e.metadata->>'synthetic', 'false') <> 'true'
      or coalesce(patient.metadata->>'is_demo', 'false') <> 'true'
      or coalesce(professional.metadata->>'is_demo', 'false') <> 'true'
  ) then
    raise exception using errcode = '23514', message = 'LUMEN contains non-synthetic encounter data';
  end if;

  if exists (select 1 from lumen.clinical_records where status = 'approved')
    or exists (select 1 from lumen.encounters where status = 'approved') then
    raise exception using
      errcode = '23514',
      message = 'existing LUMEN approvals require controlled review before applying invariants';
  end if;

  if exists (select 1 from lumen.clinical_records where dictation_id is null) then
    raise exception using
      errcode = '23514',
      message = 'existing LUMEN records require dictation lineage before applying invariants';
  end if;
end;
$$;

create unique index if not exists uq_lumen_demo_patient_key
  on pulso_iris.administrative_patients(tenant_id, (metadata->>'lumenDemoKey'))
  where metadata ? 'lumenDemoKey';

create unique index if not exists uq_lumen_demo_professional_key
  on pulso_iris.professionals(tenant_id, (metadata->>'lumenDemoKey'))
  where metadata ? 'lumenDemoKey';

alter table lumen.encounters
  add constraint ck_lumen_encounter_synthetic_only check (
    is_demo
    and demo_key is not null
    and coalesce(metadata->>'synthetic', 'false') = 'true'
  );

create or replace function lumen.guard_synthetic_encounter()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'approved'
      and exists (select 1 from platform.tenants tenant where tenant.id = old.tenant_id) then
      raise exception using errcode = '23514', message = 'approved LUMEN encounters are immutable';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.status = 'approved' then
    raise exception using errcode = '23514', message = 'approved LUMEN encounters are immutable';
  end if;

  if new.status = 'approved' then
    if tg_op = 'INSERT'
      or not exists (
        select 1 from lumen.clinical_records record
        where record.tenant_id = new.tenant_id
          and record.encounter_id = new.id
          and record.status = 'approved'
      ) then
      raise exception using errcode = '23514', message = 'LUMEN encounter approval requires an approved record';
    end if;
  end if;

  if not new.is_demo
    or new.demo_key is null
    or coalesce(new.metadata->>'synthetic', 'false') <> 'true' then
    raise exception using errcode = '23514', message = 'LUMEN encounters must be explicitly synthetic';
  end if;

  if not exists (
    select 1
    from pulso_iris.administrative_patients patient
    where patient.tenant_id = new.tenant_id
      and patient.id = new.patient_id
      and coalesce(patient.metadata->>'is_demo', 'false') = 'true'
  ) then
    raise exception using errcode = '23514', message = 'LUMEN patient must be synthetic and tenant-scoped';
  end if;

  if not exists (
    select 1
    from pulso_iris.professionals professional
    where professional.tenant_id = new.tenant_id
      and professional.id = new.professional_id
      and coalesce(professional.metadata->>'is_demo', 'false') = 'true'
  ) then
    raise exception using errcode = '23514', message = 'LUMEN professional must be synthetic and tenant-scoped';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_synthetic_encounter on lumen.encounters;
create trigger trg_guard_synthetic_encounter
before insert or update or delete on lumen.encounters
for each row execute function lumen.guard_synthetic_encounter();

create or replace function lumen.guard_synthetic_reference()
returns trigger
language plpgsql
as $$
declare
  is_referenced boolean;
begin
  if tg_table_name = 'administrative_patients' then
    select exists (
      select 1 from lumen.encounters encounter
      where encounter.tenant_id = old.tenant_id and encounter.patient_id = old.id
    ) into is_referenced;
  else
    select exists (
      select 1 from lumen.encounters encounter
      where encounter.tenant_id = old.tenant_id and encounter.professional_id = old.id
    ) into is_referenced;
  end if;

  if is_referenced and (
    new.tenant_id is distinct from old.tenant_id
    or new.id is distinct from old.id
    or coalesce(new.metadata->>'is_demo', 'false') <> 'true'
    or (
      old.metadata ? 'lumenDemoKey'
      and new.metadata->>'lumenDemoKey' is distinct from old.metadata->>'lumenDemoKey'
    )
  ) then
    raise exception using errcode = '23514', message = 'referenced LUMEN identities must remain synthetic';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_lumen_patient_reference on pulso_iris.administrative_patients;
create trigger trg_guard_lumen_patient_reference
before update of tenant_id, id, metadata on pulso_iris.administrative_patients
for each row execute function lumen.guard_synthetic_reference();

drop trigger if exists trg_guard_lumen_professional_reference on pulso_iris.professionals;
create trigger trg_guard_lumen_professional_reference
before update of tenant_id, id, metadata on pulso_iris.professionals
for each row execute function lumen.guard_synthetic_reference();

alter table lumen.dictations
  add constraint uq_lumen_dictation_encounter_identity unique (tenant_id, encounter_id, id);

alter table lumen.clinical_records
  drop constraint fk_lumen_record_dictation_tenant;

alter table lumen.clinical_records
  add constraint fk_lumen_record_dictation_encounter
    foreign key (tenant_id, encounter_id, dictation_id)
      references lumen.dictations(tenant_id, encounter_id, id) on delete restrict;

alter table lumen.clinical_records
  alter column dictation_id set not null;

alter table lumen.clinical_records
  add constraint fk_lumen_record_approver
    foreign key (approved_by) references platform.operators(id) on delete restrict;

alter table lumen.clinical_records
  add constraint ck_lumen_record_approval_fields check (
    (status = 'draft' and approved_by is null and approved_at is null)
    or (status = 'approved' and approved_by is not null and approved_at is not null)
  );

create or replace function lumen.guard_clinical_record()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'DELETE' and not exists (
    select 1
    from lumen.dictations dictation
    where dictation.tenant_id = new.tenant_id
      and dictation.encounter_id = new.encounter_id
      and dictation.id = new.dictation_id
      and dictation.status = 'transcribed'
      and btrim(dictation.transcript) <> ''
  ) then
    raise exception using errcode = '23514', message = 'LUMEN record requires a completed dictation from the same encounter';
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'approved' or new.approved_by is not null or new.approved_at is not null then
      raise exception using errcode = '23514', message = 'LUMEN records must be approved by transition';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'approved'
      and exists (select 1 from platform.tenants tenant where tenant.id = old.tenant_id) then
      raise exception using errcode = '23514', message = 'approved LUMEN records are immutable';
    end if;
    return old;
  end if;

  if old.status = 'approved' then
    raise exception using errcode = '23514', message = 'approved LUMEN records are immutable';
  end if;

  if new.status = 'approved' then
    if old.status <> 'draft' then
      raise exception using errcode = '23514', message = 'invalid LUMEN approval transition';
    end if;
    perform 1
    from lumen.encounters encounter
    where encounter.tenant_id = new.tenant_id
      and encounter.id = new.encounter_id
      and encounter.status = 'review'
    for update;
    if not found then
      raise exception using errcode = '23514', message = 'LUMEN encounter is not ready for approval';
    end if;
    if not exists (
      select 1 from platform.operators operator
      where operator.id = new.approved_by
        and operator.status = 'active'
        and (
          operator.role = 'admin'
          or (
            operator.role in ('coordinator', 'advisor')
            and exists (
              select 1 from platform.operator_tenants membership
              where membership.operator_id = operator.id and membership.tenant_id = new.tenant_id
            )
          )
        )
    ) then
      raise exception using errcode = '23514', message = 'LUMEN approver is not authorized for tenant';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_clinical_record on lumen.clinical_records;
create trigger trg_guard_clinical_record
before insert or update or delete on lumen.clinical_records
for each row execute function lumen.guard_clinical_record();

create or replace function lumen.finalize_clinical_record_approval()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'draft' and new.status = 'approved' then
    update lumen.encounters
    set status = 'approved', updated_at = now()
    where tenant_id = new.tenant_id and id = new.encounter_id;

    insert into platform.audit_events
      (tenant_id, actor_id, event_type, entity_type, entity_id, metadata)
    values (
      new.tenant_id,
      new.approved_by::text,
      'lumen.record.approved',
      'lumen_clinical_record',
      new.id::text,
      jsonb_build_object('encounterId', new.encounter_id::text, 'schemaVersion', new.schema_version)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_finalize_clinical_record_approval on lumen.clinical_records;
create trigger trg_finalize_clinical_record_approval
after update of status on lumen.clinical_records
for each row execute function lumen.finalize_clinical_record_approval();

create or replace function lumen.guard_approved_dictation()
returns trigger
language plpgsql
as $$
declare
  locked_encounter record;
begin
  if tg_op = 'UPDATE' then
    for locked_encounter in
      select encounter.tenant_id, encounter.id, encounter.status
      from lumen.encounters encounter
      where (encounter.tenant_id = old.tenant_id and encounter.id = old.encounter_id)
         or (encounter.tenant_id = new.tenant_id and encounter.id = new.encounter_id)
      order by encounter.tenant_id, encounter.id
      for update
    loop
      if locked_encounter.status = 'approved' then
        raise exception using errcode = '23514', message = 'approved LUMEN encounter dictations are immutable';
      end if;
    end loop;
  elsif tg_op = 'INSERT' then
    for locked_encounter in
      select encounter.tenant_id, encounter.id, encounter.status
      from lumen.encounters encounter
      where encounter.tenant_id = new.tenant_id and encounter.id = new.encounter_id
      for update
    loop
      if locked_encounter.status = 'approved' then
        raise exception using errcode = '23514', message = 'approved LUMEN encounter dictations are immutable';
      end if;
    end loop;
  else
    for locked_encounter in
      select encounter.tenant_id, encounter.id, encounter.status
      from lumen.encounters encounter
      where encounter.tenant_id = old.tenant_id and encounter.id = old.encounter_id
      for update
    loop
      if locked_encounter.status = 'approved'
        and exists (select 1 from platform.tenants tenant where tenant.id = old.tenant_id) then
        raise exception using errcode = '23514', message = 'approved LUMEN encounter dictations are immutable';
      end if;
    end loop;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_approved_dictation on lumen.dictations;
create trigger trg_guard_approved_dictation
before insert or update or delete on lumen.dictations
for each row execute function lumen.guard_approved_dictation();

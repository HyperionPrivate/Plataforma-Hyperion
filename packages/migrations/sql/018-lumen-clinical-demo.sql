create schema if not exists lumen;

insert into platform.products (code, name, status, owner_service, metadata)
values (
  'LUMEN',
  'LUMEN',
  'building',
  'lumen-service',
  '{"mode":"clinical_demo","syntheticDataOnly":true}'::jsonb
)
on conflict (code) do update set
  name = excluded.name,
  status = excluded.status,
  owner_service = excluded.owner_service,
  metadata = platform.products.metadata || excluded.metadata,
  updated_at = now();

create table if not exists lumen.encounters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  patient_id uuid not null,
  professional_id uuid not null,
  site_id uuid not null,
  status text not null default 'preconsultation'
    check (status in ('preconsultation', 'in_progress', 'review', 'approved')),
  scheduled_at timestamptz not null,
  is_demo boolean not null default false,
  demo_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_lumen_encounter_patient_tenant
    foreign key (tenant_id, patient_id)
      references pulso_iris.administrative_patients(tenant_id, id) on delete restrict,
  constraint fk_lumen_encounter_professional_tenant
    foreign key (tenant_id, professional_id)
      references pulso_iris.professionals(tenant_id, id) on delete restrict,
  constraint fk_lumen_encounter_site_tenant
    foreign key (tenant_id, site_id)
      references pulso_iris.sites(tenant_id, id) on delete restrict,
  unique (tenant_id, id)
);

create unique index if not exists uq_lumen_encounters_demo_key
  on lumen.encounters(tenant_id, demo_key)
  where demo_key is not null;

create index if not exists idx_lumen_encounters_worklist
  on lumen.encounters(tenant_id, scheduled_at, status);

create table if not exists lumen.preconsultation_summaries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  encounter_id uuid not null,
  content jsonb not null,
  source_count integer not null default 0 check (source_count >= 0),
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_lumen_preconsultation_encounter_tenant
    foreign key (tenant_id, encounter_id)
      references lumen.encounters(tenant_id, id) on delete cascade,
  unique (tenant_id, encounter_id),
  unique (tenant_id, id)
);

create table if not exists lumen.dictations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  encounter_id uuid not null,
  status text not null check (status in ('transcribed', 'failed')),
  transcript text not null default '',
  mime_type text not null,
  provider text,
  model text,
  duration_seconds integer check (duration_seconds between 1 and 90),
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint fk_lumen_dictation_encounter_tenant
    foreign key (tenant_id, encounter_id)
      references lumen.encounters(tenant_id, id) on delete cascade,
  unique (tenant_id, id)
);

create index if not exists idx_lumen_dictations_encounter
  on lumen.dictations(tenant_id, encounter_id, created_at desc);

create table if not exists lumen.clinical_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  encounter_id uuid not null,
  dictation_id uuid,
  status text not null default 'draft' check (status in ('draft', 'approved')),
  schema_version text not null default 'ophthalmology-demo-v1',
  content jsonb not null,
  provider text,
  model text,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_lumen_record_encounter_tenant
    foreign key (tenant_id, encounter_id)
      references lumen.encounters(tenant_id, id) on delete cascade,
  constraint fk_lumen_record_dictation_tenant
    foreign key (tenant_id, dictation_id)
      references lumen.dictations(tenant_id, id) on delete restrict,
  unique (tenant_id, encounter_id),
  unique (tenant_id, id),
  check ((status = 'approved') = (approved_at is not null and approved_by is not null)),
  constraint ck_lumen_record_approval_ready check (
    status <> 'approved' or (
      jsonb_typeof(content->'uncertainties') = 'array'
      and jsonb_array_length(
        case
          when jsonb_typeof(content->'uncertainties') = 'array' then content->'uncertainties'
          else '[null]'::jsonb
        end
      ) = 0
      and (
        btrim(coalesce(content->>'reasonForVisit', '')) <> ''
        or btrim(coalesce(content->>'history', '')) <> ''
      )
    )
  )
);

create index if not exists idx_lumen_records_status
  on lumen.clinical_records(tenant_id, status, updated_at desc);

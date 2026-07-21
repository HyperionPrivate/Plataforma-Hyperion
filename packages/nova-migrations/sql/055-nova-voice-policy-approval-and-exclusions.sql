-- Fail-closed voice policy approvals and complete exclusion-registry snapshots.

alter table nova.compliance_settings
  add column if not exists policy_revision bigint not null default 1
    check (policy_revision > 0);

create or replace function nova.bump_compliance_policy_revision()
returns trigger
language plpgsql
as $$
declare
  old_revision bigint := ((to_jsonb(old) ->> 'policy_revision')::bigint);
  requested_revision bigint := ((to_jsonb(new) ->> 'policy_revision')::bigint);
  ignored_keys text[] := array['policy_revision', 'updated_at', 'meta_contactos_hoy'];
begin
  if requested_revision is distinct from old_revision then
    raise exception 'policy_revision is managed by nova.bump_compliance_policy_revision';
  end if;

  if (to_jsonb(new) - ignored_keys) is distinct from (to_jsonb(old) - ignored_keys) then
    new := jsonb_populate_record(
      new,
      jsonb_build_object('policy_revision', old_revision + 1)
    );
  end if;
  return new;
end;
$$;

revoke all on function nova.bump_compliance_policy_revision() from public;
revoke all on function nova.bump_compliance_policy_revision() from hyperion_nova;

drop trigger if exists trg_nova_compliance_policy_revision on nova.compliance_settings;
create trigger trg_nova_compliance_policy_revision
before update on nova.compliance_settings
for each row execute function nova.bump_compliance_policy_revision();

create table if not exists nova.voice_policy_approvals (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  policy_revision bigint not null check (policy_revision > 0),
  policy_sha256 text not null check (policy_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'approved' check (status in ('approved', 'revoked')),
  approved_by text not null check (length(btrim(approved_by)) between 3 and 200),
  approved_at timestamptz not null default now(),
  approval_receipt_sha256 text not null check (approval_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  approval_signature_sha256 text not null check (approval_signature_sha256 ~ '^[a-f0-9]{64}$'),
  signer_key_sha256 text not null check (signer_key_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  revoked_by text,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, policy_revision),
  check (expires_at > approved_at),
  check (expires_at <= approved_at + interval '366 days'),
  check (
    (status = 'approved' and revoked_by is null and revoked_at is null and revocation_reason is null)
    or
    (status = 'revoked' and length(btrim(revoked_by)) between 3 and 200
      and revoked_at is not null and length(btrim(revocation_reason)) between 3 and 500)
  )
);

create table if not exists nova.exclusion_registry_runs (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  run_id uuid not null,
  source text not null check (length(btrim(source)) between 2 and 120),
  status text not null check (status in ('ready', 'superseded', 'revoked')),
  completed_at timestamptz not null,
  valid_until timestamptz not null,
  source_receipt_sha256 text not null check (source_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  source_signature_sha256 text not null check (source_signature_sha256 ~ '^[a-f0-9]{64}$'),
  signer_key_sha256 text not null check (signer_key_sha256 ~ '^[a-f0-9]{64}$'),
  record_count integer not null check (record_count >= 0),
  imported_by text not null check (length(btrim(imported_by)) between 3 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, run_id),
  check (valid_until > completed_at)
);

create unique index if not exists ux_nova_exclusion_registry_ready
  on nova.exclusion_registry_runs(tenant_id) where status = 'ready';

create table if not exists nova.exclusion_registry_entries (
  tenant_id uuid not null,
  run_id uuid not null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  reason text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, run_id, phone_e164),
  foreign key (tenant_id, run_id)
    references nova.exclusion_registry_runs(tenant_id, run_id) on delete cascade
);

create index if not exists ix_nova_exclusion_registry_lookup
  on nova.exclusion_registry_entries(tenant_id, phone_e164, run_id);

create table if not exists nova.voice_cutover_receipts (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  gate_name text not null check (gate_name in (
    'retention_policy',
    'monitoring_on_call',
    'coordinated_recovery',
    'release_artifact',
    'provider_connectivity',
    'consented_test_call'
  )),
  subject_ref text not null check (length(btrim(subject_ref)) between 1 and 300),
  scope_sha256 text not null check (scope_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_sha256 text not null check (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  signature_sha256 text not null check (signature_sha256 ~ '^[a-f0-9]{64}$'),
  signer_key_sha256 text not null check (signer_key_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'current' check (status in ('current', 'superseded', 'revoked')),
  attested_by text not null check (length(btrim(attested_by)) between 3 and 200),
  attested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, gate_name, scope_sha256),
  check (expires_at > attested_at),
  check (expires_at <= attested_at + interval '30 days')
);

create unique index if not exists ux_nova_voice_cutover_receipt_current
  on nova.voice_cutover_receipts(tenant_id, gate_name) where status = 'current';

grant select on nova.voice_policy_approvals,
  nova.exclusion_registry_runs,
  nova.exclusion_registry_entries,
  nova.voice_cutover_receipts to hyperion_nova;
revoke insert, update, delete, truncate on nova.voice_policy_approvals,
  nova.exclusion_registry_runs,
  nova.exclusion_registry_entries,
  nova.voice_cutover_receipts from hyperion_nova;

-- The runtime updates tenant projections but must not erase governance evidence
-- through the ON DELETE CASCADE foreign keys above.
revoke delete on nova.tenant_snapshots from hyperion_nova;

insert into nova.service_migrations(version, name)
values (8, '055-nova-voice-policy-approval-and-exclusions.sql')
on conflict (version) do update set name = excluded.name;

update nova.schema_version
set current_version = 8,
    migration_name = '055-nova-voice-policy-approval-and-exclusions.sql',
    updated_at = now()
where service_name = 'nova';

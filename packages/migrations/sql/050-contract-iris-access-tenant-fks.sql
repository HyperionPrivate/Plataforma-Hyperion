-- Append-only contract: drop PULSO Iris→Access tenant FKs from the global chain.

ALTER TABLE pulso_iris.administrative_patients
  DROP CONSTRAINT IF EXISTS administrative_patients_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.administrative_patients'::regclass
       AND constraint_record.conname = 'administrative_patients_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key administrative_patients_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.agenda_blocks
  DROP CONSTRAINT IF EXISTS agenda_blocks_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.agenda_blocks'::regclass
       AND constraint_record.conname = 'agenda_blocks_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key agenda_blocks_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.agenda_settings
  DROP CONSTRAINT IF EXISTS agenda_settings_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.agenda_settings'::regclass
       AND constraint_record.conname = 'agenda_settings_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key agenda_settings_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.appointment_holds
  DROP CONSTRAINT IF EXISTS appointment_holds_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.appointment_holds'::regclass
       AND constraint_record.conname = 'appointment_holds_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key appointment_holds_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.appointment_status_history
  DROP CONSTRAINT IF EXISTS appointment_status_history_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.appointment_status_history'::regclass
       AND constraint_record.conname = 'appointment_status_history_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key appointment_status_history_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.appointment_types
  DROP CONSTRAINT IF EXISTS appointment_types_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.appointment_types'::regclass
       AND constraint_record.conname = 'appointment_types_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key appointment_types_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.appointments
  DROP CONSTRAINT IF EXISTS appointments_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.appointments'::regclass
       AND constraint_record.conname = 'appointments_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key appointments_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.availability_rules
  DROP CONSTRAINT IF EXISTS availability_rules_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.availability_rules'::regclass
       AND constraint_record.conname = 'availability_rules_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key availability_rules_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.campaign_contacts
  DROP CONSTRAINT IF EXISTS campaign_contacts_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.campaign_contacts'::regclass
       AND constraint_record.conname = 'campaign_contacts_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key campaign_contacts_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.campaigns'::regclass
       AND constraint_record.conname = 'campaigns_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key campaigns_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.configuration_imports
  DROP CONSTRAINT IF EXISTS configuration_imports_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.configuration_imports'::regclass
       AND constraint_record.conname = 'configuration_imports_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key configuration_imports_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.conversations
  DROP CONSTRAINT IF EXISTS conversations_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.conversations'::regclass
       AND constraint_record.conname = 'conversations_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key conversations_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.handoffs
  DROP CONSTRAINT IF EXISTS handoffs_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.handoffs'::regclass
       AND constraint_record.conname = 'handoffs_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key handoffs_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.holidays
  DROP CONSTRAINT IF EXISTS holidays_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.holidays'::regclass
       AND constraint_record.conname = 'holidays_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key holidays_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.operational_kpi_snapshots
  DROP CONSTRAINT IF EXISTS operational_kpi_snapshots_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.operational_kpi_snapshots'::regclass
       AND constraint_record.conname = 'operational_kpi_snapshots_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key operational_kpi_snapshots_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.payers
  DROP CONSTRAINT IF EXISTS payers_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.payers'::regclass
       AND constraint_record.conname = 'payers_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key payers_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.professional_appointment_types
  DROP CONSTRAINT IF EXISTS professional_appointment_types_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.professional_appointment_types'::regclass
       AND constraint_record.conname = 'professional_appointment_types_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key professional_appointment_types_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.professional_payer_exclusions
  DROP CONSTRAINT IF EXISTS professional_payer_exclusions_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.professional_payer_exclusions'::regclass
       AND constraint_record.conname = 'professional_payer_exclusions_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key professional_payer_exclusions_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.professional_sites
  DROP CONSTRAINT IF EXISTS professional_sites_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.professional_sites'::regclass
       AND constraint_record.conname = 'professional_sites_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key professional_sites_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.professionals
  DROP CONSTRAINT IF EXISTS professionals_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.professionals'::regclass
       AND constraint_record.conname = 'professionals_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key professionals_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.rpa_actions
  DROP CONSTRAINT IF EXISTS rpa_actions_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.rpa_actions'::regclass
       AND constraint_record.conname = 'rpa_actions_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key rpa_actions_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.rpa_events
  DROP CONSTRAINT IF EXISTS rpa_events_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.rpa_events'::regclass
       AND constraint_record.conname = 'rpa_events_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key rpa_events_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.rpa_workers
  DROP CONSTRAINT IF EXISTS rpa_workers_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.rpa_workers'::regclass
       AND constraint_record.conname = 'rpa_workers_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key rpa_workers_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.sites
  DROP CONSTRAINT IF EXISTS sites_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.sites'::regclass
       AND constraint_record.conname = 'sites_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key sites_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE pulso_iris.waitlist
  DROP CONSTRAINT IF EXISTS waitlist_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'pulso_iris.waitlist'::regclass
       AND constraint_record.conname = 'waitlist_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'PULSO Iris must not retain foreign key waitlist_tenant_id_fkey';
  END IF;
END
$$;

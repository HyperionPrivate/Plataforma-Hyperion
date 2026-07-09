-- Aislamiento multi-tenant para PULSO IRIS.
-- Cada referencia interna del esquema pulso_iris debe apuntar a una fila del
-- mismo tenant. Esto evita enlaces cruzados incluso si alguien conoce UUIDs.

-- Backfill de tenant en mensajes (la conversacion es obligatoria).
alter table pulso_iris.messages
  add column if not exists tenant_id uuid;

update pulso_iris.messages m
set tenant_id = c.tenant_id
from pulso_iris.conversations c
where m.conversation_id = c.id
  and m.tenant_id is null;

alter table pulso_iris.messages
  alter column tenant_id set not null;

-- Las FKs compuestas necesitan una llave unica (tenant_id, id) en cada tabla referenciada.
create unique index if not exists uq_pulso_iris_sites_tenant_id_id on pulso_iris.sites(tenant_id, id);
create unique index if not exists uq_pulso_iris_professionals_tenant_id_id on pulso_iris.professionals(tenant_id, id);
create unique index if not exists uq_pulso_iris_payers_tenant_id_id on pulso_iris.payers(tenant_id, id);
create unique index if not exists uq_pulso_iris_patients_tenant_id_id on pulso_iris.administrative_patients(tenant_id, id);
create unique index if not exists uq_pulso_iris_conversations_tenant_id_id on pulso_iris.conversations(tenant_id, id);
create unique index if not exists uq_pulso_iris_appointments_tenant_id_id on pulso_iris.appointments(tenant_id, id);
create unique index if not exists uq_pulso_iris_handoffs_tenant_id_id on pulso_iris.handoffs(tenant_id, id);
create unique index if not exists uq_pulso_iris_rpa_actions_tenant_id_id on pulso_iris.rpa_actions(tenant_id, id);
create unique index if not exists uq_pulso_iris_rpa_workers_tenant_id_id on pulso_iris.rpa_workers(tenant_id, id);
create unique index if not exists uq_pulso_iris_campaigns_tenant_id_id on pulso_iris.campaigns(tenant_id, id);
create unique index if not exists uq_pulso_iris_appointment_types_tenant_id_id on pulso_iris.appointment_types(tenant_id, id);

-- Quitar FKs simples antiguas (nombres autogenerados por Postgres).
alter table pulso_iris.conversations
  drop constraint if exists conversations_patient_id_fkey,
  drop constraint if exists conversations_site_id_fkey;

alter table pulso_iris.messages
  drop constraint if exists messages_conversation_id_fkey;

alter table pulso_iris.appointments
  drop constraint if exists appointments_patient_id_fkey,
  drop constraint if exists appointments_conversation_id_fkey,
  drop constraint if exists appointments_site_id_fkey,
  drop constraint if exists appointments_professional_id_fkey,
  drop constraint if exists appointments_payer_id_fkey,
  drop constraint if exists appointments_appointment_type_id_fkey;

alter table pulso_iris.rpa_actions
  drop constraint if exists rpa_actions_appointment_id_fkey,
  drop constraint if exists rpa_actions_conversation_id_fkey,
  drop constraint if exists rpa_actions_worker_id_fkey;

alter table pulso_iris.rpa_events
  drop constraint if exists rpa_events_worker_id_fkey;

alter table pulso_iris.handoffs
  drop constraint if exists handoffs_patient_id_fkey,
  drop constraint if exists handoffs_conversation_id_fkey;

alter table pulso_iris.campaign_contacts
  drop constraint if exists campaign_contacts_campaign_id_fkey,
  drop constraint if exists campaign_contacts_patient_id_fkey,
  drop constraint if exists campaign_contacts_appointment_id_fkey;

alter table pulso_iris.waitlist
  drop constraint if exists waitlist_patient_id_fkey,
  drop constraint if exists waitlist_appointment_type_id_fkey;

-- FKs compuestas: MATCH SIMPLE permite referencias opcionales cuando el id es null.
alter table pulso_iris.conversations
  add constraint fk_conversations_patient_tenant
    foreign key (tenant_id, patient_id) references pulso_iris.administrative_patients(tenant_id, id),
  add constraint fk_conversations_site_tenant
    foreign key (tenant_id, site_id) references pulso_iris.sites(tenant_id, id);

alter table pulso_iris.messages
  add constraint fk_messages_conversation_tenant
    foreign key (tenant_id, conversation_id) references pulso_iris.conversations(tenant_id, id) on delete cascade;

alter table pulso_iris.appointments
  add constraint fk_appointments_patient_tenant
    foreign key (tenant_id, patient_id) references pulso_iris.administrative_patients(tenant_id, id),
  add constraint fk_appointments_conversation_tenant
    foreign key (tenant_id, conversation_id) references pulso_iris.conversations(tenant_id, id),
  add constraint fk_appointments_site_tenant
    foreign key (tenant_id, site_id) references pulso_iris.sites(tenant_id, id),
  add constraint fk_appointments_professional_tenant
    foreign key (tenant_id, professional_id) references pulso_iris.professionals(tenant_id, id),
  add constraint fk_appointments_payer_tenant
    foreign key (tenant_id, payer_id) references pulso_iris.payers(tenant_id, id),
  add constraint fk_appointments_appointment_type_tenant
    foreign key (tenant_id, appointment_type_id) references pulso_iris.appointment_types(tenant_id, id);

alter table pulso_iris.rpa_actions
  add constraint fk_rpa_actions_appointment_tenant
    foreign key (tenant_id, appointment_id) references pulso_iris.appointments(tenant_id, id),
  add constraint fk_rpa_actions_conversation_tenant
    foreign key (tenant_id, conversation_id) references pulso_iris.conversations(tenant_id, id),
  add constraint fk_rpa_actions_worker_tenant
    foreign key (tenant_id, worker_id) references pulso_iris.rpa_workers(tenant_id, id);

alter table pulso_iris.rpa_events
  add constraint fk_rpa_events_worker_tenant
    foreign key (tenant_id, worker_id) references pulso_iris.rpa_workers(tenant_id, id);

alter table pulso_iris.handoffs
  add constraint fk_handoffs_patient_tenant
    foreign key (tenant_id, patient_id) references pulso_iris.administrative_patients(tenant_id, id),
  add constraint fk_handoffs_conversation_tenant
    foreign key (tenant_id, conversation_id) references pulso_iris.conversations(tenant_id, id);

alter table pulso_iris.campaign_contacts
  add constraint fk_campaign_contacts_campaign_tenant
    foreign key (tenant_id, campaign_id) references pulso_iris.campaigns(tenant_id, id) on delete cascade,
  add constraint fk_campaign_contacts_patient_tenant
    foreign key (tenant_id, patient_id) references pulso_iris.administrative_patients(tenant_id, id),
  add constraint fk_campaign_contacts_appointment_tenant
    foreign key (tenant_id, appointment_id) references pulso_iris.appointments(tenant_id, id);

alter table pulso_iris.waitlist
  add constraint fk_waitlist_patient_tenant
    foreign key (tenant_id, patient_id) references pulso_iris.administrative_patients(tenant_id, id),
  add constraint fk_waitlist_appointment_type_tenant
    foreign key (tenant_id, appointment_type_id) references pulso_iris.appointment_types(tenant_id, id);

create index if not exists idx_pulso_iris_messages_tenant_created on pulso_iris.messages(tenant_id, created_at desc);

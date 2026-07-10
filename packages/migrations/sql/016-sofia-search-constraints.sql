-- SOFIA debe conservar las restricciones explicitas de fecha, hora y catalogo
-- al consultar nuevamente disponibilidad. El modelo no puede sustituirlas por
-- la fecha actual ni tomar una seleccion distinta del historial narrativo.

insert into platform.prompt_flows (
  tenant_id,
  agent_id,
  name,
  version,
  status,
  definition
)
select
  a.tenant_id,
  a.id,
  'SOFIA - agenda administrativa',
  coalesce((
    select max(existing.version) + 1
    from platform.prompt_flows existing
    where existing.tenant_id = a.tenant_id and existing.agent_id = a.id
  ), 1),
  'active',
  source.definition || jsonb_build_object(
    'systemPrompt', concat(
      source.definition ->> 'systemPrompt',
      ' Regla obligatoria de restricciones de busqueda: cuando el mensaje actual indique una fecha ',
      'o una hora, conserva exactamente su localDate y localTime en America/Bogota al llamar ',
      'search_availability. Nunca omitas esas restricciones, nunca las sustituyas por la fecha actual ',
      'y nunca presentes slots de otra fecha como respuesta. Conserva sede, profesional, convenio y ',
      'tipo de cita seleccionados previamente solo cuando el contexto estructurado de Hyperion tenga ',
      'un unico valor homogeneo para cada campo. Si un valor es ambiguo o el paciente solicita cambiarlo, ',
      'pide precision antes de elegir; no sustituyas la seleccion estructurada por identificadores inferidos ',
      'libremente del texto narrativo. Usa unicamente slots que cumplan las restricciones normalizadas del mensaje actual.'
    ),
    'runtimeKey', 'sofia_whatsapp_internal_v5',
    'searchConstraintSource', 'current_patient_message',
    'searchConstraintTimeZone', 'America/Bogota',
    'catalogSelectionPolicy', 'homogeneous_structured_context_only',
    'searchResultPolicy', 'must_match_normalized_local_constraints'
  )
from platform.agents a
join lateral (
  select f.definition
  from platform.prompt_flows f
  where f.tenant_id = a.tenant_id
    and f.agent_id = a.id
    and f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v4'
  order by f.version desc, f.updated_at desc
  limit 1
) source on true
where a.tenant_id is not null
  and a.code = 'SOFIA'
  and not exists (
    select 1
    from platform.prompt_flows f
    where f.tenant_id = a.tenant_id
      and f.agent_id = a.id
      and f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v5'
  );

update platform.prompt_flows f
set status = case
      when f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v5' then 'active'
      else 'archived'
    end,
    updated_at = now()
from platform.agents a
where a.id = f.agent_id
  and a.tenant_id = f.tenant_id
  and a.code = 'SOFIA'
  and f.status in ('active', 'archived')
  and f.definition ->> 'runtimeKey' in (
    'sofia_whatsapp_internal_v1',
    'sofia_whatsapp_internal_v2',
    'sofia_whatsapp_internal_v3',
    'sofia_whatsapp_internal_v4',
    'sofia_whatsapp_internal_v5'
  );

-- Antes de invalidar el snapshot anterior, conserva solamente dimensiones
-- homogeneas cuyos identificadores sigan perteneciendo al catalogo del mismo
-- tenant. Una seleccion ya persistida tiene prioridad y nunca se infiere texto.
with conversation_state as (
  select
    c.tenant_id,
    c.id,
    case
      when jsonb_typeof(c.metadata -> 'sofiaState') = 'object'
        then c.metadata -> 'sofiaState'
      else '{}'::jsonb
    end as sofia_state
  from pulso_iris.conversations c
  where jsonb_typeof(c.metadata #> '{sofiaState,lastAvailability,slots}') = 'array'
),
homogeneous_selection as (
  select
    state.tenant_id,
    state.id,
    state.sofia_state,
    case
      when count(*) filter (where jsonb_typeof(slot.value -> 'siteId') = 'string') = count(*)
       and count(distinct slot.value ->> 'siteId') = 1
        then min(slot.value ->> 'siteId')
    end as site_id,
    case
      when count(*) filter (where jsonb_typeof(slot.value -> 'professionalId') = 'string') = count(*)
       and count(distinct slot.value ->> 'professionalId') = 1
        then min(slot.value ->> 'professionalId')
    end as professional_id,
    case
      when count(*) filter (where jsonb_typeof(slot.value -> 'payerId') = 'string') = count(*)
       and count(distinct slot.value ->> 'payerId') = 1
        then min(slot.value ->> 'payerId')
    end as payer_id,
    case
      when count(*) filter (where jsonb_typeof(slot.value -> 'appointmentTypeId') = 'string') = count(*)
       and count(distinct slot.value ->> 'appointmentTypeId') = 1
        then min(slot.value ->> 'appointmentTypeId')
    end as appointment_type_id
  from conversation_state state
  cross join lateral jsonb_array_elements(state.sofia_state #> '{lastAvailability,slots}') slot(value)
  group by state.tenant_id, state.id, state.sofia_state
),
tenant_selection as (
  select
    homogeneous.tenant_id,
    homogeneous.id,
    homogeneous.sofia_state,
    jsonb_strip_nulls(jsonb_build_object(
      'siteId', (
        select site.id::text
        from pulso_iris.sites site
        where site.tenant_id = homogeneous.tenant_id
          and site.id::text = homogeneous.site_id
          and site.status = 'active'
      ),
      'professionalId', (
        select professional.id::text
        from pulso_iris.professionals professional
        where professional.tenant_id = homogeneous.tenant_id
          and professional.id::text = homogeneous.professional_id
          and professional.status = 'active'
      ),
      'payerId', (
        select payer.id::text
        from pulso_iris.payers payer
        where payer.tenant_id = homogeneous.tenant_id
          and payer.id::text = homogeneous.payer_id
          and payer.status = 'active'
      ),
      'appointmentTypeId', (
        select appointment_type.id::text
        from pulso_iris.appointment_types appointment_type
        where appointment_type.tenant_id = homogeneous.tenant_id
          and appointment_type.id::text = homogeneous.appointment_type_id
          and appointment_type.status = 'active'
      )
    )) as derived_selection
  from homogeneous_selection homogeneous
),
promotable_selection as (
  select
    selection.tenant_id,
    selection.id,
    selection.sofia_state || jsonb_build_object(
      'agendaSelection',
      selection.derived_selection || case
        when jsonb_typeof(selection.sofia_state -> 'agendaSelection') = 'object'
          then selection.sofia_state -> 'agendaSelection'
        else '{}'::jsonb
      end
    ) as sofia_state
  from tenant_selection selection
  where selection.derived_selection <> '{}'::jsonb
)
update pulso_iris.conversations conversation
set metadata = jsonb_set(
      coalesce(conversation.metadata, '{}'::jsonb),
      '{sofiaState}',
      promoted.sofia_state,
      true
    ),
    updated_at = now()
from promotable_selection promoted
where conversation.tenant_id = promoted.tenant_id
  and conversation.id = promoted.id;

-- Invalida solamente snapshots de disponibilidad anteriores al nuevo contrato.
-- agendaSelection, pendingAction, confirmationGrant y el resto del estado se
-- conservan para no cambiar una seleccion ni una accion pendiente.
with conversation_state as (
  select
    c.tenant_id,
    c.id,
    case
      when jsonb_typeof(c.metadata -> 'sofiaState') = 'object'
        then c.metadata -> 'sofiaState'
      else '{}'::jsonb
    end as sofia_state
  from pulso_iris.conversations c
),
cleaned_state as (
  select
    state.tenant_id,
    state.id,
    coalesce(
      jsonb_object_agg(entry.key, entry.value)
        filter (where entry.key not like 'lastAvailability%'),
      '{}'::jsonb
    ) as sofia_state
  from conversation_state state
  cross join lateral jsonb_each(state.sofia_state) entry
  where exists (
    select 1
    from jsonb_object_keys(state.sofia_state) key_name
    where key_name like 'lastAvailability%'
  )
  group by state.tenant_id, state.id
)
update pulso_iris.conversations conversation
set metadata = jsonb_set(
      coalesce(conversation.metadata, '{}'::jsonb),
      '{sofiaState}',
      cleaned.sofia_state,
      true
    ),
    updated_at = now()
from cleaned_state cleaned
where conversation.tenant_id = cleaned.tenant_id
  and conversation.id = cleaned.id;

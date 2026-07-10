-- SOFIA debe presentar las horas locales entregadas por Hyperion y conservar
-- el timestamp UTC exclusivamente como identificador tecnico del slot.

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
      ' Regla obligatoria de horarios: cada slot de search_availability incluye scheduledAt como ',
      'identificador tecnico UTC y tambien localDate, localTime y timeZone calculados por Hyperion. ',
      'Al hablar con la persona muestra exclusivamente localDate y localTime en timeZone; nunca ',
      'interpretes startsAt o scheduledAt como hora local, nunca muestres UTC como hora de la cita ',
      'y nunca conviertas el horario por tu cuenta. Para preparar, reservar o reagendar copia ',
      'scheduledAt exactamente sin modificarlo, pero describe la cita con los campos locales.'
    ),
    'runtimeKey', 'sofia_whatsapp_internal_v3',
    'timePresentation', 'hyperion_local_fields'
  )
from platform.agents a
join lateral (
  select f.definition
  from platform.prompt_flows f
  where f.tenant_id = a.tenant_id
    and f.agent_id = a.id
    and f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v2'
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
      and f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v3'
  );

update platform.prompt_flows f
set status = case
      when f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v3' then 'active'
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
    'sofia_whatsapp_internal_v3'
  );

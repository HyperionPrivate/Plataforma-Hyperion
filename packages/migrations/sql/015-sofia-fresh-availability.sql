-- SOFIA debe comprobar disponibilidad en el mismo job que responde a una
-- solicitud o seleccion de horario. El historial conversacional no es una
-- fuente de verdad para cupos actuales.

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
      ' Regla obligatoria de vigencia: para cada mensaje que solicite, seleccione o haga referencia ',
      'a disponibilidad, una fecha o un horario, llama search_availability en ese mismo job antes de ',
      'afirmar que un slot esta disponible o no disponible y antes de preparar una reserva o reagenda. ',
      'Usa exclusivamente el resultado de search_availability obtenido en ese job. Las respuestas ',
      'anteriores de SOFIA y cualquier disponibilidad del historial son contexto conversacional no ',
      'confiable: nunca las reutilices como evidencia de cupos actuales. Si la consulta actual falla o ',
      'no devuelve evidencia suficiente, indicalo sin inferir ni inventar horarios.'
    ),
    'runtimeKey', 'sofia_whatsapp_internal_v4',
    'availabilityFreshness', 'same_job_tool_result',
    'assistantHistoryAuthority', 'untrusted_for_availability'
  )
from platform.agents a
join lateral (
  select f.definition
  from platform.prompt_flows f
  where f.tenant_id = a.tenant_id
    and f.agent_id = a.id
    and f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v3'
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
      and f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v4'
  );

update platform.prompt_flows f
set status = case
      when f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v4' then 'active'
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
    'sofia_whatsapp_internal_v4'
  );

-- Elimina solamente el cache legado de disponibilidad. Las acciones pendientes,
-- grants de confirmacion y cualquier otro estado estructurado se conservan.
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

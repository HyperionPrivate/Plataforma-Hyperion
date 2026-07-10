-- Alinea el prompt activo de SOFIA con la barrera durable de confirmacion.
-- La accion se prepara antes de solicitar CONFIRMO y solo se ejecuta en un
-- mensaje posterior que confirma exactamente la accion persistida.

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
  jsonb_build_object(
    'systemPrompt', concat(
      'Eres SOFIA, asistente virtual administrativa de CEDCO. Habla en espanol claro y cordial. ',
      'Informa sobre sedes, convenios, tipos de cita, preparaciones y disponibilidad usando ',
      'exclusivamente los datos y herramientas de Hyperion; nunca inventes disponibilidad ni datos. ',
      'No diagnostiques, no interpretes sintomas y no des recomendaciones clinicas. ',
      'Antes de reservar, cancelar o reagendar exige una confirmacion explicita de la persona. ',
      'Cuando la persona haya elegido una accion exacta y antes de pedir CONFIRMO, llama la herramienta ',
      'de escritura correspondiente con todos sus argumentos. Hyperion solo preparara la accion, no la ',
      'ejecutara, y devolvera explicit_confirmation_required. Presenta entonces los datos exactos de la ',
      'accion preparada y pide que responda unicamente CONFIRMO. Al recibir esa confirmacion, repite la ',
      'misma herramienta; Hyperion ejecutara los argumentos persistidos de la accion preparada. ',
      'Para agendar, consulta primero disponibilidad. Al elegir un slot, prepara create_appointment_hold ',
      'antes de pedir CONFIRMO. Tras la confirmacion y un hold exitoso, llama book_appointment con el holdId ',
      'en el mismo turno, sin pedir otra confirmacion. Solo informa que la cita quedo agendada cuando ',
      'book_appointment devuelve status verified. Para cancelar o reagendar, lista primero las citas, ',
      'prepara cancel_appointment o reschedule_appointment antes de pedir CONFIRMO y repite esa herramienta ',
      'despues de la confirmacion. Si recibes confirmation_action_staged, la accion no se ejecuto: presenta ',
      'sus datos y solicita una nueva confirmacion en un mensaje posterior; no repitas la herramienta en ',
      'ese mismo turno. Si la persona menciona una urgencia o sintomas, detiene el agendamiento, comunica ',
      'que no puedes orientar clinicamente y solicita atencion por los canales de urgencias disponibles; ',
      'marca la conversacion como handoff_required. Si una herramienta o dato no esta disponible, indicalo ',
      'sin inventar. No reveles modelos, proveedores ni detalles internos de la plataforma.'
    ),
    'language', 'es-CO',
    'runtimeKey', 'sofia_whatsapp_internal_v2',
    'scope', 'administrative',
    'catalogSource', 'hyperion',
    'urgentMessage', concat(
      'Por seguridad, no puedo orientar sintomas ni urgencias. Busca atencion medica urgente ',
      'o comunicate con los servicios de emergencia de tu zona si corresponde.'
    ),
    'requiresExplicitConfirmation', jsonb_build_array(
      'book_appointment',
      'create_appointment_hold',
      'cancel_appointment',
      'reschedule_appointment'
    ),
    'urgencyAction', 'handoff_required'
  )
from platform.agents a
where a.tenant_id is not null
  and a.code = 'SOFIA'
  and not exists (
    select 1
    from platform.prompt_flows f
    where f.tenant_id = a.tenant_id
      and f.agent_id = a.id
      and f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v2'
  );

update platform.prompt_flows f
set status = case
      when f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v2' then 'active'
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
    'sofia_whatsapp_internal_v2'
  );

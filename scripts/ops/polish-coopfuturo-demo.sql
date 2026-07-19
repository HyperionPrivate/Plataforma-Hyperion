-- Polish CoopFuturo demo: remove smoke chat noise, seed realistic threads,
-- collapse duplicate leads, align CRM stages.
-- Usage: psql ... -v ON_ERROR_STOP=1 -v tenant_id="$TENANT_ID" -f scripts/ops/polish-coopfuturo-demo.sql

\set ON_ERROR_STOP on

\if :{?tenant_id}
\else
  \echo 'ERROR: tenant_id is required (canonical UUID).'
  \quit 64
\endif

SELECT :'tenant_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AS tenant_id_is_uuid
\gset

\if :tenant_id_is_uuid
\else
  \echo 'ERROR: tenant_id must be a canonical UUID.'
  \quit 64
\endif

BEGIN;
SET LOCAL hyperion.ops_tenant_id TO :'tenant_id';

DO $$
DECLARE
  v_tenant CONSTANT uuid := current_setting('hyperion.ops_tenant_id')::uuid;
  v_carlos uuid;
  v_ana uuid;
  v_jp uuid;
  v_calos uuid;
  v_conv uuid;
BEGIN
  SELECT contact_id INTO v_carlos FROM nova.contacts
   WHERE tenant_id = v_tenant AND phone_e164 = '+573004198710' LIMIT 1;
  SELECT contact_id INTO v_ana FROM nova.contacts
   WHERE tenant_id = v_tenant AND phone_e164 = '+573178925556' LIMIT 1;
  SELECT contact_id INTO v_jp FROM nova.contacts
   WHERE tenant_id = v_tenant AND phone_e164 = '+573002555948' LIMIT 1;
  SELECT contact_id INTO v_calos FROM nova.contacts
   WHERE tenant_id = v_tenant AND phone_e164 = '+573001112233' LIMIT 1;

  -- Normalize display names for demo phones
  IF v_carlos IS NOT NULL THEN
    UPDATE nova.contacts SET full_name = 'Carlos', updated_at = now()
     WHERE tenant_id = v_tenant AND contact_id = v_carlos;
  END IF;
  IF v_ana IS NOT NULL THEN
    UPDATE nova.contacts SET full_name = 'Ana Restrepo', updated_at = now()
     WHERE tenant_id = v_tenant AND contact_id = v_ana;
  END IF;
  IF v_jp IS NOT NULL THEN
    UPDATE nova.contacts SET full_name = 'Juan Pablo', updated_at = now()
     WHERE tenant_id = v_tenant AND contact_id = v_jp;
  END IF;
  IF v_calos IS NOT NULL THEN
    UPDATE nova.contacts SET full_name = 'Laura Gómez', updated_at = now()
     WHERE tenant_id = v_tenant AND contact_id = v_calos;
  END IF;

  -- Delete smoke / lab residue messages
  DELETE FROM nova.conversation_messages m
   WHERE m.tenant_id = v_tenant
     AND (
       m.body ILIKE '%espejo%'
       OR m.body ILIKE '%smoke%'
       OR m.body ILIKE '%{{filename}}%'
       OR m.body ILIKE '%{{%}}%'
       OR m.body ILIKE 'Flujo % enviado'
       OR m.body ILIKE 'Flujo WhatsApp enviado%'
       OR m.body ILIKE 'Flujo LIWA enviado%'
       OR m.body ILIKE 'Hola desde Lab%'
       OR m.body ILIKE 'Hola desde Hyperion%'
       OR m.body ILIKE 'Texto exacto%'
       OR m.body ILIKE 'Reply asesor%'
       OR m.body ILIKE 'Documento recibido:%'
       OR m.body ILIKE 'Espejo UI%'
       OR m.body ILIKE 'Espejo publico%'
       OR m.body ILIKE 'Espejo interno%'
     );

  -- Close conversations that have no remaining messages
  UPDATE nova.conversations c
     SET status = 'closed', updated_at = now()
   WHERE c.tenant_id = v_tenant
     AND NOT EXISTS (
       SELECT 1 FROM nova.conversation_messages m
        WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.conversation_id
     );

  -- Helper: replace thread for a contact with a polished dialogue
  -- Carlos — Interesado / renovación
  IF v_carlos IS NOT NULL THEN
    DELETE FROM nova.conversation_messages
     WHERE tenant_id = v_tenant
       AND conversation_id IN (
         SELECT conversation_id FROM nova.conversations
          WHERE tenant_id = v_tenant AND contact_id = v_carlos
       );
    DELETE FROM nova.conversations
     WHERE tenant_id = v_tenant AND contact_id = v_carlos;

    v_conv := gen_random_uuid();
    INSERT INTO nova.conversations (
      tenant_id, conversation_id, contact_id, channel, status, last_message_at, created_at, updated_at
    ) VALUES (
      v_tenant, v_conv, v_carlos, 'whatsapp', 'open', now(), now() - interval '25 minutes', now()
    );

    INSERT INTO nova.conversation_messages (
      tenant_id, conversation_id, message_id, direction, body, kind, external_id, created_at
    ) VALUES
      (v_tenant, v_conv, gen_random_uuid(), 'outbound',
       '¡Hola Carlos! Le saludamos de COOPFUTURO. Tiene un cupo preaprobado para renovar su crédito educativo.',
       'text', 'seed:carlos:1', now() - interval '24 minutes'),
      (v_tenant, v_conv, gen_random_uuid(), 'inbound',
       'Sí, me interesa renovar este semestre.',
       'text', 'seed:carlos:2', now() - interval '22 minutes'),
      (v_tenant, v_conv, gen_random_uuid(), 'outbound',
       'Perfecto. Para continuar solo necesitamos su orden de matrícula en PDF.',
       'text', 'seed:carlos:3', now() - interval '20 minutes'),
      (v_tenant, v_conv, gen_random_uuid(), 'inbound',
       'Claro, la consigo y se la envío.',
       'text', 'seed:carlos:4', now() - interval '18 minutes');
  END IF;

  -- Ana — Contactada / en proceso
  IF v_ana IS NOT NULL THEN
    DELETE FROM nova.conversation_messages
     WHERE tenant_id = v_tenant
       AND conversation_id IN (
         SELECT conversation_id FROM nova.conversations
          WHERE tenant_id = v_tenant AND contact_id = v_ana
       );
    DELETE FROM nova.conversations
     WHERE tenant_id = v_tenant AND contact_id = v_ana;

    v_conv := gen_random_uuid();
    INSERT INTO nova.conversations (
      tenant_id, conversation_id, contact_id, channel, status, last_message_at, created_at, updated_at
    ) VALUES (
      v_tenant, v_conv, v_ana, 'whatsapp', 'open', now(), now() - interval '40 minutes', now()
    );

    INSERT INTO nova.conversation_messages (
      tenant_id, conversation_id, message_id, direction, body, kind, external_id, created_at
    ) VALUES
      (v_tenant, v_conv, gen_random_uuid(), 'outbound',
       'Hola Ana, soy el asistente de COOPFUTURO. ¿Tiene un momento para revisar su cupo de renovación?',
       'text', 'seed:ana:1', now() - interval '38 minutes'),
      (v_tenant, v_conv, gen_random_uuid(), 'inbound',
       'Hola, sí. ¿Qué documentos necesitan?',
       'text', 'seed:ana:2', now() - interval '35 minutes'),
      (v_tenant, v_conv, gen_random_uuid(), 'outbound',
       'Con la orden de matrícula actualizada podemos avanzar con la preaprobación.',
       'text', 'seed:ana:3', now() - interval '33 minutes');
  END IF;

  -- Juan Pablo — Contactado
  IF v_jp IS NOT NULL THEN
    DELETE FROM nova.conversation_messages
     WHERE tenant_id = v_tenant
       AND conversation_id IN (
         SELECT conversation_id FROM nova.conversations
          WHERE tenant_id = v_tenant AND contact_id = v_jp
       );
    DELETE FROM nova.conversations
     WHERE tenant_id = v_tenant AND contact_id = v_jp;

    v_conv := gen_random_uuid();
    INSERT INTO nova.conversations (
      tenant_id, conversation_id, contact_id, channel, status, last_message_at, created_at, updated_at
    ) VALUES (
      v_tenant, v_conv, v_jp, 'whatsapp', 'open', now(), now() - interval '55 minutes', now()
    );

    INSERT INTO nova.conversation_messages (
      tenant_id, conversation_id, message_id, direction, body, kind, external_id, created_at
    ) VALUES
      (v_tenant, v_conv, gen_random_uuid(), 'outbound',
       'Buenos días Juan Pablo. En COOPFUTURO tenemos una opción de renovación con cupo preaprobado.',
       'text', 'seed:jp:1', now() - interval '52 minutes'),
      (v_tenant, v_conv, gen_random_uuid(), 'inbound',
       'Gracias, ¿me pueden llamar más tarde?',
       'text', 'seed:jp:2', now() - interval '50 minutes'),
      (v_tenant, v_conv, gen_random_uuid(), 'outbound',
       'Con gusto. Coordinamos una llamada en horario de oficina.',
       'text', 'seed:jp:3', now() - interval '48 minutes');
  END IF;

  -- Laura — Pendiente de respuesta (ligero)
  IF v_calos IS NOT NULL THEN
    DELETE FROM nova.conversation_messages
     WHERE tenant_id = v_tenant
       AND conversation_id IN (
         SELECT conversation_id FROM nova.conversations
          WHERE tenant_id = v_tenant AND contact_id = v_calos
       );
    DELETE FROM nova.conversations
     WHERE tenant_id = v_tenant AND contact_id = v_calos;

    v_conv := gen_random_uuid();
    INSERT INTO nova.conversations (
      tenant_id, conversation_id, contact_id, channel, status, last_message_at, created_at, updated_at
    ) VALUES (
      v_tenant, v_conv, v_calos, 'whatsapp', 'open', now(), now() - interval '70 minutes', now()
    );

    INSERT INTO nova.conversation_messages (
      tenant_id, conversation_id, message_id, direction, body, kind, external_id, created_at
    ) VALUES
      (v_tenant, v_conv, gen_random_uuid(), 'outbound',
       'Hola Laura, le escribimos de COOPFUTURO por su crédito educativo. ¿Le interesa conocer su cupo?',
       'text', 'seed:laura:1', now() - interval '68 minutes');
  END IF;

  -- Collapse duplicate leads: keep newest / most advanced per contact+product_line
  WITH ranked AS (
    SELECT
      lead_id,
      ROW_NUMBER() OVER (
        PARTITION BY tenant_id, contact_id, COALESCE(product_line, 'renovacion')
        ORDER BY
          CASE stage
            WHEN 'renovado' THEN 6
            WHEN 'transferido' THEN 5
            WHEN 'documento' THEN 4
            WHEN 'interesado' THEN 3
            WHEN 'contactado' THEN 2
            WHEN 'pendiente' THEN 1
            WHEN 'no_interes' THEN 0
            ELSE 0
          END DESC,
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST
      ) AS rn
    FROM nova.leads
    WHERE tenant_id = v_tenant
  )
  DELETE FROM nova.leads l
   USING ranked r
   WHERE l.tenant_id = v_tenant
     AND l.lead_id = r.lead_id
     AND r.rn > 1;

  -- Align stages for demo phones
  IF v_carlos IS NOT NULL THEN
    UPDATE nova.leads
       SET stage = 'interesado',
           tipification = COALESCE(NULLIF(tipification, ''), 'interesado'),
           product_line = COALESCE(product_line, 'renovacion'),
           updated_at = now()
     WHERE tenant_id = v_tenant AND contact_id = v_carlos;
  END IF;
  IF v_ana IS NOT NULL THEN
    UPDATE nova.leads
       SET stage = CASE WHEN stage IN ('interesado', 'documento', 'transferido', 'renovado') THEN stage ELSE 'contactado' END,
           tipification = COALESCE(NULLIF(tipification, ''), 'volver_llamar'),
           product_line = COALESCE(product_line, 'renovacion'),
           updated_at = now()
     WHERE tenant_id = v_tenant AND contact_id = v_ana;
  END IF;
  IF v_jp IS NOT NULL THEN
    UPDATE nova.leads
       SET stage = CASE WHEN stage IN ('interesado', 'documento', 'transferido', 'renovado') THEN stage ELSE 'contactado' END,
           tipification = COALESCE(NULLIF(tipification, ''), 'volver_llamar'),
           product_line = COALESCE(product_line, 'renovacion'),
           updated_at = now()
     WHERE tenant_id = v_tenant AND contact_id = v_jp;
  END IF;
  IF v_calos IS NOT NULL THEN
    UPDATE nova.leads
       SET stage = 'pendiente',
           tipification = NULL,
           product_line = COALESCE(product_line, 'renovacion'),
           updated_at = now()
     WHERE tenant_id = v_tenant AND contact_id = v_calos;
  END IF;

  -- Ensure leads exist for demo contacts on renovacion
  IF v_carlos IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM nova.leads WHERE tenant_id = v_tenant AND contact_id = v_carlos AND product_line = 'renovacion'
  ) THEN
    INSERT INTO nova.leads (tenant_id, lead_id, contact_id, stage, tipification, product_line)
    VALUES (v_tenant, gen_random_uuid(), v_carlos, 'interesado', 'interesado', 'renovacion');
  END IF;
  IF v_ana IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM nova.leads WHERE tenant_id = v_tenant AND contact_id = v_ana AND product_line = 'renovacion'
  ) THEN
    INSERT INTO nova.leads (tenant_id, lead_id, contact_id, stage, tipification, product_line)
    VALUES (v_tenant, gen_random_uuid(), v_ana, 'contactado', 'volver_llamar', 'renovacion');
  END IF;
  IF v_jp IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM nova.leads WHERE tenant_id = v_tenant AND contact_id = v_jp AND product_line = 'renovacion'
  ) THEN
    INSERT INTO nova.leads (tenant_id, lead_id, contact_id, stage, tipification, product_line)
    VALUES (v_tenant, gen_random_uuid(), v_jp, 'contactado', 'volver_llamar', 'renovacion');
  END IF;
  IF v_calos IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM nova.leads WHERE tenant_id = v_tenant AND contact_id = v_calos AND product_line = 'renovacion'
  ) THEN
    INSERT INTO nova.leads (tenant_id, lead_id, contact_id, stage, tipification, product_line)
    VALUES (v_tenant, gen_random_uuid(), v_calos, 'pendiente', NULL, 'renovacion');
  END IF;
END $$;

COMMIT;

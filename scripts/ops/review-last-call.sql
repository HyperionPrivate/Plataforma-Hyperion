-- Review recent NOVA calls for one explicit tenant only.
-- Usage: psql ... -v ON_ERROR_STOP=1 -v tenant_id="$TENANT_ID" -f scripts/ops/review-last-call.sql

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

\pset format aligned
\echo === Ultimas llamadas voz del tenant ===
SELECT c.call_id::text,
       c.status,
       c.contact_phone_e164,
       ct.full_name,
       c.dialer_call_ref,
       c.provider_conversation_id,
       c.created_at AT TIME ZONE 'America/Bogota' AS created_co,
       c.updated_at AT TIME ZONE 'America/Bogota' AS updated_co
FROM voice.calls AS c
LEFT JOIN nova.contacts AS ct
  ON ct.tenant_id = c.tenant_id AND ct.contact_id = c.contact_id
WHERE c.tenant_id = :'tenant_id'::uuid
ORDER BY c.created_at DESC
LIMIT 5;

\echo === Ultima llamada del tenant (detalle) ===
WITH last_call AS (
  SELECT c.*
  FROM voice.calls AS c
  WHERE c.tenant_id = :'tenant_id'::uuid
  ORDER BY c.created_at DESC
  LIMIT 1
)
SELECT lc.call_id::text,
       lc.status,
       lc.contact_phone_e164,
       lc.provider_conversation_id,
       lc.correlation_id::text,
       lc.created_at AT TIME ZONE 'America/Bogota' AS created_co
FROM last_call AS lc;

\echo === Reviews post-call asociadas (mismo telefono / 10 min) ===
WITH last_call AS (
  SELECT c.*
  FROM voice.calls AS c
  WHERE c.tenant_id = :'tenant_id'::uuid
  ORDER BY c.created_at DESC
  LIMIT 1
)
SELECT r.review_id::text,
       r.status,
       r.intent,
       r.phone_e164,
       r.full_name,
       r.flow_id,
       r.call_id::text,
       r.created_at AT TIME ZONE 'America/Bogota' AS created_co
FROM nova.whatsapp_reviews AS r
JOIN last_call AS lc ON lc.tenant_id = r.tenant_id
WHERE r.tenant_id = :'tenant_id'::uuid
  AND (
    r.call_id = lc.call_id
    OR (r.phone_e164 = lc.contact_phone_e164 AND r.created_at >= lc.created_at - interval '10 minutes')
  )
ORDER BY r.created_at DESC
LIMIT 10;

\echo === Leads del contacto ===
WITH last_call AS (
  SELECT c.*
  FROM voice.calls AS c
  WHERE c.tenant_id = :'tenant_id'::uuid
  ORDER BY c.created_at DESC
  LIMIT 1
)
SELECT l.lead_id::text,
       l.stage,
       l.tipification,
       l.product_line,
       l.updated_at AT TIME ZONE 'America/Bogota' AS updated_co
FROM nova.leads AS l
JOIN last_call AS lc ON lc.tenant_id = l.tenant_id AND lc.contact_id = l.contact_id
WHERE l.tenant_id = :'tenant_id'::uuid
ORDER BY l.updated_at DESC
LIMIT 10;

\echo === Mensajes WA recientes del contacto ===
WITH last_call AS (
  SELECT c.*
  FROM voice.calls AS c
  WHERE c.tenant_id = :'tenant_id'::uuid
  ORDER BY c.created_at DESC
  LIMIT 1
)
SELECT m.direction,
       left(m.body, 120) AS body,
       m.created_at AT TIME ZONE 'America/Bogota' AS created_co
FROM nova.conversation_messages AS m
JOIN nova.conversations AS cv
  ON cv.tenant_id = m.tenant_id AND cv.conversation_id = m.conversation_id
JOIN last_call AS lc
  ON lc.tenant_id = cv.tenant_id AND lc.contact_id = cv.contact_id
WHERE m.tenant_id = :'tenant_id'::uuid
  AND cv.tenant_id = :'tenant_id'::uuid
ORDER BY m.created_at DESC
LIMIT 12;

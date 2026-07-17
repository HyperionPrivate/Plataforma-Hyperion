#!/bin/bash
set -euo pipefail
docker exec plataforma-hyperion-postgres-1 psql -U hyperion -d hyperion -v ON_ERROR_STOP=1 <<'SQL'
\pset format aligned
\echo === Ultimas llamadas voz ===
SELECT c.call_id::text,
       c.status,
       c.contact_phone_e164,
       ct.full_name,
       c.dialer_call_ref,
       c.provider_conversation_id,
       c.created_at AT TIME ZONE 'America/Bogota' AS created_co,
       c.updated_at AT TIME ZONE 'America/Bogota' AS updated_co
FROM voice.calls c
LEFT JOIN nova.contacts ct
  ON ct.tenant_id = c.tenant_id AND ct.contact_id = c.contact_id
ORDER BY c.created_at DESC
LIMIT 5;

\echo === Ultima llamada (detalle) ===
WITH last_call AS (
  SELECT * FROM voice.calls ORDER BY created_at DESC LIMIT 1
)
SELECT lc.call_id::text,
       lc.status,
       lc.contact_phone_e164,
       lc.provider_conversation_id,
       lc.correlation_id::text,
       lc.created_at AT TIME ZONE 'America/Bogota' AS created_co
FROM last_call lc;

\echo === Reviews post-call asociadas (mismo telefono / 2h) ===
WITH last_call AS (
  SELECT * FROM voice.calls ORDER BY created_at DESC LIMIT 1
)
SELECT r.review_id::text,
       r.status,
       r.intent,
       r.phone_e164,
       r.full_name,
       r.flow_id,
       r.call_id::text,
       r.created_at AT TIME ZONE 'America/Bogota' AS created_co
FROM nova.whatsapp_reviews r, last_call lc
WHERE r.tenant_id = lc.tenant_id
  AND (
    r.call_id = lc.call_id
    OR (r.phone_e164 = lc.contact_phone_e164 AND r.created_at >= lc.created_at - interval '10 minutes')
  )
ORDER BY r.created_at DESC
LIMIT 10;

\echo === Leads del contacto ===
WITH last_call AS (
  SELECT * FROM voice.calls ORDER BY created_at DESC LIMIT 1
)
SELECT l.lead_id::text, l.stage, l.tipification, l.product_line,
       l.updated_at AT TIME ZONE 'America/Bogota' AS updated_co
FROM nova.leads l
JOIN last_call lc ON l.tenant_id = lc.tenant_id AND l.contact_id = lc.contact_id
ORDER BY l.updated_at DESC
LIMIT 10;

\echo === Mensajes WA recientes del contacto ===
WITH last_call AS (
  SELECT * FROM voice.calls ORDER BY created_at DESC LIMIT 1
)
SELECT m.direction, left(m.body, 120) AS body,
       m.created_at AT TIME ZONE 'America/Bogota' AS created_co
FROM nova.conversation_messages m
JOIN nova.conversations cv
  ON cv.tenant_id = m.tenant_id AND cv.conversation_id = m.conversation_id
JOIN last_call lc
  ON cv.tenant_id = lc.tenant_id AND cv.contact_id = lc.contact_id
ORDER BY m.created_at DESC
LIMIT 12;
SQL

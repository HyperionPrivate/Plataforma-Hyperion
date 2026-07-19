SELECT c.call_id::text AS call_id,
       c.status,
       c.contact_phone_e164 AS phone,
       ct.full_name AS name,
       c.dialer_call_ref,
       c.provider_conversation_id AS conversation_id,
       to_char(c.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI:SS') AS created_co,
       to_char(c.updated_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI:SS') AS updated_co
FROM voice.calls c
LEFT JOIN nova.contacts ct
  ON ct.tenant_id = c.tenant_id AND ct.contact_id = c.contact_id
ORDER BY c.created_at DESC
LIMIT 5;

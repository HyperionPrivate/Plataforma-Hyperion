export const NOVA_PROVIDER_LEDGER = Object.freeze([
  {
    name: "047-nova-autonomy.sql",
    checksum: "78d894e5f0fd286b5f79b26ee0473f13a8e1a7e49e3837adf484a0081e991cc0"
  },
  {
    name: "048-nova-correlation-and-domain.sql",
    checksum: "edc865a5d7cf2e3a736a6198ae35494e242e658c3cca233977e072d2f83a2ba0"
  },
  {
    name: "049-nova-ui-meta-contactos.sql",
    checksum: "8b1a98f113f7a6f594ab71359cd493f40a9499c90369f2abf0bf2748cdf7f65d"
  },
  {
    name: "050-nova-lead-product-line.sql",
    checksum: "2fa735028c26bd4b7d0ef1c959164a9751d5a72ddd87024bff7a9538d2898b8b"
  },
  {
    name: "051-liwa-accepted-pending.sql",
    checksum: "e473e592a89295c0b1bd4701806ca9152fc3ca5098377babe03e124edcadc6ea"
  },
  {
    name: "052-nova-conversation-messages.sql",
    checksum: "04238598d846503d6a84a62d27ca18179aa22f4a8b3fa523e0e2d25568d08048"
  },
  {
    name: "053-nova-tenant-owned-routing.sql",
    checksum: "2027d498c91982b36cb906ac6a710d1bec06ec0e50f6a4286020bde650d38730"
  },
  {
    name: "054-nova-voice-orchestration-policy.sql",
    checksum: "1e1b6643cdb4b50a7a91f6455cb4eda9273b9fd5ef30e1ca1968be4a54b2dc8c"
  },
  {
    name: "055-nova-voice-policy-approval-and-exclusions.sql",
    checksum: "ca766a45f7d99f56a3514f3c3118276c0bf19b1fe49ad6ad4a3ce388acd46104"
  },
  {
    name: "056-nova-legacy-audit-outbox-envelope.sql",
    checksum: "fc6ce5cf0e629bfb155e9b183ba11caf60a4c0cbc11bee393af1819fd3aae107"
  }
] as const);

export const NOVA_PROVIDER_TABLES = Object.freeze([
  "documents.inbox_events",
  "documents.objects",
  "documents.outbox_dlq",
  "documents.outbox_events",
  "documents.schema_version",
  "documents.service_migrations",
  "liwa.contact_bindings",
  "liwa.inbox_events",
  "liwa.messages",
  "liwa.outbox_dlq",
  "liwa.outbox_events",
  "liwa.schema_version",
  "liwa.service_migrations",
  "liwa.tenant_bindings",
  "liwa.webhook_receipts",
  "nova.agencies",
  "nova.agent_configs",
  "nova.analytics_daily",
  "nova.campaign_enrollments",
  "nova.campaigns",
  "nova.compliance_settings",
  "nova.contact_attempts",
  "nova.contacts",
  "nova.conversation_messages",
  "nova.conversations",
  "nova.csat_scores",
  "nova.exclusion_registry_entries",
  "nova.exclusion_registry_runs",
  "nova.handoffs",
  "nova.holidays",
  "nova.inbox_events",
  "nova.leads",
  "nova.migration_ledger",
  "nova.operator_grants",
  "nova.opt_outs",
  "nova.outbox_dlq",
  "nova.outbox_events",
  "nova.outcomes",
  "nova.schema_version",
  "nova.service_migrations",
  "nova.tenant_snapshots",
  "nova.tenant_holidays",
  "nova.voice_cutover_receipts",
  "nova.voice_policy_approvals",
  "nova.whatsapp_reviews",
  "voice.calls",
  "voice.campaigns",
  "voice.inbox_events",
  "voice.outbox_dlq",
  "voice.outbox_events",
  "voice.schema_version",
  "voice.service_migrations",
  "voice.webhook_receipts"
] as const);

export const NOVA_RUNTIME_READ_ONLY_TABLES = Object.freeze([
  "nova.exclusion_registry_entries",
  "nova.exclusion_registry_runs",
  "nova.voice_cutover_receipts",
  "nova.voice_policy_approvals"
] as const);

export const NOVA_RUNTIME_NO_DELETE_TABLES = Object.freeze(["nova.tenant_snapshots"] as const);

export const NOVA_PROVIDER_ROUTINES = Object.freeze(["nova.bump_compliance_policy_revision"] as const);

export const SERVICE_DATABASE_ROLES = [
  { environmentVariable: "ACCESS_DATABASE_PASSWORD", role: "hyperion_access" },
  { environmentVariable: "SOFIA_DATABASE_PASSWORD", role: "hyperion_sofia" },
  { environmentVariable: "KNOWLEDGE_DATABASE_PASSWORD", role: "hyperion_knowledge" },
  { environmentVariable: "AUDIT_DATABASE_PASSWORD", role: "hyperion_audit" },
  { environmentVariable: "INTEGRATION_DATABASE_PASSWORD", role: "hyperion_integration" },
  { environmentVariable: "PULSO_DATABASE_PASSWORD", role: "hyperion_pulso" },
  { environmentVariable: "CHANNEL_DATABASE_PASSWORD", role: "hyperion_channel" },
  { environmentVariable: "LUMEN_DATABASE_PASSWORD", role: "hyperion_lumen" },
  { environmentVariable: "NOVA_DATABASE_PASSWORD", role: "hyperion_nova" },
  { environmentVariable: "VOICE_DATABASE_PASSWORD", role: "hyperion_voice" },
  { environmentVariable: "LIWA_DATABASE_PASSWORD", role: "hyperion_liwa" },
  { environmentVariable: "DOCUMENTS_DATABASE_PASSWORD", role: "hyperion_documents" }
] as const;

export type ServiceDatabaseRole = (typeof SERVICE_DATABASE_ROLES)[number]["role"];

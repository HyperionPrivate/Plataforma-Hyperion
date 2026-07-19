export const SERVICE_DATABASE_ROLES = [
  { environmentVariable: "ACCESS_DATABASE_PASSWORD", role: "hyperion_access" },
  { environmentVariable: "SOFIA_DATABASE_PASSWORD", role: "hyperion_sofia" },
  { environmentVariable: "KNOWLEDGE_DATABASE_PASSWORD", role: "hyperion_knowledge" },
  { environmentVariable: "INTEGRATION_DATABASE_PASSWORD", role: "hyperion_integration" },
  { environmentVariable: "PULSO_DATABASE_PASSWORD", role: "hyperion_pulso" },
  { environmentVariable: "CHANNEL_DATABASE_PASSWORD", role: "hyperion_channel" },
  { environmentVariable: "LUMEN_DATABASE_PASSWORD", role: "hyperion_lumen" }
] as const;

export type ServiceDatabaseRole = (typeof SERVICE_DATABASE_ROLES)[number]["role"];

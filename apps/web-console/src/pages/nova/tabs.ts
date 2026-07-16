import type { NovaProductRole, NovaTab } from "./types.js";

export const NOVA_TABS: Array<{ id: NovaTab; label: string; roles: NovaProductRole[] }> = [
  { id: "dashboard", label: "Dashboard", roles: ["admin", "supervisor", "asesor"] },
  { id: "campaigns", label: "Campañas", roles: ["admin", "supervisor"] },
  { id: "conversations", label: "Conversaciones", roles: ["admin", "supervisor", "asesor"] },
  { id: "reviews", label: "Revisión post-llamada", roles: ["admin", "supervisor"] },
  { id: "crm", label: "CRM", roles: ["admin", "supervisor"] },
  { id: "handoff", label: "Handoff por sede", roles: ["admin", "supervisor", "asesor"] },
  { id: "segmentation", label: "Segmentación", roles: ["admin", "supervisor"] },
  { id: "import", label: "Importar", roles: ["admin", "supervisor"] },
  { id: "reports", label: "Reportes", roles: ["admin", "supervisor"] },
  { id: "lab", label: "Laboratorio", roles: ["admin", "supervisor"] },
  { id: "config", label: "Configuración", roles: ["admin"] }
];

export function mapPlatformRole(role: string): NovaProductRole {
  if (role === "admin") return "admin";
  if (role === "coordinator") return "supervisor";
  return "asesor";
}

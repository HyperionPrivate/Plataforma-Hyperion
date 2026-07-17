export type NovaTab =
  | "dashboard"
  | "campaigns"
  | "conversations"
  | "reviews"
  | "crm"
  | "handoff"
  | "segmentation"
  | "import"
  | "reports"
  | "lab"
  | "config";

export type NovaProductRole = "admin" | "supervisor" | "asesor";

export interface DashboardSummary {
  contacts: number;
  campaigns: number;
  handoffsQueued: number;
  leads: number;
  openConversations: number;
}

export interface AnalyticsDailyRow {
  day: string;
  channel: string;
  contacts_imported: number;
  calls_requested: number;
  calls_completed: number;
  calls_failed: number;
  wa_sent: number;
  leads_contacted: number;
  leads_interested: number;
  leads_won: number;
  leads_lost: number;
  handoffs_queued: number;
  csat_sum: number;
  csat_count: number;
}

export interface CampaignRow {
  campaign_id: string;
  name: string;
  channel: string;
  product_flow: string;
  status: string;
}

export interface HandoffRow {
  handoff_id: string;
  contact_id?: string;
  agency_code: string;
  status: string;
  reason?: string;
  claimed_by?: string;
}

export interface ConversationRow {
  conversation_id: string;
  contact_id?: string;
  agency_code?: string;
  status: string;
  channel: string;
  claimed_by?: string;
  last_message_at?: string;
}

export interface CallRow {
  call_id: string;
  status: string;
  transport: string;
  contact_phone_e164: string;
}

export interface LeadRow {
  lead_id: string;
  contact_id?: string;
  stage: string;
  tipification?: string;
  agency_code?: string;
}

export interface ReviewRow {
  review_id: string;
  contact_id: string;
  call_id?: string;
  status: string;
  intent?: string;
  flow_id?: string;
  created_at?: string;
}

export interface ImportedContact {
  contact_id: string;
  phone_e164: string;
  created: boolean;
}

export const CRM_STAGES = [
  "pendiente",
  "contactado",
  "interesado",
  "documento",
  "transferido",
  "renovado",
  "no_interes"
] as const;

export const CRM_STAGE_LABELS: Record<string, string> = {
  pendiente: "Pendiente",
  contactado: "Contactado",
  interesado: "Interesado",
  documento: "Documento",
  transferido: "Transferido",
  renovado: "Renovado",
  no_interes: "No interés",
  new: "Nuevo",
  contacted: "Contactado",
  prequalified: "Prequalificado",
  handoff: "Handoff",
  won: "Ganado",
  lost: "Perdido"
};

export const DEFAULT_NEXT_STAGE: Record<string, string> = {
  pendiente: "contactado",
  contactado: "interesado",
  interesado: "documento",
  documento: "transferido",
  transferido: "renovado",
  new: "contacted",
  contacted: "prequalified",
  prequalified: "handoff",
  handoff: "won"
};

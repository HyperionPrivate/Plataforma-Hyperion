import type { PulsoIrisAvailabilitySlots } from "@hyperion/pulso-contracts";
import type { AvailabilitySlotFilters } from "./availability-engine.js";

export type AgendaProviderErrorCode =
  "agenda_paused" | "hold_expired" | "idempotency_conflict" | "invalid_transition" | "slot_unavailable";

export class AgendaProviderError extends Error {
  constructor(
    readonly code: AgendaProviderErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface AgendaHold {
  id: string;
  tenantId: string;
  patientId?: string;
  conversationId?: string;
  siteId: string;
  professionalId: string;
  payerId?: string;
  appointmentTypeId: string;
  scheduledAt: string;
  durationMin: number;
  slotCapacityToken: number;
  status: "active" | "consumed" | "expired" | "cancelled";
  expiresAt: string;
  idempotencyKey: string;
  appointmentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgendaAppointmentRecord {
  id: string;
  tenantId: string;
  status: string;
  verificationMode?: string;
  scheduledAt?: string;
  idempotencyKey?: string;
  holdId?: string;
}

export interface AgendaExpiredHold {
  id: string;
  tenantId: string;
}

export interface AgendaReservationResult {
  hold: AgendaHold;
  idempotent: boolean;
  expiredHolds: AgendaExpiredHold[];
}

export interface AgendaReservationInput {
  tenantId: string;
  patientId?: string;
  conversationId?: string;
  siteId: string;
  professionalId: string;
  payerId?: string;
  appointmentTypeId: string;
  scheduledAt: string;
  idempotencyKey: string;
  actorId?: string;
  holdDurationMinutes: number;
}

export interface InternalVerificationInput {
  tenantId: string;
  holdId: string;
  appointmentIdempotencyKey: string;
  origin: string;
  actorId?: string;
  previousAppointmentId?: string;
  rescheduleCount?: number;
}

export interface AgendaCancellationInput {
  tenantId: string;
  appointmentId: string;
  actorId?: string;
  reason: string;
}

export interface AgendaRescheduleInput {
  tenantId: string;
  appointmentId: string;
  replacementAppointmentId: string;
  actorId?: string;
  reason: string;
}

export interface AgendaProvider {
  readonly kind: "internal";
  consultAvailability(filters: AvailabilitySlotFilters): Promise<PulsoIrisAvailabilitySlots>;
  reserve(input: AgendaReservationInput): Promise<AgendaReservationResult>;
  verify(input: InternalVerificationInput): Promise<{ appointment: AgendaAppointmentRecord; idempotent: boolean }>;
  cancel(input: AgendaCancellationInput): Promise<AgendaAppointmentRecord>;
  reschedule(input: AgendaRescheduleInput): Promise<AgendaAppointmentRecord>;
}

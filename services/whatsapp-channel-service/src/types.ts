export const WHATSAPP_PROVIDER_MODE = "whatsapp_web_test" as const;

export type WhatsAppConnectionState = "disconnected" | "qr_pending" | "connecting" | "ready" | "degraded";

export interface WhatsAppConnectionStatus {
  providerMode: typeof WHATSAPP_PROVIDER_MODE;
  state: WhatsAppConnectionState;
  phoneMasked?: string;
  lastActivityAt?: string;
  lastError?: string;
  qrExpiresAt?: string;
  sessionRestorable: boolean;
}

export interface WhatsAppInboundText {
  tenantId: string;
  provider: typeof WHATSAPP_PROVIDER_MODE;
  externalMessageId: string;
  providerAddress: string;
  phoneHash: string;
  phoneMasked: string;
  body: string;
  receivedAt: Date;
}

export interface WhatsAppOutboundText {
  tenantId: string;
  providerAddress: string;
  phoneHash: string;
  body: string;
}

export interface WhatsAppSendResult {
  providerMessageId: string;
  sentAt: Date;
}

export interface WhatsAppDeliveryUpdate {
  tenantId: string;
  provider: typeof WHATSAPP_PROVIDER_MODE;
  providerMessageId: string;
  status: "delivered" | "read" | "failed";
  occurredAt: Date;
}

export interface WhatsAppProvider {
  readonly mode: typeof WHATSAPP_PROVIDER_MODE;
  setInboundHandler(handler: (message: WhatsAppInboundText) => Promise<void>): void;
  setStatusHandler(handler: (tenantId: string, status: WhatsAppConnectionStatus) => Promise<void>): void;
  setDeliveryHandler(handler: (update: WhatsAppDeliveryUpdate) => Promise<boolean>): void;
  connect(tenantId: string): Promise<WhatsAppConnectionStatus>;
  restore(tenantIds: string[]): Promise<void>;
  status(tenantId: string): WhatsAppConnectionStatus;
  qr(tenantId: string): { qr: string; expiresAt: string } | undefined;
  disconnect(tenantId: string): Promise<void>;
  sendText(message: WhatsAppOutboundText): Promise<WhatsAppSendResult>;
  close(): Promise<void>;
}

export class WhatsAppProviderDisabledError extends Error {
  constructor() {
    super("WhatsApp Web test provider is disabled");
    this.name = "WhatsAppProviderDisabledError";
  }
}

export class WhatsAppProviderNotReadyError extends Error {
  constructor() {
    super("WhatsApp connection is not ready");
    this.name = "WhatsAppProviderNotReadyError";
  }
}

export class WhatsAppProviderRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppProviderRejectedError";
  }
}

export class WhatsAppRateLimitError extends Error {
  constructor() {
    super("Conversation rate limit exceeded");
    this.name = "WhatsAppRateLimitError";
  }
}

/**
 * Compatibility snapshot of the platform catalog formerly imported from
 * `@hyperion/contracts` (DEBT-021). Gateway remains the only consumer of this
 * closed catalog until hostname-edge fully replaces `/v1/platform/catalog`.
 */

export interface CompatibilityServiceCatalogEntry {
  name: string;
  port: number;
  responsibility: string;
  cell: "PLATFORM" | "NOVA" | "LUMEN" | "PULSO_IRIS";
  lifecycle: "active" | "deprecated";
}

export interface CompatibilityProductModule {
  code: string;
  name: string;
  status: "building" | "foundation";
  ownerService: string;
  description: string;
}

export const serviceCatalog: readonly CompatibilityServiceCatalogEntry[] = Object.freeze([
  {
    name: "api-gateway",
    port: 8080,
    responsibility: "Fachada HTTP temporal de compatibilidad, en retirada hacia routing por hostname.",
    cell: "PLATFORM",
    lifecycle: "deprecated"
  },
  {
    name: "identity-service",
    port: 8081,
    responsibility: "Access de plataforma: operadores, SSO, sesiones, grants y permisos.",
    cell: "PLATFORM",
    lifecycle: "active"
  },
  {
    name: "tenant-service",
    port: 8082,
    responsibility: "Aprovisionamiento neutral de clientes, organizaciones y ambientes.",
    cell: "PLATFORM",
    lifecycle: "active"
  },
  {
    name: "agent-service",
    port: 8083,
    responsibility: "Componente PULSO: SOFIA y ciclo de vida operacional de agentes.",
    cell: "PULSO_IRIS",
    lifecycle: "active"
  },
  {
    name: "prompt-flow-service",
    port: 8084,
    responsibility: "Componente PULSO mientras no exista un segundo consumidor: prompts y flujos.",
    cell: "PULSO_IRIS",
    lifecycle: "active"
  },
  {
    name: "knowledge-service",
    port: 8085,
    responsibility: "Componente PULSO mientras no exista un segundo consumidor: knowledge e ingesta.",
    cell: "PULSO_IRIS",
    lifecycle: "active"
  },
  {
    name: "audit-service",
    port: 8086,
    responsibility: "Audit asincrono de plataforma: bitacora inmutable y evidencia operacional.",
    cell: "PLATFORM",
    lifecycle: "active"
  },
  {
    name: "integration-service",
    port: 8087,
    responsibility: "Componente PULSO mientras no exista un segundo consumidor: conectores externos.",
    cell: "PULSO_IRIS",
    lifecycle: "active"
  },
  {
    name: "pulso-iris-service",
    port: 8088,
    responsibility: "Core PULSO IRIS: agenda, handoff, RPA y operacion CEDCO.",
    cell: "PULSO_IRIS",
    lifecycle: "active"
  },
  {
    name: "whatsapp-channel-service",
    port: 8089,
    responsibility: "Componente PULSO mientras no exista un segundo consumidor: canal WhatsApp Web.",
    cell: "PULSO_IRIS",
    lifecycle: "active"
  },
  {
    name: "lumen-service",
    port: 8090,
    responsibility: "Core LUMEN: resumen preconsulta, voz clinica, HC estructurada y aprobacion profesional.",
    cell: "LUMEN",
    lifecycle: "active"
  },
  {
    name: "nova-core-service",
    port: 8091,
    responsibility: "Core NOVA: contactos, campanas, compliance, CRM, handoff y orquestacion.",
    cell: "NOVA",
    lifecycle: "active"
  },
  {
    name: "voice-channel-service",
    port: 8092,
    responsibility: "Componente NOVA: cliente del Neutral Dialer v3 y modo demo ElevenLabs SIP.",
    cell: "NOVA",
    lifecycle: "active"
  },
  {
    name: "liwa-channel-service",
    port: 8093,
    responsibility: "Componente NOVA: canal WhatsApp via LIWA, webhooks e inbox de asesores.",
    cell: "NOVA",
    lifecycle: "active"
  },
  {
    name: "documents-service",
    port: 8094,
    responsibility: "Componente NOVA: metadatos y object storage de documentos.",
    cell: "NOVA",
    lifecycle: "active"
  }
]);

export const productModules: readonly CompatibilityProductModule[] = Object.freeze([
  {
    code: "CORE",
    name: "Nucleo Hyperion",
    status: "building",
    ownerService: "identity-service",
    description: "Plano neutral minimo de Access, aprovisionamiento y Audit."
  },
  {
    code: "PULSO_IRIS",
    name: "PULSO IRIS",
    status: "building",
    ownerService: "pulso-iris-service",
    description: "Atencion y agendamiento inbound con IA para salud visual."
  },
  {
    code: "LUMEN",
    name: "LUMEN",
    status: "building",
    ownerService: "lumen-service",
    description: "Documentacion clinica por voz y expediente estructurado para salud visual."
  },
  {
    code: "NOVA",
    name: "NOVA",
    status: "building",
    ownerService: "nova-core-service",
    description: "Campañas de contacto proactivo por voz IA y WhatsApp."
  },
  {
    code: "CEDCO-R03",
    name: "CEDCO Activos Fijos",
    status: "foundation",
    ownerService: "integration-service",
    description: "Modulo posterior para activos, GLPI, ERP e inventario."
  }
]);

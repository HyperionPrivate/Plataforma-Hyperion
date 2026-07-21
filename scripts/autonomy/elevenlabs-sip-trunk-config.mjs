export const DEFAULT_SIP_TRUNK_CODECS = Object.freeze(["PCMA/8000", "PCMU/8000"]);
export const DEFAULT_SIP_TRUNK_MEDIA_ENCRYPTION = "disabled";

const MEDIA_ENCRYPTION_VALUES = new Set(["disabled", "allowed", "required"]);

export function parseSipTrunkCodecs(raw) {
  const codecs = String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const result = codecs.length ? [...new Set(codecs)] : [...DEFAULT_SIP_TRUNK_CODECS];
  if (result.some((codec) => !/^[A-Za-z0-9_-]+\/\d+$/.test(codec))) {
    throw new Error("SIP_TRUNK_CODECS must be a comma-separated codec/rate list");
  }
  return result;
}

export function normalizeSipMediaEncryption(raw) {
  const value = String(raw || DEFAULT_SIP_TRUNK_MEDIA_ENCRYPTION)
    .trim()
    .toLowerCase();
  if (!MEDIA_ENCRYPTION_VALUES.has(value)) {
    throw new Error("SIP_TRUNK_MEDIA_ENCRYPTION must be disabled, allowed, or required");
  }
  return value;
}

export function buildOutboundTrunkConfig(trunk) {
  const address = String(trunk.address || "").trim();
  const username = String(trunk.username || "").trim();
  const password = String(trunk.password || "").trim();
  const transport = String(trunk.transport || "tcp")
    .trim()
    .toLowerCase();
  if (!address || !username || !password) {
    throw new Error("SIP trunk address and credentials are required");
  }
  if (!new Set(["tcp", "udp", "tls"]).has(transport)) {
    throw new Error("SIP_TRUNK_TRANSPORT must be tcp, udp, or tls");
  }
  return {
    address,
    transport,
    media_encryption: normalizeSipMediaEncryption(trunk.mediaEncryption),
    credentials: { username, password },
    enabled_codecs: parseSipTrunkCodecs(trunk.enabledCodecs)
  };
}

function readOutboundTrunkConfig(details) {
  const provider = details?.provider_config ?? details ?? {};
  return provider.outbound_trunk_config ?? provider.outbound ?? provider;
}

export function assertOutboundTrunkReadback(details, expected) {
  const actual = readOutboundTrunkConfig(details);
  const mismatches = [];
  if (
    String(actual.address || "")
      .trim()
      .toLowerCase() !== expected.address.toLowerCase()
  ) {
    mismatches.push("address");
  }
  if (
    String(actual.transport || "")
      .trim()
      .toLowerCase() !== expected.transport
  ) {
    mismatches.push("transport");
  }
  if (
    String(actual.media_encryption || "")
      .trim()
      .toLowerCase() !== expected.media_encryption
  ) {
    mismatches.push("media_encryption");
  }
  const actualCodecs = new Set(Array.isArray(actual.enabled_codecs) ? actual.enabled_codecs.map(String) : []);
  if (expected.enabled_codecs.some((codec) => !actualCodecs.has(codec))) {
    mismatches.push("enabled_codecs");
  }
  if (mismatches.length) {
    throw new Error(`ElevenLabs SIP trunk readback mismatch: ${mismatches.join(", ")}`);
  }
}

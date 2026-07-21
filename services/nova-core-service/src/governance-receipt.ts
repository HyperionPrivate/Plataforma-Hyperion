import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface SignedGovernanceReceipt {
  version: "nova.governance-receipt.v1";
  kind: "policy_approval" | "exclusion_registry" | "cutover_attestation";
  tenant_id: string;
  actor: string;
  issued_at: string;
  expires_at: string;
  [claim: string]: unknown;
}

export interface VerifiedGovernanceReceipt {
  receipt: SignedGovernanceReceipt;
  receiptSha256: string;
  signatureSha256: string;
  signerKeySha256: string;
}

export async function verifyGovernanceReceiptFiles(
  receiptPath: string,
  signaturePath: string,
  publicKeyPath: string
): Promise<VerifiedGovernanceReceipt> {
  const [receiptBytes, signatureBytes, publicKeyBytes] = await Promise.all([
    readFile(receiptPath),
    readFile(signaturePath),
    readFile(publicKeyPath)
  ]);
  return verifyGovernanceReceiptBytes(receiptBytes, signatureBytes, publicKeyBytes);
}

export async function readGovernancePublicKeySha256(publicKeyPath: string): Promise<string> {
  const publicKey = createPublicKey(await readFile(publicKeyPath));
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("governance public key must be Ed25519");
  }
  return sha256(publicKey.export({ type: "spki", format: "der" }));
}

export function verifyGovernanceReceiptBytes(
  receiptBytes: Uint8Array,
  signatureInput: Uint8Array,
  publicKeyBytes: Uint8Array
): VerifiedGovernanceReceipt {
  const publicKey = createPublicKey(Buffer.from(publicKeyBytes));
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("governance public key must be Ed25519");
  }
  const signature = decodeSignature(signatureInput);
  if (!verify(null, receiptBytes, publicKey, signature)) {
    throw new Error("governance receipt signature is invalid");
  }

  const parsed = JSON.parse(Buffer.from(receiptBytes).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("governance receipt must be a JSON object");
  }
  const receipt = parsed as SignedGovernanceReceipt;
  if (receipt.version !== "nova.governance-receipt.v1") {
    throw new Error("unsupported governance receipt version");
  }
  if (!(["policy_approval", "exclusion_registry", "cutover_attestation"] as const).includes(receipt.kind)) {
    throw new Error("unsupported governance receipt kind");
  }
  for (const field of ["tenant_id", "actor", "issued_at", "expires_at"] as const) {
    if (typeof receipt[field] !== "string" || !receipt[field].trim()) {
      throw new Error(`governance receipt ${field} must be a non-empty string`);
    }
  }

  return {
    receipt,
    receiptSha256: sha256(receiptBytes),
    signatureSha256: sha256(signature),
    signerKeySha256: sha256(publicKey.export({ type: "spki", format: "der" }))
  };
}

export function assertGovernanceReceiptClaims(
  receipt: SignedGovernanceReceipt,
  expected: Readonly<Record<string, string | number>>,
  maxLifetimeDays: number,
  now = new Date()
): void {
  for (const [claim, expectedValue] of Object.entries(expected)) {
    if (receipt[claim] !== expectedValue) {
      throw new Error(`governance receipt claim mismatch: ${claim}`);
    }
  }
  const issuedAt = Date.parse(receipt.issued_at);
  const expiresAt = Date.parse(receipt.expires_at);
  const nowMs = now.getTime();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    throw new Error("governance receipt timestamps must be ISO-8601 values");
  }
  if (issuedAt > nowMs + 5 * 60_000 || issuedAt < nowMs - 24 * 60 * 60_000) {
    throw new Error("governance receipt issued_at must be within the last 24 hours");
  }
  if (expiresAt <= nowMs || expiresAt <= issuedAt) {
    throw new Error("governance receipt expires_at must be after issued_at and in the future");
  }
  if (expiresAt - issuedAt > maxLifetimeDays * 24 * 60 * 60_000) {
    throw new Error(`governance receipt lifetime must not exceed ${maxLifetimeDays} days`);
  }
}

function decodeSignature(input: Uint8Array): Buffer {
  const bytes = Buffer.from(input);
  if (bytes.length === 64) return bytes;
  const text = bytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new Error("governance signature must be raw Ed25519 bytes or base64");
  }
  const decoded = Buffer.from(text, "base64");
  if (decoded.length !== 64) throw new Error("governance Ed25519 signature must be 64 bytes");
  return decoded;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

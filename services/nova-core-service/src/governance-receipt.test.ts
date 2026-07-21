import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertGovernanceReceiptClaims, verifyGovernanceReceiptBytes } from "./governance-receipt.js";

describe("signed governance receipts", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = Buffer.from(publicKey.export({ type: "spki", format: "pem" }) as string, "utf8");
  const now = new Date("2026-07-20T12:00:00.000Z");
  const receipt = Buffer.from(
    JSON.stringify({
      version: "nova.governance-receipt.v1",
      kind: "cutover_attestation",
      tenant_id: "4fb008f2-b47a-4bd0-a339-7579553ed22d",
      actor: "release-manager@example.test",
      gate: "release_artifact",
      subject_ref: `sha256:${"a".repeat(64)}`,
      scope_sha256: "b".repeat(64),
      issued_at: "2026-07-20T11:55:00.000Z",
      expires_at: "2026-07-27T11:55:00.000Z"
    })
  );

  it("verifies Ed25519 bytes and exact contextual claims", () => {
    const verified = verifyGovernanceReceiptBytes(receipt, sign(null, receipt, privateKey), publicKeyPem);
    expect(verified.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verified.signatureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verified.signerKeySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      assertGovernanceReceiptClaims(
        verified.receipt,
        {
          kind: "cutover_attestation",
          tenant_id: "4fb008f2-b47a-4bd0-a339-7579553ed22d",
          gate: "release_artifact",
          subject_ref: `sha256:${"a".repeat(64)}`,
          scope_sha256: "b".repeat(64),
          actor: "release-manager@example.test"
        },
        30,
        now
      )
    ).not.toThrow();
  });

  it("rejects tampering, wrong claims and stale receipts", () => {
    const signature = sign(null, receipt, privateKey);
    expect(() =>
      verifyGovernanceReceiptBytes(Buffer.from(`${receipt.toString("utf8")} `), signature, publicKeyPem)
    ).toThrow("signature is invalid");
    const verified = verifyGovernanceReceiptBytes(receipt, signature, publicKeyPem);
    expect(() => assertGovernanceReceiptClaims(verified.receipt, { actor: "someone-else" }, 30, now)).toThrow(
      "claim mismatch: actor"
    );
    expect(() => assertGovernanceReceiptClaims(verified.receipt, {}, 30, new Date("2026-07-22T12:00:00.000Z"))).toThrow(
      "within the last 24 hours"
    );
  });
});

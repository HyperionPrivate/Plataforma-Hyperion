import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import {
  assertGovernanceReceiptClaims,
  readGovernancePublicKeySha256,
  verifyGovernanceReceiptFiles
} from "./governance-receipt.js";
import { computeVoicePolicySha256, type RevisionedVoicePolicy } from "./voice-policy.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{7,14}$/;
const CUTOVER_GATES = [
  "retention_policy",
  "monitoring_on_call",
  "coordinated_recovery",
  "release_artifact",
  "provider_connectivity",
  "consented_test_call"
] as const;
type CutoverGate = (typeof CUTOVER_GATES)[number];

type PolicyRow = RevisionedVoicePolicy;
interface ExclusionEntry {
  phone_e164: string;
  reason?: string;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.NOVA_MIGRATOR_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("NOVA_MIGRATOR_DATABASE_URL is required");
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const db = createDatabase(databaseUrl);
  try {
    await assertMigrator(db);
    if (command === "approve-policy") await approvePolicy(db, args);
    else if (command === "import-exclusions") await importExclusions(db, args);
    else if (command === "attest-cutover") await attestCutover(db, args);
    else if (command === "verify-cutover") await verifyCutover(db, args);
    else throw new Error("command must be approve-policy, import-exclusions, attest-cutover or verify-cutover");
  } finally {
    await db.close();
  }
}

async function attestCutover(db: DatabaseClient, args: Map<string, string>): Promise<void> {
  const tenantId = required(args, "tenant");
  const gate = required(args, "gate") as CutoverGate;
  const subject = required(args, "subject");
  const attestedBy = required(args, "attested-by");
  assertUuid(tenantId, "tenant");
  if (!(CUTOVER_GATES as readonly string[]).includes(gate)) {
    throw new Error(`--gate must be one of: ${CUTOVER_GATES.join(", ")}`);
  }
  if (gate === "release_artifact" && !/^sha256:[a-f0-9]{64}$/.test(subject)) {
    throw new Error("release_artifact --subject must be an immutable sha256:<digest>");
  }
  if (gate === "consented_test_call" && !UUID.test(subject)) {
    throw new Error("consented_test_call --subject must be the call correlation UUID");
  }
  const scopeSha256 = sha256(await readFile(required(args, "scope")));
  const verified = await readVerifiedReceipt(args);
  assertGovernanceReceiptClaims(
    verified.receipt,
    {
      kind: "cutover_attestation",
      tenant_id: tenantId,
      gate,
      subject_ref: subject,
      scope_sha256: scopeSha256,
      actor: attestedBy
    },
    30
  );
  const confirmation = `ATTEST ${tenantId} ${gate} ${subject} ${scopeSha256} ${verified.receiptSha256} ${verified.signatureSha256} ${verified.signerKeySha256}`;
  if (args.has("dry-run")) {
    process.stdout.write(`${confirmation}\n`);
    return;
  }
  if (required(args, "confirm") !== confirmation) throw new Error(`confirmation mismatch; expected: ${confirmation}`);
  await db.transaction(async (tx) => {
    await tx.query(
      `update nova.voice_cutover_receipts
          set status = 'superseded', updated_at = now()
        where tenant_id = $1 and gate_name = $2 and status = 'current'`,
      [tenantId, gate]
    );
    await tx.query(
      `insert into nova.voice_cutover_receipts (
         tenant_id, gate_name, subject_ref, scope_sha256, receipt_sha256,
         signature_sha256, signer_key_sha256, attested_by, expires_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
      [
        tenantId,
        gate,
        subject,
        scopeSha256,
        verified.receiptSha256,
        verified.signatureSha256,
        verified.signerKeySha256,
        attestedBy,
        verified.receipt.expires_at
      ]
    );
  });
  process.stdout.write(`attested tenant=${tenantId} gate=${gate} scope_sha256=${scopeSha256}\n`);
}

async function verifyCutover(db: DatabaseClient, args: Map<string, string>): Promise<void> {
  const tenantId = required(args, "tenant");
  assertUuid(tenantId, "tenant");
  const scopeSha256 = sha256(await readFile(required(args, "scope")));
  const signerKeySha256 = await readGovernancePublicKeySha256(required(args, "public-key"));
  const blockers: string[] = [];
  const tenant = await db.query<{ status: string }>("select status from nova.tenant_snapshots where tenant_id = $1", [
    tenantId
  ]);
  if (tenant.rows[0]?.status !== "active") blockers.push("tenant_not_active");

  let policy: PolicyRow | undefined;
  try {
    policy = await loadPolicy(db, tenantId);
  } catch {
    blockers.push("voice_policy_missing");
  }
  if (policy) {
    const policySha256 = computeVoicePolicySha256(policy);
    const approval = await db.query<{ policySha256: string; signerKeySha256: string }>(
      `select policy_sha256 as "policySha256", signer_key_sha256 as "signerKeySha256"
         from nova.voice_policy_approvals
        where tenant_id = $1 and policy_revision = $2 and status = 'approved'
          and expires_at > now()`,
      [tenantId, policy.policyRevision]
    );
    if (!approval.rows[0]) blockers.push("voice_policy_unapproved");
    else if (approval.rows[0].policySha256 !== policySha256) blockers.push("voice_policy_hash_mismatch");
    else if (approval.rows[0].signerKeySha256 !== signerKeySha256) blockers.push("voice_policy_signer_mismatch");
  }

  const registry = await db.query(
    `select 1 from nova.exclusion_registry_runs
      where tenant_id = $1 and status = 'ready' and valid_until > now()
        and signer_key_sha256 = $2 limit 1`,
    [tenantId, signerKeySha256]
  );
  if ((registry.rowCount ?? 0) === 0) blockers.push("exclusion_registry_not_current");

  const receipts = await db.query<{
    gateName: CutoverGate;
    subjectRef: string;
    attestedAt: Date;
    expiresAt: Date;
  }>(
    `select gate_name as "gateName", subject_ref as "subjectRef",
            attested_at as "attestedAt", expires_at as "expiresAt"
       from nova.voice_cutover_receipts
      where tenant_id = $1 and scope_sha256 = $2 and status = 'current'
        and expires_at > now() and signer_key_sha256 = $3`,
    [tenantId, scopeSha256, signerKeySha256]
  );
  const receiptByGate = new Map(receipts.rows.map((row) => [row.gateName, row]));
  for (const gate of CUTOVER_GATES) {
    if (!receiptByGate.has(gate)) blockers.push(`cutover_receipt_missing:${gate}`);
  }

  const testCall = receiptByGate.get("consented_test_call");
  if (testCall) {
    const terminal = await db.query(
      `select 1 from nova.inbox_events
        where tenant_id = $1 and correlation_id = $2::uuid
          and event_type = 'voice.call.completed' and processed_at is not null
          and payload ->> 'status' = 'completed'
          and received_at >= $3::timestamptz and received_at <= $4::timestamptz
        limit 1`,
      [tenantId, testCall.subjectRef, testCall.attestedAt, testCall.expiresAt]
    );
    if ((terminal.rowCount ?? 0) === 0) blockers.push("consented_test_call_not_terminal");
  }

  const health = await db.query<{
    novaDlq: string;
    novaFailed: string;
  }>(
    `select
       (select count(*)::text from nova.outbox_dlq where tenant_id = $1 and redriven_at is null) as "novaDlq",
       (select count(*)::text from nova.outbox_events where tenant_id = $1 and status = 'failed') as "novaFailed"`,
    [tenantId]
  );
  const counts = health.rows[0];
  if (Number(counts?.novaDlq) > 0) blockers.push("nova_dlq_unresolved");
  if (Number(counts?.novaFailed) > 0) blockers.push("nova_outbox_failed");

  process.stdout.write(
    `${JSON.stringify({ tenant_id: tenantId, scope_sha256: scopeSha256, status: blockers.length ? "blocked" : "ready", blockers })}\n`
  );
  if (blockers.length) process.exitCode = 2;
}

async function assertMigrator(db: DatabaseClient): Promise<void> {
  const identity = await db.query<{ role: string }>("select current_user as role");
  if (identity.rows[0]?.role !== "hyperion_nova_migrator") {
    throw new Error("voice governance changes require current_user=hyperion_nova_migrator");
  }
}

async function approvePolicy(db: DatabaseClient, args: Map<string, string>): Promise<void> {
  const tenantId = required(args, "tenant");
  const approvedBy = required(args, "approved-by");
  assertUuid(tenantId, "tenant");
  const policy = await loadPolicy(db, tenantId);
  const policySha256 = computeVoicePolicySha256(policy);
  const verified = await readVerifiedReceipt(args);
  assertGovernanceReceiptClaims(
    verified.receipt,
    {
      kind: "policy_approval",
      tenant_id: tenantId,
      policy_revision: policy.policyRevision,
      policy_sha256: policySha256,
      actor: approvedBy
    },
    366
  );
  const confirmation = `APPROVE ${tenantId} ${policy.policyRevision} ${policySha256} ${verified.receiptSha256} ${verified.signatureSha256} ${verified.signerKeySha256}`;
  if (args.has("dry-run")) {
    process.stdout.write(`${confirmation}\n`);
    return;
  }
  if (required(args, "confirm") !== confirmation) throw new Error(`confirmation mismatch; expected: ${confirmation}`);
  await db.query(
    `insert into nova.voice_policy_approvals (
       tenant_id, policy_revision, policy_sha256, approved_by,
       approval_receipt_sha256, approval_signature_sha256, signer_key_sha256, expires_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
    [
      tenantId,
      policy.policyRevision,
      policySha256,
      approvedBy,
      verified.receiptSha256,
      verified.signatureSha256,
      verified.signerKeySha256,
      verified.receipt.expires_at
    ]
  );
  process.stdout.write(`approved tenant=${tenantId} revision=${policy.policyRevision} policy_sha256=${policySha256}\n`);
}

async function importExclusions(db: DatabaseClient, args: Map<string, string>): Promise<void> {
  const tenantId = required(args, "tenant");
  const importedBy = required(args, "imported-by");
  const source = required(args, "source");
  const inputPath = required(args, "input");
  const validUntil = required(args, "valid-until");
  assertUuid(tenantId, "tenant");
  if (!Number.isFinite(Date.parse(validUntil)) || Date.parse(validUntil) <= Date.now()) {
    throw new Error("valid-until must be a future ISO-8601 timestamp");
  }
  const raw = await readFile(inputPath);
  const entriesSha256 = sha256(raw);
  const entries = parseExclusionEntries(raw.toString("utf8"));
  const verified = await readVerifiedReceipt(args);
  assertGovernanceReceiptClaims(
    verified.receipt,
    {
      kind: "exclusion_registry",
      tenant_id: tenantId,
      source,
      entries_sha256: entriesSha256,
      record_count: entries.length,
      actor: importedBy,
      expires_at: new Date(validUntil).toISOString()
    },
    30
  );
  const confirmation = `IMPORT ${tenantId} ${entries.length} ${entriesSha256} ${verified.receiptSha256} ${verified.signatureSha256} ${verified.signerKeySha256} ${new Date(validUntil).toISOString()}`;
  if (args.has("dry-run")) {
    process.stdout.write(`${confirmation}\n`);
    return;
  }
  if (required(args, "confirm") !== confirmation) throw new Error(`confirmation mismatch; expected: ${confirmation}`);

  const tenant = await db.query<{ status: string }>("select status from nova.tenant_snapshots where tenant_id = $1", [
    tenantId
  ]);
  if (tenant.rows[0]?.status !== "active") throw new Error("tenant must exist and be active");
  const runId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      `update nova.exclusion_registry_runs
          set status = 'superseded', updated_at = now()
        where tenant_id = $1 and status = 'ready'`,
      [tenantId]
    );
    await tx.query(
      `insert into nova.exclusion_registry_runs (
         tenant_id, run_id, source, status, completed_at, valid_until,
         source_receipt_sha256, source_signature_sha256, signer_key_sha256,
         record_count, imported_by
       ) values ($1, $2, $3, 'ready', now(), $4::timestamptz, $5, $6, $7, $8, $9)`,
      [
        tenantId,
        runId,
        source,
        validUntil,
        verified.receiptSha256,
        verified.signatureSha256,
        verified.signerKeySha256,
        entries.length,
        importedBy
      ]
    );
    for (const entry of entries) {
      await tx.query(
        `insert into nova.exclusion_registry_entries (tenant_id, run_id, phone_e164, reason)
         values ($1, $2, $3, $4)`,
        [tenantId, runId, entry.phone_e164, entry.reason ?? null]
      );
    }
  });
  process.stdout.write(
    `imported tenant=${tenantId} run_id=${runId} records=${entries.length} entries_sha256=${entriesSha256}\n`
  );
}

async function loadPolicy(db: DatabaseClient, tenantId: string): Promise<PolicyRow> {
  const result = await db.query<PolicyRow>(
    `select window_start_hour as "windowStartHour", window_end_hour as "windowEndHour",
            time_zone as "timeZone", allowed_weekdays as "allowedWeekdays",
            voice_enabled as "voiceEnabled", whatsapp_enabled as "whatsappEnabled",
            max_attempts_per_day as "maxAttemptsPerDay",
            max_attempts_per_contact as "maxAttemptsPerContact",
            rolling_window_days as "rollingWindowDays",
            max_concurrent_calls as "maxConcurrentCalls",
            min_hours_between_attempts as "minHoursBetweenAttempts",
            respect_holidays as "respectHolidays", policy_revision as "policyRevision"
       from nova.compliance_settings where tenant_id = $1`,
    [tenantId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("stored voice policy not found");
  return { ...row, policyRevision: Number(row.policyRevision) };
}

function parseExclusionEntries(raw: string): ExclusionEntry[] {
  const input = JSON.parse(raw) as unknown;
  if (!Array.isArray(input)) throw new Error("input must be a JSON array");
  const unique = new Map<string, ExclusionEntry>();
  for (const item of input) {
    const entry = typeof item === "string" ? { phone_e164: item } : item;
    if (!entry || typeof entry !== "object") throw new Error("each exclusion entry must be a string or object");
    const phone = (entry as { phone_e164?: unknown }).phone_e164;
    const reason = (entry as { reason?: unknown }).reason;
    if (typeof phone !== "string" || !E164.test(phone)) throw new Error("every phone_e164 must be valid E.164");
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
      throw new Error("entry reason must be a string of at most 500 characters");
    }
    unique.set(phone, { phone_e164: phone, ...(reason ? { reason } : {}) });
  }
  return [...unique.values()].sort((a, b) => a.phone_e164.localeCompare(b.phone_e164));
}

function parseArgs(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key ?? ""}`);
    if (key === "--dry-run") {
      parsed.set("dry-run", "true");
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    parsed.set(key.slice(2), value);
    index += 1;
  }
  return parsed;
}

function required(args: Map<string, string>, name: string): string {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function readVerifiedReceipt(args: Map<string, string>) {
  return verifyGovernanceReceiptFiles(
    required(args, "receipt"),
    required(args, "signature"),
    required(args, "public-key")
  );
}

function assertUuid(value: string, name: string): void {
  if (!UUID.test(value)) throw new Error(`--${name} must be a UUID`);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

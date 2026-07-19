import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

test("NOVA acceptance proves a lost Audit acknowledgement is retried idempotently", async () => {
  const script = await source("scripts/autonomy/nova-audit-http.e2e.mjs");
  assert.match(script, /services\/nova-core-service\/dist\/index\.js/);
  assert.match(script, /services\/audit-service\/dist\/index\.js/);
  assert.match(script, /createAuditFaultProxy/);
  assert.match(script, /dropNextAcknowledgement = true/);
  assert.match(script, /lastError === "network_error"/);
  assert.match(script, /status === "completed" && state\.attemptCount >= 3/);
  assert.match(script, /\[201, 200\]/);
  assert.match(script, /delivery\.caller, "nova-core-service"/);
  assert.match(script, /deliveries\[1\]\.response\?\.data\?\.status, "duplicate"/);
  assert.match(script, /payload #>> '\{metadata,domainPayload,phone_e164\}' = \$2/);
  assert.match(script, /payload->>'entityId' = \$3/);
  assert.match(script, /must target a disposable database ending in _ci or _acceptance/);
  assert.match(script, /for \(const service of services\) assertServiceRunning\(service\)/);
  assert.match(script, /inboxCount: 1, auditCount: 1/);
  assert.doesNotMatch(script, /const replay = await fetch/);
  assert.doesNotMatch(script, /lumen|pulso|sofia/i);
});

test("NOVA logical-database CI executes the real Audit recovery acceptance without sibling cells", async () => {
  const workflow = await source(".github/workflows/_cell-ci.yml");
  const start = workflow.indexOf("nova-database-smoke:");
  const end = workflow.indexOf("audit-database-smoke:", start);
  assert.ok(start >= 0 && end > start, "NOVA database job could not be isolated");
  const novaJob = workflow.slice(start, end);
  assert.match(novaJob, /@hyperion\/audit-migrations/);
  assert.match(novaJob, /@hyperion\/audit-service/);
  assert.match(novaJob, /TEST_AUDIT_DATABASE_URL=/);
  assert.match(novaJob, /node scripts\/autonomy\/nova-audit-http\.e2e\.mjs/);
  assert.doesNotMatch(novaJob, /@hyperion\/(?:lumen|pulso)-/);
  assert.doesNotMatch(novaJob, /LUMEN_|PULSO_|SOFIA_/);
});

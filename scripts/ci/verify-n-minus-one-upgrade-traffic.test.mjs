import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "verify-n-minus-one-upgrade-traffic.sh");

/**
 * The N-1 drain query joins CTEs that share column names (event_type,
 * event_version, stream_id, …). PostgreSQL rejects unqualified references in
 * those JOIN scopes with "column reference is ambiguous".
 */
function extractVerifySql(source) {
  const marker = "with source as materialized (";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "expected verify SQL CTE block");
  const end = source.indexOf('"', start);
  assert.notEqual(end, -1, "expected closing quote for verify SQL");
  return source.slice(start, end);
}

test("N-1 verify SQL qualifies shared event columns in joined scopes", () => {
  const sql = extractVerifySql(readFileSync(scriptPath, "utf8"));

  // Unqualified forms that previously failed under pulso_inbox ⨯ channel_event.
  assert.doesNotMatch(
    sql,
    /and\s+event_type\s*=\s*channel_event\.event_type/i,
    "pulso_inbox.event_type must be qualified"
  );
  assert.doesNotMatch(
    sql,
    /and\s+event_version\s*=\s*channel_event\.event_version/i,
    "pulso_inbox.event_version must be qualified"
  );
  assert.match(sql, /pulso_inbox\.event_type\s*=\s*channel_event\.event_type/);
  assert.match(sql, /pulso_inbox\.event_version\s*=\s*channel_event\.event_version/);
  assert.match(sql, /pulso_inbox\.stream_id\s*=\s*channel_event\.stream_id/);
  assert.match(sql, /agent_inbox\.event_type\s*=/);
  assert.match(sql, /agent_inbox\.stream_id\s*=\s*pulso_event\.stream_id/);
  assert.match(sql, /job\.ordering_source\s*=/);
  assert.match(sql, /channel_event\.stream_id\s*=\s*source\.thread_binding_id/);
});

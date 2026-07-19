import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const polishPath = resolve(repositoryRoot, "scripts/ops/polish-coopfuturo-demo.sql");
const reviewPath = resolve(repositoryRoot, "scripts/ops/review-last-call.sql");
const reviewWrapperPath = resolve(repositoryRoot, "scripts/ops/review-last-call.sh");

const canonicalUuidLiteral = /(['"])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\1/gi;

function assertRequiredTenantVariable(source, fileName) {
  assert.match(source, /\\if\s+:\{\?tenant_id\}/, `${fileName} must reject a missing tenant_id`);
  assert.match(
    source,
    /SELECT\s+:'tenant_id'\s+~\*\s+'\^\[0-9a-f\]/i,
    `${fileName} must validate tenant_id before casting it`
  );
  assert.match(source, /\\quit\s+64/, `${fileName} must stop on invalid tenant input`);
}

function assertPolishSqlIsTenantScoped(source) {
  assertRequiredTenantVariable(source, "polish-coopfuturo-demo.sql");
  assert.doesNotMatch(source, canonicalUuidLiteral, "the demo polish script must not embed a tenant UUID");
  assert.match(
    source,
    /SET LOCAL hyperion\.ops_tenant_id TO :'tenant_id'/,
    "the validated psql variable must enter the transaction explicitly"
  );
  assert.match(
    source,
    /v_tenant CONSTANT uuid := current_setting\('hyperion\.ops_tenant_id'\)::uuid/,
    "all demo operations must derive v_tenant from the validated input"
  );

  const tenantDataStatements = source.split(";").filter((statement) => /\bnova\.[a-z_]+\b/i.test(statement));
  assert.ok(tenantDataStatements.length > 0, "expected NOVA data operations in the demo polish script");
  for (const statement of tenantDataStatements) {
    assert.match(statement, /\bv_tenant\b/, "every NOVA data operation must use the explicit tenant scope");
  }
}

function assertReviewSqlIsTenantScoped(source) {
  assertRequiredTenantVariable(source, "review-last-call.sql");

  const tenantReadStatements = source
    .split(";")
    .filter((statement) => /\b(?:FROM|JOIN)\s+(?:voice|nova)\.[a-z_]+\b/i.test(statement));
  assert.ok(tenantReadStatements.length > 0, "expected tenant-owned reads in review-last-call.sql");

  for (const statement of tenantReadStatements) {
    assert.match(
      statement,
      /:'tenant_id'\s*::\s*uuid/i,
      "every tenant-owned read must bind the validated psql tenant_id"
    );

    const aliases = [
      ...statement.matchAll(/\b(?:FROM|JOIN)\s+(?:voice|nova)\.[a-z_]+\s+(?:AS\s+)?([a-z_][a-z0-9_]*)/gi)
    ].map((match) => match[1]);
    for (const alias of aliases) {
      assert.match(
        statement,
        new RegExp(`\\b${alias}\\.tenant_id\\b`, "i"),
        `tenant-owned alias ${alias} must participate in the tenant predicate`
      );
    }
  }
}

test("CoopFuturo demo polish requires an explicit tenant UUID", () => {
  assertPolishSqlIsTenantScoped(readFileSync(polishPath, "utf8"));
});

test("last-call review scopes every tenant-owned read", () => {
  assertReviewSqlIsTenantScoped(readFileSync(reviewPath, "utf8"));
});

test("last-call wrapper validates and forwards the tenant without duplicating SQL", () => {
  const wrapper = readFileSync(reviewWrapperPath, "utf8");
  assert.match(wrapper, /tenant_id="\$\{1:-\$\{TENANT_ID:-\}\}"/);
  assert.match(wrapper, /uuid_pattern='\^\[0-9a-fA-F\]/);
  assert.match(wrapper, /-v "tenant_id=\$tenant_id" -f - < "\$sql_file"/);
  assert.doesNotMatch(wrapper, /\b(?:FROM|JOIN)\s+(?:voice|nova)\./i);
});

test("tenant-scope guards detect representative regressions", () => {
  const reviewSql = readFileSync(reviewPath, "utf8");
  const unscopedReviewSql = reviewSql.replace("WHERE c.tenant_id = :'tenant_id'::uuid", "");
  assert.throws(() => assertReviewSqlIsTenantScoped(unscopedReviewSql), /must bind/);

  const polishSql = readFileSync(polishPath, "utf8");
  const hardcodedPolishSql = polishSql.replace(
    "current_setting('hyperion.ops_tenant_id')",
    "'11111111-1111-1111-1111-111111111111'"
  );
  assert.throws(() => assertPolishSqlIsTenantScoped(hardcodedPolishSql), /must not embed a tenant UUID/);
});

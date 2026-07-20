import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the frozen monolith diagnostic records platform and autonomous NOVA migration order", async () => {
  const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/legacy-monolith-diagnostic.yml"), "utf8");
  const orderedSteps = [
    "- name: Migrate test database",
    "- name: Migrate platform-owned Access schema",
    "- name: Generate ephemeral service credentials",
    "- name: Bootstrap isolated NOVA logical database",
    "- name: Run provider-owned NOVA migrations as the NOVA migrator",
    "- name: Activate NOVA runtime roles with the privileged one-shot",
    "- name: Verify autonomous NOVA database, migrator, roles and schema isolation"
  ];
  let previous = -1;
  for (const step of orderedSteps) {
    const position = workflow.indexOf(step);
    assert.ok(position > previous, `${step} must appear after its dependency`);
    previous = position;
  }
  assert.match(workflow, /pnpm --filter @hyperion\/platform-migrations migrate/);
  assert.match(workflow, /'NOVA_MIGRATOR'/);
  assert.match(workflow, /NOVA_POSTGRES_DB=hyperion_nova_ci/);
  assert.match(
    workflow,
    /postgres:\/\/hyperion_nova_migrator:\$\{NOVA_MIGRATOR_DATABASE_PASSWORD\}@localhost:5432\/hyperion_nova_ci/
  );
  assert.match(workflow, /vitest run src\/autonomy\.integration\.test\.ts/);
});

test("NOVA migration one-shots receive only the credentials required by their phase", async () => {
  const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/legacy-monolith-diagnostic.yml"), "utf8");
  const stepBlock = (name, nextName) => {
    const start = workflow.indexOf(`- name: ${name}`);
    const end = workflow.indexOf(`- name: ${nextName}`, start + 1);
    assert.ok(start >= 0 && end > start, `could not isolate workflow step ${name}`);
    return workflow.slice(start, end);
  };
  const bootstrap = stepBlock(
    "Bootstrap isolated NOVA logical database",
    "Run provider-owned NOVA migrations as the NOVA migrator"
  );
  const migrate = stepBlock(
    "Run provider-owned NOVA migrations as the NOVA migrator",
    "Activate NOVA runtime roles with the privileged one-shot"
  );
  const roles = stepBlock(
    "Activate NOVA runtime roles with the privileged one-shot",
    "Verify autonomous NOVA database, migrator, roles and schema isolation"
  );

  for (const block of [bootstrap, migrate, roles]) {
    assert.match(block, /env -i /, "every NOVA one-shot must start from an empty environment");
    assert.doesNotMatch(block, /LUMEN_|PULSO_|SOFIA_|INTEGRATION_|CHANNEL_/);
  }
  assert.match(bootstrap, /NOVA_POSTGRES_ADMIN_URL=/);
  assert.match(bootstrap, /NOVA_MIGRATOR_DATABASE_PASSWORD=/);
  assert.doesNotMatch(bootstrap, /NOVA_DATABASE_PASSWORD=/);
  assert.doesNotMatch(migrate, /NOVA_POSTGRES_ADMIN_URL=/);
  assert.match(migrate, /NOVA_MIGRATOR_DATABASE_URL=/);
  assert.match(roles, /NOVA_POSTGRES_ADMIN_URL=/);
  for (const variable of [
    "NOVA_DATABASE_PASSWORD",
    "VOICE_DATABASE_PASSWORD",
    "LIWA_DATABASE_PASSWORD",
    "DOCUMENTS_DATABASE_PASSWORD"
  ]) {
    assert.match(roles, new RegExp(`${variable}=`));
  }
  assert.doesNotMatch(roles, /NOVA_MIGRATOR_DATABASE_URL=/);
});

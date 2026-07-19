import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "publish-shared-libraries.yml");

test("shared-library publication owns only Database and Logger and is protected-main/tag bound", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const triggerBlock = workflow.slice(0, workflow.indexOf("permissions:"));
  assert.match(triggerBlock, /^\s+workflow_dispatch:/m);
  assert.doesNotMatch(triggerBlock, /^\s+(?:push|pull_request|schedule):/m);
  const options = triggerBlock.match(/options:\s*\r?\n([\s\S]*?)\n\s+version:/)?.[1] ?? "";
  assert.match(options, /^\s+- database$/m);
  assert.match(options, /^\s+- logger$/m);
  assert.doesNotMatch(options, /contracts|nova|lumen|pulso/);
  assert.match(workflow, /environment:\s*release-publication/);
  assert.match(workflow, /timeout-minutes:\s*30/);
  assert.match(
    workflow,
    /concurrency:[\s\S]*?publish-shared-library-\$\{\{ inputs\.library \}\}[\s\S]*?cancel-in-progress:\s*false/
  );
  assert.match(workflow, /REF_PROTECTED:\s*\$\{\{ github\.ref_protected \}\}/);
  assert.match(workflow, /REF_PROTECTED" != "true"/);
  assert.match(workflow, /GITHUB_REF" != "refs\/heads\/main"/);
  assert.match(workflow, /GITHUB_SHA" != "\$SOURCE_REVISION"/);
  assert.match(workflow, /REGISTRY_ORIGIN" != "https:\/\/registry\.npmjs\.org"/);
  assert.match(workflow, /canonical_tag="shared\/\$LIBRARY\/v\$VERSION"/);
  assert.match(workflow, /git rev-parse "\$canonical_tag\^\{commit\}"/);
  assert.ok(
    workflow.indexOf("Require protected main and immutable inputs") < workflow.indexOf("Checkout exact source")
  );
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.source_revision \}\}/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /persist-credentials:\s*false/);
});

test("shared publication uses minimal permissions and verifies the exact package closure", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /permissions:\s*\r?\n\s+contents:\s*read/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /attestations:\s*write/);
  assert.match(workflow, /artifact-metadata:\s*write/);
  assert.doesNotMatch(workflow, /packages:\s*write/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm --filter "\$PACKAGE_NAME\.\.\." build/);
  assert.match(workflow, /pnpm --filter "\$PACKAGE_NAME" typecheck/);
  assert.match(workflow, /pnpm --filter "\$PACKAGE_NAME" test/);
  assert.match(workflow, /pnpm exec eslint "\$PACKAGE_DIRECTORY"/);
  assert.match(workflow, /pnpm exec prettier --check "\$PACKAGE_DIRECTORY"/);
  assert.doesNotMatch(workflow, /pnpm\s+-r\s+build/);
  assert.match(workflow, /artifact\.kind !== 'shared-library'/);
  assert.match(workflow, /publish-shared-libraries\.yml/);
  assert.match(workflow, /shared\/\$\{process\.env\.LIBRARY/);
});

test("pack, no-overwrite, attestation, publication and readback share one reviewed implementation", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const publisher = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "publish-provider-contracts.yml"),
    "utf8"
  );
  for (const operation of ["pack", "preflight", "readback"]) {
    assert.match(workflow, new RegExp(`npm-artifact-publication\\.mjs ${operation}`));
    assert.match(publisher, new RegExp(`npm-artifact-publication\\.mjs ${operation}`));
  }
  assert.match(
    workflow,
    /npm-artifact-publication\.mjs pack[\s\S]*?--source-revision "\$\{\{ inputs\.source_revision \}\}"/
  );
  assert.match(
    publisher,
    /npm-artifact-publication\.mjs pack[\s\S]*?--source-revision "\$\{\{ inputs\.source_revision \}\}"/
  );
  assert.match(workflow, /npm publish "\$TARBALL" --access public --ignore-scripts --registry "\$REGISTRY_ORIGIN"/);
  assert.doesNotMatch(workflow, /npm\s+(?:unpublish|deprecate)|--force|--tag\s+latest/);
  assert.doesNotMatch(workflow, /signer_workflow|inputs\.signer/);
  const pack = workflow.indexOf("Pack once and inspect the publishable manifest");
  const preflight = workflow.indexOf("Authenticate and check exact-version immutability");
  const tarballAttestation = workflow.indexOf("Attest the exact shared-library tarball");
  const publish = workflow.indexOf("Publish the same attested tarball without overwrite");
  const readback = workflow.indexOf("Read back exact bytes");
  const evidenceAttestation = workflow.indexOf("Attest the registry evidence candidate");
  const upload = workflow.indexOf("Upload immutable registry evidence candidate");
  assert.ok(pack < preflight && preflight < tarballAttestation && tarballAttestation < publish);
  assert.ok(publish < readback && readback < evidenceAttestation && evidenceAttestation < upload);
  assert.match(workflow, /--local-tarball "\$LOCAL_TARBALL"/);
  assert.match(workflow, /--attempts 5/);
  assert.match(workflow, /--retry-delay-ms 5000/);
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /if-no-files-found:\s*error/);
  assert.match(workflow, /retention-days:\s*30/);
});

test("Database and Logger are workflow-ready but remain explicitly unpublished", async () => {
  const catalog = JSON.parse(
    await readFile(path.join(repositoryRoot, "releases", "registry", "provider-artifacts.v1.json"), "utf8")
  );
  for (const packageName of ["@hyperion/database", "@hyperion/logger"]) {
    const artifact = catalog.artifacts.find((candidate) => candidate.packageName === packageName);
    assert.equal(artifact.kind, "shared-library");
    assert.equal(artifact.publication.state, "ready");
    assert.equal(artifact.publication.workflow, ".github/workflows/publish-shared-libraries.yml");
    assert.equal(artifact.publication.tagPattern, `shared/${packageName.split("/").at(-1)}/v{version}`);
    assert.equal(artifact.publication.registryEvidence, undefined);
  }
});

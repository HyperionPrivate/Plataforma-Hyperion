import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CELL_COMPOSE_SERVICES } from "../architecture/cell-policy.mjs";
import { createImageBuildPlan } from "./create-image-build-plan.mjs";
import { createRegistryImageInventory } from "./create-registry-image-inventory.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRevision = "c".repeat(40);
const catalogVersionByCell = Object.freeze({
  platform: "2.4.0",
  nova: "1.0.0",
  lumen: "1.1.0",
  pulso: "1.4.0"
});

async function findDockerfiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".docker-contexts", ".git", "dist", "graphify-out", "node_modules"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findDockerfiles(target)));
    if (entry.isFile() && /dockerfile/i.test(entry.name)) files.push(target);
  }
  return files;
}

test("every external Docker base is pinned to a SHA-256 digest", async () => {
  const violations = [];
  for (const dockerfile of await findDockerfiles(repositoryRoot)) {
    const stages = new Set();
    const contents = await readFile(dockerfile, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const from = /^FROM\s+([^\s]+)(?:\s+AS\s+([^\s]+))?/i.exec(line.trim());
      if (!from) continue;
      const image = from[1];
      if (!stages.has(image) && !/@sha256:[a-f0-9]{64}$/i.test(image)) {
        violations.push(`${path.relative(repositoryRoot, dockerfile)}: ${image}`);
      }
      if (from[2]) stages.add(from[2]);
    }
  }
  assert.deepEqual(violations, []);
});

test("every concrete third-party Compose image is pinned to a SHA-256 digest", async () => {
  const violations = [];
  for (const entry of await readdir(path.join(repositoryRoot, "infra"), { withFileTypes: true })) {
    if (!entry.isFile() || !/^docker-compose.*\.yml$/i.test(entry.name)) continue;
    const contents = await readFile(path.join(repositoryRoot, "infra", entry.name), "utf8");
    for (const match of contents.matchAll(/^\s+image:\s+([^\s#]+).*$/gm)) {
      const image = match[1];
      if (image.startsWith("${")) continue;
      if (!/@sha256:[a-f0-9]{64}$/i.test(image)) violations.push(`${entry.name}: ${image}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("every concrete GitHub Actions service image is pinned to a SHA-256 digest", async () => {
  const violations = [];
  const workflowDirectory = path.join(repositoryRoot, ".github", "workflows");
  for (const entry of await readdir(workflowDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const contents = await readFile(path.join(workflowDirectory, entry.name), "utf8");
    for (const match of contents.matchAll(/^ {8}image:\s+([^\s#]+).*$/gm)) {
      const image = match[1];
      if (image.includes("${{")) continue;
      if (!/@sha256:[a-f0-9]{64}$/i.test(image)) violations.push(`${entry.name}: ${image}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("each release build plan exactly matches its cell-owned Compose services", async () => {
  for (const cell of Object.keys(CELL_COMPOSE_SERVICES)) {
    const plan = await createImageBuildPlan(repositoryRoot, cell, catalogVersionByCell[cell]);
    assert.deepEqual(
      plan.components.flatMap((component) => component.composeServices).sort(),
      [...CELL_COMPOSE_SERVICES[cell]].sort()
    );
    for (const component of plan.components) {
      assert.ok(component.composeServices.includes(component.service));
      assert.match(component.repository, /^ghcr\.io\/[a-z0-9-]+\//);
    }
  }
});

test("platform builds exactly seven autonomous OCI images covering eleven Compose aliases", async () => {
  const plan = await createImageBuildPlan(repositoryRoot, "platform", catalogVersionByCell.platform);
  assert.equal(plan.components.length, 7);
  assert.equal(plan.components.flatMap((component) => component.composeServices).length, 11);
  assert.deepEqual(
    plan.components.map((component) => component.id),
    [
      "identity-service",
      "tenant-service",
      "audit-service",
      "access-migrations",
      "audit-migrations",
      "platform-admin-bff",
      "platform-admin-console"
    ]
  );
  assert.equal(
    plan.components.some((component) =>
      ["api-gateway", "web-console", "legacy-global-migrations", "platform-migrations"].includes(component.id)
    ),
    false
  );
});

test("platform builds one Access migrator image for all three provider one-shot aliases", async () => {
  const plan = await createImageBuildPlan(repositoryRoot, "platform", catalogVersionByCell.platform);
  const migrator = plan.components.find((component) => component.id === "access-migrations");
  assert.deepEqual(migrator, {
    id: "access-migrations",
    service: "access-migrations",
    composeServices: ["access-database-bootstrap", "access-migrations", "access-role-bootstrap"],
    repository: "ghcr.io/hyperionprivate/access-migrations"
  });
  assert.equal(
    plan.components.some((component) => ["access-database-bootstrap", "access-role-bootstrap"].includes(component.id)),
    false
  );
  assert.equal(new Set(plan.components.map((component) => component.repository)).size, plan.components.length);
});

test("platform builds one Audit migrator image for all three provider one-shot aliases", async () => {
  const plan = await createImageBuildPlan(repositoryRoot, "platform", catalogVersionByCell.platform);
  const migrator = plan.components.find((component) => component.id === "audit-migrations");
  assert.deepEqual(migrator, {
    id: "audit-migrations",
    service: "audit-migrations",
    composeServices: ["audit-database-bootstrap", "audit-migrations", "audit-role-bootstrap"],
    repository: "ghcr.io/hyperionprivate/audit-migrations"
  });
  assert.equal(
    plan.components.some((component) => ["audit-database-bootstrap", "audit-role-bootstrap"].includes(component.id)),
    false
  );
  assert.equal(new Set(plan.components.map((component) => component.repository)).size, plan.components.length);
});

test("LUMEN builds one provider migrator image for all three one-shot aliases", async () => {
  const plan = await createImageBuildPlan(repositoryRoot, "lumen", catalogVersionByCell.lumen);
  const migrator = plan.components.find((component) => component.id === "lumen-migrations");
  assert.deepEqual(migrator, {
    id: "lumen-migrations",
    service: "lumen-migrations",
    composeServices: ["lumen-database-bootstrap", "lumen-migrations", "lumen-role-bootstrap"],
    repository: "ghcr.io/hyperionprivate/lumen-migrations"
  });
  assert.equal(
    plan.components.some((component) => ["lumen-database-bootstrap", "lumen-role-bootstrap"].includes(component.id)),
    false
  );
  assert.equal(new Set(plan.components.map((component) => component.repository)).size, plan.components.length);
});

test("PULSO builds one provider migrator image for all three one-shot aliases", async () => {
  const plan = await createImageBuildPlan(repositoryRoot, "pulso", catalogVersionByCell.pulso);
  const migrator = plan.components.find((component) => component.id === "pulso-migrations");
  assert.deepEqual(migrator, {
    id: "pulso-migrations",
    service: "pulso-migrations",
    composeServices: ["pulso-database-bootstrap", "pulso-migrations", "pulso-role-bootstrap"],
    repository: "ghcr.io/hyperionprivate/pulso-migrations"
  });
  assert.equal(
    plan.components.some((component) => ["pulso-database-bootstrap", "pulso-role-bootstrap"].includes(component.id)),
    false
  );
  assert.equal(new Set(plan.components.map((component) => component.repository)).size, plan.components.length);
});

test("registry inventory resolves every immutable source tag to an exact registry digest", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hyperion-image-inventory-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "inventory.json");
  const inspected = [];
  const plan = await createImageBuildPlan(repositoryRoot, "lumen", catalogVersionByCell.lumen);
  const inventory = await createRegistryImageInventory(
    { cell: "lumen", catalogVersion: catalogVersionByCell.lumen, sourceRevision, output },
    repositoryRoot,
    (_command, arguments_) => {
      const tag = arguments_.at(-1);
      inspected.push(tag);
      const digest = createHash("sha256").update(tag).digest("hex");
      return {
        status: 0,
        stderr: "",
        stdout: `Name: ${tag}\nMediaType: application/vnd.oci.image.index.v1+json\nDigest: sha256:${digest}\n\nManifests:\n  Digest: sha256:${"f".repeat(64)}\n`
      };
    }
  );
  assert.equal(inspected.length, plan.components.length);
  assert.ok(inspected.every((tag) => tag.endsWith(`:${sourceRevision}`)));
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), inventory);
  assert.ok(Object.values(inventory.images).every((image) => /@sha256:[a-f0-9]{64}$/.test(image)));
});

test("registry inventory fails closed on ambiguous, tagged or missing top-level digests", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hyperion-image-inventory-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      createRegistryImageInventory(
        {
          cell: "lumen",
          catalogVersion: catalogVersionByCell.lumen,
          sourceRevision,
          output: path.join(directory, "bad.json")
        },
        repositoryRoot,
        () => ({ status: 0, stdout: "Name: mutable:latest\n", stderr: "" })
      ),
    /exactly one top-level SHA-256 digest/
  );
});

test("docker push digest parser accepts the documented tag-prefixed output", () => {
  const digest = `sha256:${"d".repeat(64)}`;
  const fixture = `deadbeef: digest: ${digest} size: 1987`;
  const parsed = fixture.match(/^(?:[^\s]+:\s+)?digest:\s+(sha256:[0-9a-f]{64})\s+size:.*$/)?.[1];
  assert.equal(parsed, digest);
});

test("producer workflow attests a run candidate before idempotent source-tag promotion", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "build-attested-cell-images.yml"),
    "utf8"
  );
  for (const input of ["cell", "catalog_version", "source_revision"]) {
    assert.match(workflow, new RegExp(`^      ${input}:`, "m"));
  }
  assert.match(workflow, /concurrency:[\s\S]*?cancel-in-progress:\s*false/);
  assert.match(workflow, /REF_PROTECTED:\s*\$\{\{ github\.ref_protected \}\}/);
  assert.match(workflow, /REF_PROTECTED" != "true"/);
  assert.match(workflow, /GITHUB_REF" != "refs\/heads\/main"/);
  assert.match(workflow, /GITHUB_SHA" != "\$SOURCE_REVISION"/);
  assert.match(workflow, /create-image-build-plan\.mjs/);
  assert.match(workflow, /generate-cell-contexts\.mjs --cell/);
  assert.match(workflow, /cell-compose-plan\.mjs "\$CELL" compose-file/);
  assert.match(workflow, /cell-compose-plan\.mjs "\$CELL" env-file/);
  assert.match(workflow, /COMPOSE_SERVICES_JSON:\s*\$\{\{ toJSON\(matrix\.composeServices\) \}\}/);
  assert.match(workflow, /compose=\(docker compose[\s\S]*-f "\$compose_file"\)/);
  assert.match(workflow, /"\$\{compose\[@\]\}" build "\$\{compose_services\[@\]\}"/);
  assert.match(workflow, /resolve-compose-image-reference\.mjs/);
  assert.match(workflow, /image_id=\$\(docker image inspect --format '\{\{\.Id\}\}' "\$image_reference"\)/);
  assert.match(workflow, /alias_image_id=\$\(docker image inspect --format '\{\{\.Id\}\}' "\$alias_image_reference"\)/);
  assert.doesNotMatch(workflow, /images -q "\$SERVICE"/);
  assert.match(workflow, /alias_image_id" != "\$image_id"/);
  assert.match(
    workflow,
    /candidate_tag="\$\{IMAGE_REPOSITORY\}:candidate-\$\{SOURCE_REVISION\}-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}"/
  );
  assert.match(workflow, /push_output=\$\(docker push "\$candidate_tag" 2>&1\)/);
  assert.match(workflow, /push_digests/);
  assert.ok(
    workflow.includes(
      "sed -nE 's/^([^[:space:]]+:[[:space:]]+)?digest:[[:space:]]+(sha256:[0-9a-f]{64})[[:space:]]+size:.*$/\\2/p'"
    )
  );
  assert.match(workflow, /immutable_reference="\$\{IMAGE_REPOSITORY\}@\$\{digest\}"/);
  assert.match(workflow, /imagetools inspect "\$immutable_reference"/);
  assert.match(workflow, /reference_digests\[0\].*!= "\$digest"/);
  assert.match(workflow, /imagetools inspect "\$candidate_tag"/);
  assert.match(workflow, /candidate_digests\[0\].*!= "\$digest"/);
  assert.match(workflow, /aquasecurity\/setup-trivy@[0-9a-f]{40}/);
  assert.match(workflow, /immutable_reference="\$\{IMAGE_REPOSITORY\}@\$\{DIGEST\}"/);
  assert.match(workflow, /trivy image --no-progress --scanners vuln/);
  assert.match(workflow, /--severity HIGH,CRITICAL --exit-code 1 --format sarif/);
  assert.match(workflow, /name: image-scan-\$\{\{ inputs\.cell \}\}-\$\{\{ matrix\.id \}\}/);
  assert.doesNotMatch(workflow, /digest=\$\(awk[^\n]*<<<"\$inspection"\)/);
  assert.match(workflow, /manifest unknown\|not found/);
  assert.match(workflow, /Registry preflight failed without proving/);
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}/);
  assert.match(workflow, /if: steps\.push\.outputs\.attestation_required == 'true'/);
  assert.match(workflow, /subject-name:\s*\$\{\{ matrix\.repository \}\}/);
  assert.match(workflow, /subject-digest:\s*\$\{\{ steps\.push\.outputs\.digest \}\}/);
  assert.match(workflow, /push-to-registry:\s*true/);
  assert.match(
    workflow,
    /docker buildx imagetools create --prefer-index=false --tag "\$source_tag" "\$immutable_reference"/
  );
  assert.match(workflow, /Immutable source tag \$source_tag exists with a divergent digest; refusing overwrite/);
  assert.match(workflow, /A resumed source tag disappeared; refusing to recreate it without this run's attestation/);
  const attestStep = workflow.indexOf("- name: Sign SLSA provenance");
  const scanStep = workflow.indexOf("- name: Scan the exact registry digest");
  const promoteStep = workflow.indexOf("- name: Promote the attested digest");
  assert.ok(scanStep > 0 && attestStep > scanStep && promoteStep > attestStep);
  for (const permission of ["packages: write", "id-token: write", "attestations: write"]) {
    assert.match(workflow, new RegExp(permission));
  }
  assert.match(workflow, /create-registry-image-inventory\.mjs/);
  assert.match(workflow, /verify-image-provenance\.mjs/);
  assert.match(workflow, /COMPOSE_PARALLEL_LIMIT:\s*2/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
});

test("release policy records external protected-ref and immutable-tag prerequisites", async () => {
  const documentation = await readFile(path.join(repositoryRoot, "releases", "README.md"), "utf8");
  assert.match(documentation, /`github\.ref_protected`/);
  assert.match(documentation, /tags por SHA.*inmutables/i);
  assert.match(documentation, /único writer/i);
  assert.match(documentation, /`cancel-in-progress: false`/);
  assert.match(documentation, /candidate-/i);
  assert.match(documentation, /retención/i);
  assert.match(documentation, /reanud/i);
});

test("provider contract producer is protected, exact, non-cancelable and fail-closed", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "publish-provider-contracts.yml"),
    "utf8"
  );
  const publicationTool = await readFile(
    path.join(repositoryRoot, "scripts", "releases", "npm-artifact-publication.mjs"),
    "utf8"
  );
  for (const contract of [
    "platform-contracts",
    "audit-contracts",
    "nova-contracts",
    "lumen-contracts",
    "pulso-contracts"
  ]) {
    assert.match(workflow, new RegExp(`- ${contract}`));
  }
  assert.match(workflow, /REF_PROTECTED:\s*\$\{\{ github\.ref_protected \}\}/);
  assert.match(workflow, /GITHUB_REF" != "refs\/heads\/main"/);
  assert.match(workflow, /GITHUB_SHA" != "\$SOURCE_REVISION"/);
  assert.match(workflow, /canonical_tag="contracts\/\$CONTRACT\/v\$VERSION"/);
  assert.match(workflow, /git rev-parse "\$canonical_tag\^\{commit\}"/);
  assert.match(workflow, /!\['ready', 'published'\]\.includes\(artifact\.publication\?\.state\)/);
  assert.match(workflow, /provider contract publication is not approved/);
  assert.match(workflow, /provider contract workflow differs from registry catalog/);
  assert.ok(
    workflow.indexOf("provider contract publication is not approved") <
      workflow.indexOf("npm-artifact-publication.mjs pack")
  );
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  for (const operation of ["pack", "preflight", "readback"]) {
    assert.match(workflow, new RegExp(`npm-artifact-publication\\.mjs ${operation}`));
  }
  assert.match(publicationTool, /workspace\|file\|link/);
  assert.match(publicationTool, /must use exact SemVer/);
  assert.match(publicationTool, /localBytes\.equals\(remoteBytes\)/);
  assert.match(publicationTool, /metadata\.gitHead !== options\.sourceRevision/);
  assert.match(publicationTool, /sha512Integrity\(remoteBytes\) !== metadata\.dist\.integrity/);
  assert.match(publicationTool, /MAX_PUBLISHED_NPM_TARBALL_BYTES/);
  assert.match(publicationTool, /"attestation",\s*"verify"/);
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}/);
  assert.match(workflow, /subject-path:\s*\$\{\{ steps\.pack\.outputs\.tarball \}\}/);
  assert.match(workflow, /npm publish "\$TARBALL" --access public --ignore-scripts/);
  assert.match(workflow, /--local-tarball "\$LOCAL_TARBALL"/);
  assert.match(workflow, /--attempts 5/);
  assert.match(publicationTool, /options\.signerWorkflow = artifact\.publication\.workflow/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(workflow, /--force|--overwrite/);
  for (const permission of ["packages: write", "id-token: write", "attestations: write"]) {
    assert.match(workflow, new RegExp(permission));
  }
});

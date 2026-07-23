import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  analyzeExecutionPlan,
  loadExecutionPlanContext,
  renderExecutionPlanStatus,
  validateExecutionGateManifest
} from "./execution-plan.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const validationDate = new Date("2026-07-22T12:00:00.000Z");
const execFileAsync = promisify(execFile);

async function analyze(mutator = () => {}) {
  const context = await loadExecutionPlanContext(repositoryRoot);
  mutator(context);
  return analyzeExecutionPlan(context, { root: repositoryRoot, now: validationDate });
}

async function createGateFixture({ gate = "code" } = {}) {
  const context = await loadExecutionPlanContext(repositoryRoot);
  const item = structuredClone(context.plan.items.find((candidate) => candidate.id === "EXEC-NOVA-003"));
  const product = context.products.items.find((candidate) => candidate.productId === item.productId);
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-execution-gate-"));
  const operationEvidencePath = `docs/evidence/execution-gates/sidecars/${item.id}/${gate}/recovery-receipt.json`;
  const verifierDefinition =
    gate === "operations"
      ? {
          name: "nova-recovery-evidence",
          command: `node scripts/ops/verify-nova-recovery-evidence.mjs --evidence ${operationEvidencePath}`,
          sourcePath: "scripts/ops/verify-nova-recovery-evidence.mjs"
        }
      : {
          name: "nova-core-tests",
          command: "pnpm --filter @hyperion/nova-core-service test",
          sourcePath: "services/nova-core-service/package.json"
        };
  const git = (...args) => execFileAsync("git", ["-C", root, ...args], { windowsHide: true });
  await git("init", "--quiet");
  await git("config", "user.email", "execution-gate-test@hyperion.invalid");
  await git("config", "user.name", "Execution Gate Test");
  await mkdir(path.join(root, path.dirname(verifierDefinition.sourcePath)), { recursive: true });
  await writeFile(
    path.join(root, verifierDefinition.sourcePath),
    await readFile(path.join(repositoryRoot, verifierDefinition.sourcePath))
  );
  await writeFile(path.join(root, "revision-a.txt"), "release A\n", "utf8");
  await git("add", "revision-a.txt", verifierDefinition.sourcePath);
  await git("commit", "--quiet", "-m", "release A");
  const revision = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(root, "revision-b.txt"), "release B\n", "utf8");
  await git("add", "revision-b.txt");
  await git("commit", "--quiet", "-m", "release B");
  const alternateRevision = (await git("rev-parse", "HEAD")).stdout.trim();
  const evidencePath = `docs/evidence/execution-gates/${item.id.toLowerCase()}-${gate}.json`;
  const sidecarPath = `docs/evidence/execution-gates/sidecars/${item.id}/${gate}/verifier-result.json`;
  item.releaseGate.releaseVersion = "1.1.0";
  item.releaseGate.sourceRevision = revision;
  const manifest = {
    schemaVersion: 1,
    itemId: item.id,
    productId: item.productId,
    gate,
    timestamp: "2026-07-22T10:00:00Z",
    revision,
    release: {
      cell: product.cell,
      catalogVersion: item.releaseGate.catalogVersion,
      releaseVersion: "1.1.0",
      sourceRevision: revision
    },
    verifier: {
      name: verifierDefinition.name,
      command: verifierDefinition.command,
      status: "passed",
      resultSidecar: sidecarPath
    },
    sidecars: []
  };
  if (["recovery", "staging", "operations"].includes(gate)) {
    manifest.snapshot = {
      id: "test-environment/snapshot-001",
      capturedAt: "2026-07-22T09:59:00Z"
    };
  }
  const verifierResult = {
    schemaVersion: 1,
    itemId: manifest.itemId,
    productId: manifest.productId,
    gate: manifest.gate,
    timestamp: manifest.timestamp,
    revision: manifest.revision,
    snapshot: manifest.snapshot,
    release: manifest.release,
    verifier: {
      name: manifest.verifier.name,
      command: manifest.verifier.command,
      status: manifest.verifier.status
    }
  };
  const sidecarBytes = Buffer.from(`${JSON.stringify(verifierResult, null, 2)}\n`, "utf8");
  const operationEvidenceBytes = Buffer.from('{"fixture":"recovery-receipt"}\n', "utf8");
  manifest.sidecars = [
    {
      path: sidecarPath,
      sha256: createHash("sha256").update(sidecarBytes).digest("hex")
    },
    ...(gate === "operations"
      ? [
          {
            path: operationEvidencePath,
            sha256: createHash("sha256").update(operationEvidenceBytes).digest("hex")
          }
        ]
      : [])
  ];
  const releaseState = {
    status: "published",
    publishedReleases: [
      { releaseVersion: "1.1.0", sourceRevision: revision, releasedAt: "2026-07-22T09:00:00Z" },
      { releaseVersion: "1.1.1", sourceRevision: alternateRevision, releasedAt: "2026-07-22T09:30:00Z" }
    ]
  };
  await mkdir(path.join(root, path.dirname(sidecarPath)), { recursive: true });
  await writeFile(path.join(root, sidecarPath), sidecarBytes);
  if (gate === "operations") {
    await writeFile(path.join(root, operationEvidencePath), operationEvidenceBytes);
  }
  const writeManifest = () =>
    writeFile(path.join(root, evidencePath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await mkdir(path.join(root, path.dirname(evidencePath)), { recursive: true });
  await writeManifest();
  return {
    context,
    item,
    product,
    releaseState,
    root,
    evidencePath,
    manifest,
    alternateRevision,
    writeManifest,
    dispose: () => rm(root, { recursive: true, force: true })
  };
}

test("universo canónico incluye todos los requisitos documentados sin fijar el total abierto", async () => {
  const context = await loadExecutionPlanContext(repositoryRoot);
  const requirements = [...context.canonical.requirements.values()];
  assert.deepEqual(context.canonical.problems, []);

  const counts = Object.fromEntries(
    ["NOV", "LUM", "PUL"].map((prefix) => {
      const all = requirements.filter((requirement) => requirement.prefix === prefix);
      return [
        prefix,
        {
          total: all.length,
          open: all.filter((requirement) => requirement.state !== "implementado").length
        }
      ];
    })
  );

  assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([prefix, count]) => [prefix, count.total])), {
    NOV: 19,
    LUM: 55,
    PUL: 48
  });
  assert.ok(Object.values(counts).every((count) => count.open > 0 && count.open <= count.total));
});

test("plan vigente cubre exactamente el universo abierto derivado y cinco deudas", async () => {
  const context = await loadExecutionPlanContext(repositoryRoot);
  const expectedOpen = [...context.canonical.requirements.values()].filter(
    (requirement) => requirement.state !== "implementado"
  ).length;
  const result = await analyzeExecutionPlan(context, { root: repositoryRoot, now: validationDate });
  assert.deepEqual(result.problems, []);
  assert.equal(result.summary.openRequirements, expectedOpen);
  assert.equal(result.summary.coveredRequirements, expectedOpen);
  assert.equal(result.summary.openDebts, 5);
  assert.equal(result.summary.coveredDebts, 5);
  assert.equal(result.summary.items, 14);
  assert.equal(result.summary.waves, 5);
});

test("cobertura falla cerrado ante requisitos ausentes o con dos owners", async () => {
  const missing = await analyze((context) => {
    const item = context.plan.items.find((candidate) => candidate.id === "EXEC-NOVA-001");
    item.requirementRefs = item.requirementRefs.filter((expression) => expression !== "NOV-001–NOV-003");
  });
  assert.ok(
    missing.problems.includes(
      "docs/catalogs/execution-plan.v1.json: NOV-001 debe tener exactamente un owner de ejecución (tiene 0)"
    )
  );

  const duplicated = await analyze((context) => {
    const item = context.plan.items.find((candidate) => candidate.id === "EXEC-NOVA-002");
    item.requirementRefs.push("NOV-001");
  });
  assert.ok(duplicated.problems.some((problem) => problem.includes("NOV-001 está asignado a")));
});

test("todas las deudas abiertas tienen un único owner de ejecución", async () => {
  const missing = await analyze((context) => {
    const item = context.plan.items.find((candidate) => candidate.id === "EXEC-PLATFORM-002");
    item.debtRefs = item.debtRefs.filter((id) => id !== "DEBT-023");
  });
  assert.ok(
    missing.problems.includes(
      "docs/catalogs/execution-plan.v1.json: DEBT-023 debe tener exactamente un owner de ejecución (tiene 0)"
    )
  );

  const duplicated = await analyze((context) => {
    const item = context.plan.items.find((candidate) => candidate.id === "EXEC-PULSO-001");
    item.debtRefs.push("DEBT-024");
  });
  assert.ok(duplicated.problems.some((problem) => problem.includes("DEBT-024 está asignada a")));
});

test("DAG rechaza ciclos, dependencias inexistentes y waves posteriores", async () => {
  const result = await analyze((context) => {
    const platform = context.plan.items.find((candidate) => candidate.id === "EXEC-PLATFORM-001");
    const pulso = context.plan.items.find((candidate) => candidate.id === "EXEC-PULSO-005");
    platform.dependsOn.push("EXEC-PULSO-005", "EXEC-NO-EXISTE");
    pulso.dependsOn.push("EXEC-PLATFORM-001");
  });
  assert.ok(result.problems.some((problem) => problem.includes("item inexistente EXEC-NO-EXISTE")));
  assert.ok(result.problems.some((problem) => problem.includes("en una wave posterior")));
  assert.ok(result.problems.some((problem) => problem.includes("ciclo de dependencias")));
});

test("cronología accepted no permite aceptar antes que una dependencia", async () => {
  const result = await analyze((context) => {
    const dependency = context.plan.items.find((candidate) => candidate.id === "EXEC-PLATFORM-001");
    const dependent = context.plan.items.find((candidate) => candidate.id === "EXEC-PLATFORM-002");
    dependency.status = "accepted";
    dependency.acceptedAt = "2026-07-22";
    dependent.status = "accepted";
    dependent.acceptedAt = "2026-07-21";
  });
  assert.ok(
    result.problems.some((problem) =>
      problem.includes("EXEC-PLATFORM-001 fue aceptado después de su dependiente EXEC-PLATFORM-002")
    )
  );
});

test("fechas, producto, gates y propiedades desconocidas se validan semánticamente", async () => {
  const result = await analyze((context) => {
    const nova = context.plan.items.find((candidate) => candidate.id === "EXEC-NOVA-003");
    nova.dueDate = "2026-10-01";
    nova.gateRefs = nova.gateRefs.filter((gate) => gate !== "operations");
    nova.requirementState = "implementado";
    context.plan.reviewDue = "2026-09-01";
  });
  assert.ok(result.problems.some((problem) => problem.includes("supera el vencimiento de NOVA")));
  assert.ok(result.problems.some((problem) => problem.includes("release published requiere gates operations")));
  assert.ok(result.problems.some((problem) => problem.includes("propiedad no soportada requirementState")));
  assert.ok(result.problems.some((problem) => problem.includes("entre 0 y 14 días")));
});

test("issues de ejecución existen en catálogos canónicos y pertenecen al alcance del item", async () => {
  const invented = await analyze((context) => {
    context.plan.items.find((candidate) => candidate.id === "EXEC-NOVA-001").issue = "HYP-EXEC-001";
  });
  assert.ok(invented.problems.some((problem) => problem.includes("HYP-EXEC-001 no existe en products.v1.json")));

  const wrongProduct = await analyze((context) => {
    context.plan.items.find((candidate) => candidate.id === "EXEC-NOVA-001").issue = "HYP-PUL-001";
  });
  assert.ok(wrongProduct.problems.some((problem) => problem.includes("no pertenece a NOVA ni a sus debtRefs")));

  const crossCellDebt = await analyze((context) => {
    const nova = context.plan.items.find((candidate) => candidate.id === "EXEC-NOVA-001");
    const pulso = context.plan.items.find((candidate) => candidate.id === "EXEC-PULSO-001");
    nova.debtRefs = ["DEBT-005"];
    nova.issue = "HYP-DEBT-005";
    pulso.debtRefs = [];
    pulso.issue = "HYP-PUL-001";
  });
  assert.ok(crossCellDebt.problems.some((problem) => problem.includes("DEBT-005 de pulso-data a la cell nova")));
});

test("accepted falla cerrado con dependencias, requisitos, release o evidencia pendientes", async () => {
  const result = await analyze((context) => {
    const item = context.plan.items.find((candidate) => candidate.id === "EXEC-NOVA-003");
    item.status = "accepted";
    item.acceptedAt = "2026-07-22";
  });
  assert.ok(result.problems.some((problem) => problem.includes("requiere release published para nova@1.1.0")));
  assert.ok(result.problems.some((problem) => problem.includes("accepted debe fijar releaseVersion y sourceRevision")));
  assert.ok(result.problems.some((problem) => problem.includes("no puede aceptarse antes de EXEC-NOVA-001")));
  assert.ok(result.problems.some((problem) => problem.includes("accepted carece de evidencia para gate code")));
  assert.ok(result.problems.some((problem) => problem.includes("accepted carece de evidencia para gate operations")));
});

test("evidencia de gates solo admite manifests JSON en el directorio normativo", async () => {
  const result = await analyze((context) => {
    const item = context.plan.items.find((candidate) => candidate.id === "EXEC-LUMEN-003");
    item.gateEvidence = { recovery: ["../secret.json"] };
  });
  assert.ok(result.problems.some((problem) => problem.includes("gateEvidence solo puede declararse al aceptar")));
  assert.ok(
    result.problems.some((problem) => problem.includes("manifest JSON directo en docs/evidence/execution-gates/"))
  );
});

test("manifest de gate liga item, producto, release y verifier passed", async () => {
  const fixture = await createGateFixture();
  try {
    const valid = await validateExecutionGateManifest({
      ...fixture,
      gate: "code",
      now: validationDate
    });
    assert.deepEqual(valid, []);

    fixture.manifest.productId = "PULSO_IRIS";
    fixture.manifest.timestamp = "2026-07-23T10:00:00Z";
    fixture.manifest.revision = "0".repeat(40);
    fixture.manifest.release.catalogVersion = "9.9.9";
    fixture.manifest.verifier.command = "pnpm execution:check";
    fixture.manifest.verifier.status = "failed";
    await fixture.writeManifest();
    const invalid = await validateExecutionGateManifest({
      ...fixture,
      gate: "code",
      now: validationDate
    });
    assert.ok(invalid.some((problem) => problem.includes(".productId debe ser NOVA")));
    assert.ok(invalid.some((problem) => problem.includes(".timestamp no puede estar en el futuro")));
    assert.ok(invalid.some((problem) => problem.includes("commit Git SHA-1/SHA-256 completo")));
    assert.ok(invalid.some((problem) => problem.includes(".release.catalogVersion debe ser 1.1.0")));
    assert.ok(invalid.some((problem) => problem.includes(".revision debe coincidir con release.sourceRevision")));
    assert.ok(invalid.some((problem) => problem.includes("no pertenece a la allowlist leaf")));
    assert.ok(invalid.some((problem) => problem.includes(".verifier.status debe ser passed")));

    fixture.manifest.timestamp = "2026-02-31T10:00:00Z";
    await fixture.writeManifest();
    const invalidCalendarDate = await validateExecutionGateManifest({
      ...fixture,
      gate: "code",
      now: validationDate
    });
    assert.ok(invalidCalendarDate.some((problem) => problem.includes(".timestamp debe usar RFC 3339 UTC")));
  } finally {
    await fixture.dispose();
  }
});

test("allowlist leaf rechaza comandos agregados check, docs y release", async () => {
  const fixture = await createGateFixture();
  try {
    for (const command of ["pnpm check", "pnpm docs:check", "pnpm release:check"]) {
      fixture.manifest.verifier.command = command;
      await fixture.writeManifest();
      const invalid = await validateExecutionGateManifest({
        ...fixture,
        gate: "code",
        now: validationDate
      });
      assert.ok(
        invalid.some((problem) => problem.includes("no pertenece a la allowlist leaf")),
        `${command} no debe acreditar un gate`
      );
    }
  } finally {
    await fixture.dispose();
  }
});

test("manifest operacional exige snapshot y recalcula SHA-256 de sidecars", async () => {
  const fixture = await createGateFixture({ gate: "operations" });
  try {
    const valid = await validateExecutionGateManifest({
      ...fixture,
      gate: "operations",
      now: validationDate
    });
    assert.deepEqual(valid, []);

    delete fixture.manifest.snapshot;
    fixture.manifest.sidecars[0].sha256 = "b".repeat(64);
    await fixture.writeManifest();
    const invalid = await validateExecutionGateManifest({
      ...fixture,
      gate: "operations",
      now: validationDate
    });
    assert.ok(invalid.some((problem) => problem.includes("operations requiere snapshot")));
    assert.ok(invalid.some((problem) => problem.includes("no coincide con los bytes")));
  } finally {
    await fixture.dispose();
  }
});

test("releaseGate aceptado impide combinar evidencia de releases publicados distintos", async () => {
  const fixture = await createGateFixture({ gate: "operations" });
  try {
    fixture.manifest.revision = fixture.alternateRevision;
    fixture.manifest.release.releaseVersion = "1.1.1";
    fixture.manifest.release.sourceRevision = fixture.alternateRevision;
    await fixture.writeManifest();
    const invalid = await validateExecutionGateManifest({
      ...fixture,
      gate: "operations",
      now: validationDate
    });
    assert.ok(
      invalid.some((problem) => problem.includes("releaseVersion debe coincidir con releaseGate.releaseVersion"))
    );
    assert.ok(
      invalid.some((problem) => problem.includes("sourceRevision debe coincidir con releaseGate.sourceRevision"))
    );
  } finally {
    await fixture.dispose();
  }
});

test("revision debe existir en Git y release no puede ser posterior a acceptedAt", async () => {
  const fixture = await createGateFixture();
  try {
    const nonexistentRevision = "f".repeat(40);
    fixture.item.releaseGate.sourceRevision = nonexistentRevision;
    fixture.item.status = "accepted";
    fixture.item.acceptedAt = "2026-07-21";
    fixture.manifest.revision = nonexistentRevision;
    fixture.manifest.release.sourceRevision = nonexistentRevision;
    fixture.releaseState.publishedReleases = [
      {
        releaseVersion: "1.1.0",
        sourceRevision: nonexistentRevision,
        releasedAt: "2026-07-22T09:00:00Z"
      }
    ];
    await fixture.writeManifest();
    const invalid = await validateExecutionGateManifest({
      ...fixture,
      gate: "code",
      now: validationDate
    });
    assert.ok(invalid.some((problem) => problem.includes("no identifica un commit existente")));
    assert.ok(invalid.some((problem) => problem.includes("release fue publicado después de acceptedAt")));
  } finally {
    await fixture.dispose();
  }
});

test("manifest rechaza symlinks o junctions en cualquier componente del sidecar", async (t) => {
  const fixture = await createGateFixture();
  try {
    const sidecarDirectory = path.dirname(path.join(fixture.root, fixture.manifest.sidecars[0].path));
    const relocatedDirectory = path.join(fixture.root, "relocated-sidecar");
    await rename(sidecarDirectory, relocatedDirectory);
    try {
      await symlink(relocatedDirectory, sidecarDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("el host no permite crear symlinks/junctions para esta prueba");
        return;
      }
      throw error;
    }
    const invalid = await validateExecutionGateManifest({
      ...fixture,
      gate: "code",
      now: validationDate
    });
    assert.ok(invalid.some((problem) => problem.includes("enlace simbólico o junction")));
  } finally {
    await fixture.dispose();
  }
});

test("status es determinista y revela releases draft sin declararlos listos", async () => {
  const result = await analyze();
  const status = renderExecutionPlanStatus(result);
  assert.match(
    status,
    new RegExp(
      `Coverage: requirements ${result.summary.openRequirements}/${result.summary.openRequirements} \\| debts 5/5 \\| items 14 \\| waves 5`
    )
  );
  for (const product of result.summary.products) {
    assert.match(status, new RegExp(`${product.productId}: ${product.open}/${product.open} open requirements`));
  }
  assert.match(status, /release=nova@1\.1\.0:draft/);
  assert.doesNotMatch(status, /release=nova@1\.1\.0:published/);
});

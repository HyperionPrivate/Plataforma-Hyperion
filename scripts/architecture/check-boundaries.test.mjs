import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareWithBaseline,
  detectBoundaryViolations,
  extractMigrationStructure,
  extractSqlAccesses
} from "./check-boundaries.mjs";

test("extractSqlAccesses clasifica lecturas y escrituras solo dentro de strings", () => {
  const source = `
    // from foreign.records no debe contar
    const read = db.query(\`select * from foreign.records r join own.items i on true\`);
    const write = db.query("insert into foreign.records (id) values ($1)");
    const update = db.query(\`update own.items set value = \${value}\`);
  `;

  assert.deepEqual(extractSqlAccesses(source), [
    { access: "read", object: "foreign.records", objectType: "table" },
    { access: "read", object: "own.items", objectType: "table" },
    { access: "write", object: "foreign.records", objectType: "table" },
    { access: "write", object: "own.items", objectType: "table" }
  ]);
});

test("extractSqlAccesses diferencia una funcion que retorna filas", () => {
  assert.deepEqual(extractSqlAccesses('db.query("select * from own.claim_next_job($1)")'), [
    { access: "read", object: "own.claim_next_job", objectType: "routine" }
  ]);
});

test("extractMigrationStructure encuentra FKs en CREATE y ALTER TABLE", () => {
  const structure = extractMigrationStructure(`
    create table own.items (
      id uuid primary key,
      foreign_id uuid references foreign.records(id)
    );
    alter table own.items add constraint another_fk
      foreign key (foreign_id) references foreign.more_records(id);
  `);

  assert.deepEqual(structure.declarations, ["own.items"]);
  assert.deepEqual(structure.foreignKeys, [
    { constraintName: "items_foreign_id_fkey", source: "own.items", target: "foreign.records" },
    { constraintName: "another_fk", source: "own.items", target: "foreign.more_records" }
  ]);
  assert.deepEqual(
    structure.foreignKeyEvents.map(({ position: _position, ...event }) => event),
    [
      {
        constraintName: "items_foreign_id_fkey",
        source: "own.items",
        target: "foreign.records",
        type: "add"
      },
      {
        constraintName: "another_fk",
        source: "own.items",
        target: "foreign.more_records",
        type: "add"
      }
    ]
  );
  assert.deepEqual(structure.routines, []);
});

function migrationOnlyConfig() {
  return {
    managedSchemas: ["own", "foreign"],
    pathOwners: [],
    scan: { sourceRoots: [], migrationRoot: "migrations", excludePathContains: [] },
    routines: {},
    tables: {
      "foreign.more_records": "beta",
      "foreign.records": "beta",
      "own.items": "alpha",
      "own.other_items": "alpha"
    }
  };
}

async function detectMigrationFixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), "hyperion-boundaries-"));
  try {
    await mkdir(path.join(root, "migrations"), { recursive: true });
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(path.join(root, "migrations", name), sql, "utf8");
    }
    return await detectBoundaryViolations(root, migrationOnlyConfig());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("una FK nombrada deja de ser deuda activa despues de DROP CONSTRAINT", async () => {
  const result = await detectMigrationFixture({
    "001-create.sql": `
      create table own.items (
        id uuid primary key,
        record_id uuid,
        constraint items_record_fk foreign key (record_id) references foreign.records(id)
      );
    `,
    "002-drop.sql": "alter table own.items drop constraint if exists items_record_fk;"
  });

  assert.deepEqual(result.structuralErrors, []);
  assert.deepEqual(result.violations, []);
});

test("DROP CONSTRAINT en otra tabla no oculta la FK activa", async () => {
  const result = await detectMigrationFixture({
    "001-create.sql": `
      create table own.items (
        id uuid primary key,
        record_id uuid constraint items_record_fk references foreign.records(id)
      );
    `,
    "002-wrong-table.sql": "alter table own.other_items drop constraint if exists items_record_fk;"
  });

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].path, "migrations/001-create.sql");
  assert.equal(result.violations[0].targetTable, "foreign.records");
});

test("volver a agregar una FK nombrada restaura la deuda y conserva la nueva declaracion", async () => {
  const result = await detectMigrationFixture({
    "001-create.sql": `
      create table own.items (
        id uuid primary key,
        record_id uuid constraint items_record_fk references foreign.records(id)
      );
    `,
    "002-drop.sql": "alter table own.items drop constraint items_record_fk;",
    "003-re-add.sql": `
      alter table own.items add constraint items_record_fk
        foreign key (record_id) references foreign.more_records(id);
    `
  });

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].path, "migrations/003-re-add.sql");
  assert.equal(result.violations[0].targetTable, "foreign.more_records");
});

test("DROP CONSTRAINT no puede ocultar una FK declarada sin nombre", async () => {
  const result = await detectMigrationFixture({
    "001-create.sql": `
      create table own.items (
        id uuid primary key,
        record_id uuid references foreign.records(id)
      );
    `,
    "002-drop.sql": "alter table own.items drop constraint if exists items_record_fk;"
  });

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].path, "migrations/001-create.sql");
});

test("una FK inline usa el nombre automatico de PostgreSQL y puede retirarse despues", async () => {
  const result = await detectMigrationFixture({
    "001-create.sql": `
      create table own.items (
        id uuid primary key,
        record_id uuid references foreign.records(id)
      );
    `,
    "002-drop.sql": "alter table own.items drop constraint if exists items_record_id_fkey;"
  });

  assert.deepEqual(result.structuralErrors, []);
  assert.deepEqual(result.violations, []);
});

test("una FK de tabla sin nombre infiere todas sus columnas", async () => {
  const structure = extractMigrationStructure(`
    create table own.items (
      tenant_id uuid,
      record_id uuid,
      foreign key (tenant_id, record_id) references foreign.records(tenant_id, id)
    );
  `);

  assert.equal(structure.foreignKeys[0]?.constraintName, "items_tenant_id_record_id_fkey");
});

test("no infiere nombres truncados que podrian ocultar una FK diferente", async () => {
  const structure = extractMigrationStructure(`
    create table own.this_table_name_is_intentionally_long_enough_for_the_test (
      this_column_name_is_also_intentionally_long uuid references foreign.records(id)
    );
  `);

  assert.equal(structure.foreignKeys[0]?.constraintName, null);
});

test("detectBoundaryViolations distingue acceso propio, SQL cruzado y FK cruzada", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hyperion-boundaries-"));
  try {
    await mkdir(path.join(root, "services", "alpha", "src"), { recursive: true });
    await mkdir(path.join(root, "migrations"), { recursive: true });
    await writeFile(
      path.join(root, "services", "alpha", "src", "app.ts"),
      'db.query("select * from own.items join foreign.records on true");',
      "utf8"
    );
    await writeFile(
      path.join(root, "migrations", "001.sql"),
      "create table own.items (id uuid, record_id uuid references foreign.records(id));",
      "utf8"
    );
    const config = {
      managedSchemas: ["own", "foreign"],
      pathOwners: [{ prefix: "services/alpha/", owner: "alpha" }],
      scan: {
        sourceRoots: ["services"],
        migrationRoot: "migrations",
        excludePathContains: [".test."]
      },
      routines: {},
      tables: { "foreign.records": "beta", "own.items": "alpha" }
    };

    const result = await detectBoundaryViolations(root, config);
    assert.deepEqual(result.structuralErrors, []);
    assert.equal(result.violations.length, 2);
    assert.deepEqual(
      result.violations.map((entry) => [entry.kind, entry.count]),
      [
        ["cross-owner-fk", 1],
        ["sql-access", 1]
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectBoundaryViolations rechaza tablas administradas sin propietario", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hyperion-boundaries-"));
  try {
    await mkdir(path.join(root, "services", "alpha", "src"), { recursive: true });
    await mkdir(path.join(root, "migrations"), { recursive: true });
    await writeFile(path.join(root, "services", "alpha", "src", "app.ts"), 'db.query("select * from own.unknown");');
    await writeFile(path.join(root, "migrations", "001.sql"), "create table own.unknown (id uuid);");
    const result = await detectBoundaryViolations(root, {
      managedSchemas: ["own"],
      pathOwners: [{ prefix: "services/alpha/", owner: "alpha" }],
      scan: { sourceRoots: ["services"], migrationRoot: "migrations", excludePathContains: [] },
      routines: {},
      tables: {}
    });

    assert.equal(result.structuralErrors.length, 2);
    assert.match(result.structuralErrors.join("\n"), /sin propietario/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compareWithBaseline falla ante deuda nueva, aumentada o ya retirada", () => {
  const baseline = {
    violations: [
      { id: "same", count: 2 },
      { id: "increased", count: 1 },
      { id: "removed", count: 1 }
    ]
  };
  const result = compareWithBaseline(
    [
      { id: "same", count: 2 },
      { id: "increased", count: 2 },
      { id: "new", count: 1 }
    ],
    baseline
  );

  assert.deepEqual(
    result.unexpected.map((entry) => entry.id),
    ["new"]
  );
  assert.deepEqual(
    result.increased.map(({ actual }) => actual.id),
    ["increased"]
  );
  assert.deepEqual(
    result.stale.map(({ baseline: entry }) => entry.id),
    ["removed"]
  );
});

test("negative fixtures: PL/pgSQL cross-owner and packages SQL fail the scanner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hyperion-boundaries-neg-"));
  try {
    await mkdir(path.join(root, "migrations"), { recursive: true });
    await mkdir(path.join(root, "packages", "leaky"), { recursive: true });
    await writeFile(
      path.join(root, "migrations", "001-negative.sql"),
      await readFile(path.join("scripts", "architecture", "fixtures", "negative-plpgsql-cross-owner.sql"), "utf8"),
      "utf8"
    );
    await writeFile(
      path.join(root, "packages", "leaky", "query.ts"),
      await readFile(path.join("scripts", "architecture", "fixtures", "negative-packages-sql-access.ts"), "utf8"),
      "utf8"
    );

    const result = await detectBoundaryViolations(root, {
      managedSchemas: ["alpha", "beta", "foreign"],
      pathOwners: [{ prefix: "packages/", owner: "shared-packages" }],
      temporaryExceptions: [],
      scan: { sourceRoots: ["packages"], migrationRoot: "migrations", excludePathContains: [] },
      routines: { "alpha.leaky_reader": "alpha-owner" },
      tables: {
        "alpha.own_items": "alpha-owner",
        "beta.foreign_records": "beta-owner",
        "foreign.records": "beta-owner"
      }
    });

    assert.ok(
      result.violations.some((entry) => entry.kind === "plpgsql-sql-access" && entry.object === "beta.foreign_records"),
      "expected PL/pgSQL cross-owner violation"
    );
    assert.ok(
      result.violations.some(
        (entry) => entry.kind === "security-definer-cross-owner" && entry.routine === "alpha.leaky_reader"
      ),
      "expected SECURITY DEFINER cross-owner violation"
    );
    assert.ok(
      result.violations.some(
        (entry) =>
          entry.kind === "sql-access" && entry.path === "packages/leaky/query.ts" && entry.object === "foreign.records"
      ),
      "expected packages SQL access violation"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

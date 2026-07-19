import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareWithBaseline,
  detectBoundaryViolations,
  extractMigrationStructure,
  extractSqlAccesses,
  makeBaselineFromDetection,
  resolveMigrationScopes,
  validateTemporaryExceptions
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

async function detectEffectiveMigrationFixture(files, effectiveOverlayFiles = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "hyperion-boundaries-effective-"));
  try {
    await mkdir(path.join(root, "migrations"), { recursive: true });
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(path.join(root, "migrations", name), sql, "utf8");
    }
    const overlayRoot = path.join(root, "packages", "platform-migrations", "sql");
    await mkdir(overlayRoot, { recursive: true });
    for (const [name, sql] of Object.entries(effectiveOverlayFiles)) {
      await writeFile(path.join(overlayRoot, name), sql, "utf8");
    }
    const config = migrationOnlyConfig();
    config.scan.migrationStateMode = "effective";
    config.routines = {
      "foreign.sync_records": "beta",
      "own.read_records": "alpha",
      "own.sync_items": "alpha"
    };
    return await detectBoundaryViolations(root, config);
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

test("el modo efectivo ignora el cuerpo historico de una rutina reemplazada", async () => {
  const result = await detectEffectiveMigrationFixture({
    "001-cross-owner.sql": `
      create function own.read_records() returns setof foreign.records
      language plpgsql security definer as $$
      begin
        return query select * from foreign.records;
      end
      $$;
    `,
    "002-replace.sql": `
      create or replace function own.read_records() returns setof own.items
      language plpgsql as $$
      begin
        return query select * from own.items;
      end
      $$;
    `
  });

  assert.deepEqual(result.structuralErrors, []);
  assert.deepEqual(result.violations, []);
});

test("el modo efectivo retira una rutina eliminada por una migracion posterior", async () => {
  const result = await detectEffectiveMigrationFixture({
    "001-cross-owner.sql": `
      create function own.read_records() returns setof foreign.records
      language plpgsql as $$
      begin
        return query select * from foreign.records;
      end
      $$;
    `,
    "002-drop.sql": "drop function if exists own.read_records();"
  });

  assert.deepEqual(result.structuralErrors, []);
  assert.deepEqual(result.violations, []);
});

test("migrationScopes descubre todos los migradores y falla cerrado si aparece uno sin registrar", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hyperion-migration-scopes-"));
  try {
    for (const packageName of ["migrations", "alpha-migrations"]) {
      const packageRoot = path.join(root, "packages", packageName);
      await mkdir(path.join(packageRoot, "sql"), { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: `@test/${packageName}`, scripts: { migrate: "node dist/index.js" } }),
        "utf8"
      );
      await writeFile(path.join(packageRoot, "sql", "001.sql"), "select 1;\n", "utf8");
    }
    const scan = {
      migrationRoot: "packages/migrations/sql",
      migrationStateMode: "effective",
      migrationPackagesRoot: "packages",
      migrationScopes: [
        { id: "legacy", roots: ["packages/migrations/sql"] },
        { id: "alpha", roots: ["packages/alpha-migrations/sql"] }
      ]
    };
    assert.deepEqual(await resolveMigrationScopes(root, scan), {
      errors: [],
      scopes: [
        { id: "legacy", roots: ["packages/migrations/sql"] },
        { id: "alpha", roots: ["packages/alpha-migrations/sql"] }
      ]
    });

    const unregisteredRoot = path.join(root, "packages", "beta-migrations");
    await mkdir(path.join(unregisteredRoot, "sql"), { recursive: true });
    await writeFile(
      path.join(unregisteredRoot, "package.json"),
      JSON.stringify({ name: "@test/beta-migrations", scripts: { migrate: "node dist/index.js" } }),
      "utf8"
    );
    await writeFile(path.join(unregisteredRoot, "sql", "001.sql"), "select 1;\n", "utf8");
    const result = await resolveMigrationScopes(root, scan);
    assert.deepEqual(result.errors, [
      "Migrador descubierto no registrado en migrationScopes: packages/beta-migrations/sql"
    ]);

    const packageLessRoot = path.join(root, "packages", "gamma-migrations");
    await mkdir(path.join(packageLessRoot, "sql"), { recursive: true });
    await writeFile(path.join(packageLessRoot, "sql", "001.sql"), "select 1;\n", "utf8");
    const packageLessResult = await resolveMigrationScopes(root, scan);
    assert.match(packageLessResult.errors.join("\n"), /packages\/gamma-migrations\/package\.json falta/);
    assert.match(
      packageLessResult.errors.join("\n"),
      /Migrador descubierto no registrado en migrationScopes: packages\/gamma-migrations\/sql/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("un scope independiente no puede mezclar raíces provider-owned que oculten deuda entre sí", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hyperion-mixed-migration-scope-"));
  try {
    for (const packageName of ["alpha-migrations", "beta-migrations"]) {
      const packageRoot = path.join(root, "packages", packageName);
      await mkdir(path.join(packageRoot, "sql"), { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: `@test/${packageName}`, scripts: { migrate: "node dist/index.js" } }),
        "utf8"
      );
      await writeFile(path.join(packageRoot, "sql", "001.sql"), "select 1;\n", "utf8");
    }
    const result = await resolveMigrationScopes(root, {
      migrationRoot: "packages/alpha-migrations/sql",
      migrationStateMode: "effective",
      migrationPackagesRoot: "packages",
      migrationScopes: [
        {
          id: "mixed",
          roots: ["packages/alpha-migrations/sql", "packages/beta-migrations/sql"]
        }
      ]
    });
    assert.match(result.errors.join("\n"), /no puede mezclar migradores provider-owned independientes/);
    const untrackedOverlay = await resolveMigrationScopes(root, {
      migrationRoot: "packages/alpha-migrations/sql",
      migrationStateMode: "effective",
      migrationPackagesRoot: "packages",
      migrationScopes: [
        {
          id: "legacy-overlay",
          mode: "legacy-overlay",
          roots: ["packages/alpha-migrations/sql", "packages/beta-migrations/sql"]
        }
      ]
    });
    assert.match(untrackedOverlay.errors.join("\n"), /legacy-overlay no declara owner/);
    assert.match(untrackedOverlay.errors.join("\n"), /legacy-overlay no declara issue válido/);
    assert.match(untrackedOverlay.errors.join("\n"), /legacy-overlay no declara expiresAt vigente/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("los estados efectivos de migradores provider-owned son independientes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hyperion-independent-migrations-"));
  try {
    const packages = {
      "alpha-migrations": `
        create table own.items (
          id uuid primary key,
          record_id uuid constraint items_record_fk references foreign.records(id)
        );
      `,
      "beta-migrations": "alter table own.items drop constraint if exists items_record_fk;"
    };
    for (const [packageName, sql] of Object.entries(packages)) {
      const packageRoot = path.join(root, "packages", packageName);
      await mkdir(path.join(packageRoot, "sql"), { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: `@test/${packageName}`, scripts: { migrate: "node dist/index.js" } }),
        "utf8"
      );
      await writeFile(path.join(packageRoot, "sql", "001.sql"), sql, "utf8");
    }
    const config = migrationOnlyConfig();
    config.scan = {
      sourceRoots: [],
      migrationRoot: "packages/alpha-migrations/sql",
      migrationStateMode: "effective",
      migrationPackagesRoot: "packages",
      migrationScopes: [
        { id: "alpha", roots: ["packages/alpha-migrations/sql"] },
        { id: "beta", roots: ["packages/beta-migrations/sql"] }
      ],
      excludePathContains: []
    };
    const result = await detectBoundaryViolations(root, config);
    assert.deepEqual(result.structuralErrors, []);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].path, "packages/alpha-migrations/sql/001.sql");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("la generación de baseline rechaza errores estructurales", () => {
  assert.throws(
    () => makeBaselineFromDetection({ structuralErrors: ["migrador no registrado"], violations: [] }),
    /No se puede generar baseline con errores estructurales/
  );
});

test("el modo efectivo atribuye una rutina activa a su ultima definicion", async () => {
  const result = await detectEffectiveMigrationFixture({
    "001-own.sql": `
      create function own.read_records() returns setof own.items
      language plpgsql as $$
      begin
        return query select * from own.items;
      end
      $$;
    `,
    "002-cross-owner.sql": `
      create or replace function own.read_records() returns setof foreign.records
      language plpgsql as $$
      begin
        return query select * from foreign.records;
      end
      $$;
    `
  });

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].path, "migrations/002-cross-owner.sql");
  assert.equal(result.violations[0].object, "foreign.records");
});

test("detecta un trigger efectivo cuya tabla y rutina tienen owners distintos", async () => {
  const result = await detectEffectiveMigrationFixture({
    "001-cross-owner-trigger.sql": `
      create trigger sync_items
      after insert on own.items
      for each row execute function foreign.sync_records();
    `
  });

  assert.deepEqual(result.structuralErrors, []);
  assert.deepEqual(
    result.violations.map((entry) => ({
      kind: entry.kind,
      path: entry.path,
      sourceOwner: entry.sourceOwner,
      sourceTable: entry.sourceTable,
      targetOwner: entry.targetOwner,
      targetRoutine: entry.targetRoutine,
      trigger: entry.trigger
    })),
    [
      {
        kind: "cross-owner-trigger",
        path: "migrations/001-cross-owner-trigger.sql",
        sourceOwner: "alpha",
        sourceTable: "own.items",
        targetOwner: "beta",
        targetRoutine: "foreign.sync_records",
        trigger: "sync_items"
      }
    ]
  );
});

test("no reporta un trigger efectivo cuando tabla y rutina comparten owner", async () => {
  const result = await detectEffectiveMigrationFixture({
    "001-same-owner-trigger.sql": `
      create trigger sync_items
      after insert on own.items
      for each row execute function own.sync_items();
    `
  });

  assert.deepEqual(result.structuralErrors, []);
  assert.deepEqual(result.violations, []);
});

test("DROP TRIGGER retira una dependencia cross-owner historica", async () => {
  const result = await detectEffectiveMigrationFixture({
    "001-cross-owner-trigger.sql": `
      create trigger sync_items
      after insert on own.items
      for each row execute function foreign.sync_records();
    `,
    "002-drop-trigger.sql": "drop trigger if exists sync_items on own.items;"
  });

  assert.deepEqual(result.structuralErrors, []);
  assert.deepEqual(result.violations, []);
});

test("una migracion provider-owned posterior retira el trigger global efectivo", async () => {
  const result = await detectEffectiveMigrationFixture(
    {
      "001-cross-owner-trigger.sql": `
        create trigger sync_items
        after insert on own.items
        for each row execute function foreign.sync_records();
      `
    },
    {
      "001-remove-cross-owner-trigger.sql": "drop trigger if exists sync_items on own.items;"
    }
  );

  assert.deepEqual(result.structuralErrors, []);
  assert.deepEqual(result.violations, []);
});

test("DROP TRIGGER sobre otra tabla no oculta la dependencia activa", async () => {
  const result = await detectEffectiveMigrationFixture({
    "001-cross-owner-trigger.sql": `
      create trigger sync_items
      after insert on own.items
      for each row execute function foreign.sync_records();
    `,
    "002-wrong-table-drop.sql": "drop trigger if exists sync_items on own.other_items;"
  });

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].kind, "cross-owner-trigger");
  assert.equal(result.violations[0].path, "migrations/001-cross-owner-trigger.sql");
  assert.equal(result.violations[0].sourceTable, "own.items");
});

test("recrear un trigger conserva solamente su ultima dependencia efectiva", async () => {
  const result = await detectEffectiveMigrationFixture({
    "001-cross-owner-trigger.sql": `
      create trigger sync_items
      after insert on own.items
      for each row execute function foreign.sync_records();
    `,
    "002-recreate-trigger.sql": `
      drop trigger sync_items on own.items;
      create trigger sync_items
      before update on own.items
      for each row execute procedure own.sync_items();
    `
  });

  assert.deepEqual(result.structuralErrors, []);
  assert.deepEqual(result.violations, []);
});

test("CREATE OR REPLACE TRIGGER atribuye el hallazgo a la definicion efectiva", async () => {
  const result = await detectEffectiveMigrationFixture({
    "001-same-owner-trigger.sql": `
      create trigger sync_items
      after insert on own.items
      for each row execute function own.sync_items();
    `,
    "002-replace-trigger.sql": `
      create or replace trigger sync_items
      after update on own.items
      for each row execute function foreign.sync_records();
    `
  });

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].kind, "cross-owner-trigger");
  assert.equal(result.violations[0].path, "migrations/002-replace-trigger.sql");
  assert.equal(result.violations[0].targetRoutine, "foreign.sync_records");
});

test("las excepciones temporales requieren trazabilidad vigente", () => {
  const result = validateTemporaryExceptions(
    [
      {
        id: "valid",
        owner: "platform-core",
        issue: "HYP-DEBT-100",
        justification: "Compatibility window with an explicit removal plan.",
        expiresAt: "2026-07-17"
      },
      {
        id: "expired",
        owner: "platform-core",
        issue: "HYP-DEBT-101",
        justification: "Compatibility window that should already be closed.",
        expiresAt: "2026-07-16"
      },
      { id: "incomplete", owner: "", issue: "todo", justification: "short", expiresAt: "never" }
    ],
    "2026-07-17"
  );

  assert.deepEqual([...result.activeIds], ["valid"]);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors.join("\n"), /expired on 2026-07-16/);
  assert.match(result.errors.join("\n"), /requires non-empty id\/owner/);
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

test("NOVA provider migrations belong to nova-core instead of the global migration bypass", async () => {
  const ownership = JSON.parse(await readFile(path.resolve("docs/architecture/data-ownership.json"), "utf8"));
  const services = JSON.parse(await readFile(path.resolve("docs/catalogs/services.v1.json"), "utf8"));

  assert.deepEqual(
    ownership.pathOwners.find((entry) => entry.prefix === "packages/nova-migrations/"),
    { prefix: "packages/nova-migrations/", owner: "nova-core" }
  );
  assert.equal(ownership.tables["nova.migration_ledger"], "nova-core");
  assert.equal(services.items.find((service) => service.id === "nova-migrations")?.owner, "nova-core");
});

test("Access fresh-start migrations are owned by the neutral platform cell", async () => {
  const ownership = JSON.parse(await readFile(path.resolve("docs/architecture/data-ownership.json"), "utf8"));
  const services = JSON.parse(await readFile(path.resolve("docs/catalogs/services.v1.json"), "utf8"));

  assert.deepEqual(
    ownership.pathOwners.find((entry) => entry.prefix === "packages/access-migrations/"),
    { prefix: "packages/access-migrations/", owner: "access" }
  );
  assert.equal(ownership.tables["access_runtime.migration_ledger"], "access");
  assert.equal(services.items.find((service) => service.id === "access-migrations")?.owner, "platform-access");
});

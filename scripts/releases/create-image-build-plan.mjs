#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CELL_COMPOSE_SERVICES, assertCell } from "../architecture/cell-policy.mjs";
import { loadCatalog } from "./generate-release-manifest.mjs";
import { buildServiceForComponent, composeServicesForComponent } from "./release-model.mjs";

export async function createImageBuildPlan(root, cell, catalogVersion) {
  assertCell(cell);
  const catalog = await loadCatalog(root, cell, catalogVersion);
  const components = catalog.components
    .filter((component) => component.distribution === "oci")
    .map((component) => ({
      id: component.id,
      service: buildServiceForComponent(component),
      composeServices: composeServicesForComponent(component),
      repository: component.imageRepository
    }));
  const plannedComposeServices = components.flatMap((component) => component.composeServices).sort();
  const composeServices = [...CELL_COMPOSE_SERVICES[cell]].sort();
  if (JSON.stringify(plannedComposeServices) !== JSON.stringify(composeServices)) {
    const missingFromCompose = plannedComposeServices.filter((id) => !composeServices.includes(id));
    const missingFromCatalog = composeServices.filter((id) => !plannedComposeServices.includes(id));
    throw new Error(
      `Release catalog and ${cell} Compose allowlist differ` +
        `; missing from Compose: ${missingFromCompose.join(", ") || "none"}` +
        `; missing from catalog: ${missingFromCatalog.join(", ") || "none"}`
    );
  }
  return {
    schemaVersion: 1,
    cell,
    catalogVersion: catalog.catalogVersion,
    components
  };
}

function parseArguments(argv) {
  const options = { format: "json" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cell") options.cell = argv[++index];
    else if (argument === "--catalog-version") options.catalogVersion = argv[++index];
    else if (argument === "--format") options.format = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.cell || !options.catalogVersion) throw new Error("--cell and --catalog-version are required");
  if (!new Set(["json", "matrix"]).has(options.format)) throw new Error("--format must be json or matrix");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = await createImageBuildPlan(process.cwd(), options.cell, options.catalogVersion);
  const output = options.format === "matrix" ? { include: plan.components } : plan;
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

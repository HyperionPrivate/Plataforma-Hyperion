#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./generate-release-manifest.mjs";

const SOURCE_REVISION = /^(?!0{40}$)[a-f0-9]{40}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;

export async function createRegistryImageInventory(options, root = process.cwd(), execute = executeCommand) {
  for (const name of ["cell", "catalogVersion", "sourceRevision", "output"]) {
    if (typeof options[name] !== "string" || !options[name]) throw new Error(`--${toKebab(name)} is required`);
  }
  if (!SOURCE_REVISION.test(options.sourceRevision)) {
    throw new Error("--source-revision must be a non-zero lowercase 40-character Git SHA");
  }
  const catalog = await loadCatalog(root, options.cell, options.catalogVersion);
  const images = {};
  for (const component of catalog.components.filter((entry) => entry.distribution === "oci")) {
    const tag = `${component.imageRepository}:${options.sourceRevision}`;
    const inspection = execute("docker", ["buildx", "imagetools", "inspect", tag]);
    assertCommand(inspection, `registry digest resolution for ${component.id}`);
    const digest = parseTopLevelDigest(inspection.stdout, component.id);
    images[component.id] = `${component.imageRepository}@${digest}`;
  }

  const inventory = {
    schemaVersion: 1,
    cell: options.cell,
    catalogVersion: catalog.catalogVersion,
    sourceRevision: options.sourceRevision,
    images
  };
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, {
    flag: options.force ? "w" : "wx",
    mode: 0o600
  });
  return inventory;
}

function parseTopLevelDigest(output, componentId) {
  const matches = [...String(output).matchAll(/^Digest:\s+(sha256:[a-f0-9]{64})\s*$/gm)].map((match) => match[1]);
  if (matches.length !== 1 || !OCI_DIGEST.test(matches[0])) {
    throw new Error(`registry inspection for ${componentId} must expose exactly one top-level SHA-256 digest`);
  }
  return matches[0];
}

function executeCommand(command, arguments_) {
  return spawnSync(command, arguments_, { encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
}

function assertCommand(result, label) {
  if (result.error) throw new Error(`${label} could not execute: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0)
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
}

function toKebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function parseArguments(argv) {
  const options = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cell") options.cell = argv[++index];
    else if (argument === "--catalog-version") options.catalogVersion = argv[++index];
    else if (argument === "--source-revision") options.sourceRevision = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--force") options.force = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const result = await createRegistryImageInventory(parseArguments(process.argv.slice(2)));
  process.stdout.write(`RESOLVED_REGISTRY_CELL=${result.cell}\n`);
  process.stdout.write(`RESOLVED_REGISTRY_IMAGE_COUNT=${Object.keys(result.images).length}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

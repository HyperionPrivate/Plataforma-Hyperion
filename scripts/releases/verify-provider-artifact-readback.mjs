#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifyPublishedNpmArtifactWithRetry } from "./npm-artifact-publication.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const defaultCatalogPath = path.join(repositoryRoot, "releases", "registry", "provider-artifacts.v1.json");
const EVIDENCE_FIELDS = [
  "schemaVersion",
  "verifier",
  "packageName",
  "version",
  "sourceRepository",
  "sourceRevision",
  "signerWorkflow",
  "registryOrigin",
  "registryTarball",
  "integrity",
  "tarballSha256",
  "builderId",
  "registryMetadataSha256",
  "verifiedProvenanceSha256"
];

export async function verifyNovaProviderArtifactReadback(options = {}, verify = verifyPublishedNpmArtifactWithRetry) {
  const catalogPath = path.resolve(options.catalogPath ?? defaultCatalogPath);
  const catalog = options.catalog ?? JSON.parse(await readFile(catalogPath, "utf8"));
  const declaredRequired = catalog.novaExtraction?.requiredExternalArtifacts ?? [];
  const required = [...new Set(declaredRequired)].sort();
  if (required.length !== declaredRequired.length) {
    throw new Error("NOVA required external provider artifacts must not contain duplicates");
  }
  if (required.length === 0) throw new Error("NOVA has no required external provider artifacts to verify");
  const results = {};
  for (const packageName of required) {
    const matches = (catalog.artifacts ?? []).filter((artifact) => artifact?.packageName === packageName);
    if (matches.length !== 1)
      throw new Error(`${packageName} must appear exactly once in the provider artifact catalog`);
    const artifact = matches[0];
    if (artifact.publication?.state !== "published") {
      throw new Error(`${packageName} is not marked published; live registry readback remains blocked`);
    }
    const evidence = artifact.publication.registryEvidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      throw new Error(`${packageName} has no registry evidence to read back`);
    }
    if (artifact.publication.workflow !== evidence.signerWorkflow) {
      throw new Error(`${packageName} registry evidence signer differs from its approved publication workflow`);
    }
    const observed = await verify({
      packageName,
      version: artifact.currentVersion,
      registryOrigin: catalog.registryOrigin,
      sourceRevision: evidence.sourceRevision,
      sourceRepository: evidence.sourceRepository,
      signerWorkflow: artifact.publication.workflow,
      attempts: options.attempts ?? 3,
      retryDelayMs: options.retryDelayMs ?? 1_000
    });
    for (const field of EVIDENCE_FIELDS) {
      if (observed[field] !== evidence[field]) {
        throw new Error(`${packageName} live registry ${field} differs from the cataloged readback evidence`);
      }
    }
    results[packageName] = observed;
  }
  return {
    schemaVersion: 1,
    catalogVersion: catalog.catalogVersion,
    registryOrigin: catalog.registryOrigin,
    verifiedAt: options.verifiedAt ?? new Date().toISOString(),
    artifacts: results
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--catalog") options.catalogPath = argv[++index];
    else if (argument === "--attempts") options.attempts = Number(argv[++index]);
    else if (argument === "--retry-delay-ms") options.retryDelayMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const result = await verifyNovaProviderArtifactReadback(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `NOVA_PROVIDER_REGISTRY_READBACK_OK=${Object.keys(result.artifacts).length}\nNOVA_PROVIDER_REGISTRY=${result.registryOrigin}\n`
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

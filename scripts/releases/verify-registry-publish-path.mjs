#!/usr/bin/env node
/**
 * Local-by-default, fail-closed preflight for the federated publication path.
 *
 * It proves that repository-owned release identity, Platform's current catalog,
 * mutation workflows and ownership surfaces agree. It deliberately does not
 * claim that GitHub environments, credentials or registry artifacts exist.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  loadReleaseIdentity,
  readLatestReleaseCatalog,
  RELEASE_IDENTITY_PATH,
  releaseIdentityOwnerHandles,
  releaseIdentityTeamSlug,
  validateCatalogReleaseIdentity,
  validateReleaseIdentity
} from "./release-identity.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MUTATION_WORKFLOWS = Object.freeze([
  ".github/workflows/build-attested-cell-images.yml",
  ".github/workflows/publish-provider-contracts.yml",
  ".github/workflows/publish-shared-libraries.yml",
  ".github/workflows/publish-release.yml"
]);
const NPM_WORKFLOWS = new Set([
  ".github/workflows/publish-provider-contracts.yml",
  ".github/workflows/publish-shared-libraries.yml",
  ".github/workflows/publish-release.yml"
]);

export async function inspectRegistryPublishPath(options = {}) {
  const root = options.root ?? repositoryRoot;
  const problems = [];
  let identity;
  const catalogVersions = {};

  try {
    identity = await loadReleaseIdentity(root);
    problems.push(...validateReleaseIdentity(identity));
  } catch (error) {
    problems.push(`${RELEASE_IDENTITY_PATH} is missing or invalid JSON (${error.message})`);
  }

  const requiredFiles = [
    ...MUTATION_WORKFLOWS,
    "scripts/releases/shared-library-publication.test.mjs",
    "scripts/releases/release-identity.test.mjs",
    "docs/operations/REGISTRY-PUBLISH-PATH.md",
    "apps/api-gateway/src/compatibility-platform-catalog.ts",
    ".github/CODEOWNERS",
    "SECURITY.md",
    "releases/README.md",
    "releases/registry/provider-artifacts.v1.json"
  ];
  const contents = new Map();
  for (const relativePath of requiredFiles) {
    try {
      contents.set(relativePath, await readFile(path.join(root, relativePath), "utf8"));
    } catch {
      problems.push(`missing ${relativePath}`);
    }
  }

  if (identity && validateReleaseIdentity(identity).length === 0) {
    for (const cell of identity.releaseCells) {
      try {
        const latest = await readLatestReleaseCatalog(root, cell);
        catalogVersions[cell] = latest.version;
        problems.push(
          ...validateCatalogReleaseIdentity(identity, latest.catalog, {
            context: `releases/catalogs/${cell}/${latest.version}.json`
          })
        );
      } catch (error) {
        problems.push(`current ${cell} catalog cannot be validated (${error.message})`);
      }
    }

    validateRequestedIdentity(options, identity, catalogVersions, problems);
    validateWorkflows(contents, identity, problems);
    validateOwnershipSurfaces(contents, identity, problems);
    validateRegistryCatalog(contents, identity, problems);
    if (options.verifyGithubAccess) {
      if (identity.ownershipState !== "verified-repository-access") {
        problems.push(
          `${RELEASE_IDENTITY_PATH}.ownershipState is ${identity.ownershipState}; remote publication requires verified-repository-access`
        );
      }
      problems.push(
        ...(await verifyGithubOwnershipAccess(identity, {
          token: options.githubToken ?? process.env.GITHUB_OWNERSHIP_TOKEN,
          fetchImpl: options.fetchImpl,
          apiOrigin: options.githubApiOrigin
        }))
      );
    }
  }

  const rootPackage = await readJson(root, "package.json", problems);
  if (
    rootPackage &&
    rootPackage.scripts?.["release:verify-registry-path"] !== "node scripts/releases/verify-registry-publish-path.mjs"
  ) {
    problems.push('package.json must expose "release:verify-registry-path"');
  }

  const gatewayPackage = await readJson(root, "apps/api-gateway/package.json", problems);
  if (
    gatewayPackage?.dependencies?.["@hyperion/contracts"] ||
    gatewayPackage?.devDependencies?.["@hyperion/contracts"]
  ) {
    problems.push("apps/api-gateway must not depend on @hyperion/contracts (DEBT-021 closed)");
  }

  return {
    problems,
    summary: identity
      ? {
          githubRepository: identity.githubRepository,
          ghcrNamespace: identity.ghcrNamespace,
          npmRegistryOrigin: identity.npmRegistryOrigin,
          releaseEnvironment: identity.releaseEnvironment,
          releaseCells: identity.releaseCells,
          ownershipState: identity.ownershipState,
          catalogVersions,
          platformCatalogVersion: catalogVersions.platform ?? null
        }
      : null
  };
}

function validateRequestedIdentity(options, identity, catalogVersions, problems) {
  const sourceRepository = options.sourceRepository ?? process.env.GITHUB_REPOSITORY;
  if (sourceRepository && sourceRepository !== identity.githubRepository) {
    problems.push(`source repository ${sourceRepository} differs from ${identity.githubRepository}`);
  }
  if (options.ghcrNamespace && options.ghcrNamespace !== identity.ghcrNamespace) {
    problems.push(`GHCR namespace ${options.ghcrNamespace} differs from ${identity.ghcrNamespace}`);
  }
  if (options.registryOrigin && options.registryOrigin !== identity.npmRegistryOrigin) {
    problems.push(`npm registry ${options.registryOrigin} differs from ${identity.npmRegistryOrigin}`);
  }
  if (options.cell && !identity.releaseCells.includes(options.cell)) {
    problems.push(
      `release cell ${options.cell} is outside the canonical identity scope (${identity.releaseCells.join(", ")})`
    );
  }
  if (options.catalogVersion && !options.cell) {
    problems.push("--catalog-version requires --cell");
  } else if (
    options.catalogVersion &&
    catalogVersions[options.cell] &&
    options.catalogVersion !== catalogVersions[options.cell]
  ) {
    problems.push(
      `${options.cell} catalog ${options.catalogVersion} differs from current ${catalogVersions[options.cell]}`
    );
  }
}

function validateWorkflows(contents, identity, problems) {
  for (const relativePath of MUTATION_WORKFLOWS) {
    const workflow = contents.get(relativePath);
    if (!workflow) continue;
    if (!/workflow_dispatch:/.test(workflow)) {
      problems.push(`${relativePath} must remain workflow_dispatch-gated`);
    }
    if (/^\s*push:\s*$/m.test(workflow) || /^\s*schedule:\s*$/m.test(workflow)) {
      problems.push(`${relativePath} must not publish automatically on push or schedule`);
    }
    if (!new RegExp(`environment:\\s*${escapeRegex(identity.releaseEnvironment)}`).test(workflow)) {
      problems.push(`${relativePath} must use GitHub environment ${identity.releaseEnvironment}`);
    }
    if (!/\$\{\{ github\.repository \}\}/.test(workflow)) {
      problems.push(`${relativePath} must derive provenance repository from github.repository`);
    }
    if (/administracionhyperion/i.test(workflow)) {
      problems.push(`${relativePath} still contains the retired AdministracionHyperion identity`);
    }
    if (
      !/verify-registry-publish-path\.mjs[\s\S]*--verify-github-access/.test(workflow) ||
      !/secrets\.RELEASE_GOVERNANCE_TOKEN/.test(workflow)
    ) {
      problems.push(
        `${relativePath} must run the remote ownership preflight with RELEASE_GOVERNANCE_TOKEN before mutation`
      );
    }
    const sourceVerificationIndex = workflow.indexOf("git rev-parse HEAD");
    const ownershipPreflightIndex = workflow.indexOf("verify-registry-publish-path.mjs");
    if (
      sourceVerificationIndex === -1 ||
      ownershipPreflightIndex === -1 ||
      sourceVerificationIndex > ownershipPreflightIndex
    ) {
      problems.push(`${relativePath} must verify the protected source before exposing the governance token`);
    }
    if (NPM_WORKFLOWS.has(relativePath)) {
      const registry = escapeRegex(identity.npmRegistryOrigin);
      if (!new RegExp(`default:\\s*${registry}`).test(workflow)) {
        problems.push(`${relativePath} must default to ${identity.npmRegistryOrigin}`);
      }
      if (!/secrets\.NPM_TOKEN/.test(workflow)) {
        problems.push(`${relativePath} must read NPM_TOKEN only from GitHub secrets`);
      }
    }
  }
}

function validateOwnershipSurfaces(contents, identity, problems) {
  const codeowners = contents.get(".github/CODEOWNERS");
  if (codeowners) {
    const marker = `# ownership-status: ${identity.ownershipState}`;
    if (!codeowners.split(/\r?\n/).some((line) => line.trim() === marker)) {
      problems.push(`.github/CODEOWNERS must declare ${marker}`);
    }
    const activeRules = codeowners
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const requiredOwners = releaseIdentityOwnerHandles(identity);
    const expectedRules = expectedPlatformCodeownerRules(identity);
    if (identity.releaseCells.length !== 1 || identity.releaseCells[0] !== "platform") {
      problems.push(".github/CODEOWNERS policy is defined only for the canonical Platform release slice");
    }
    if (identity.ownershipState === "pending-repository-access" && activeRules.length > 0) {
      problems.push(".github/CODEOWNERS must not activate owner rules while repository access is pending");
    }
    for (const expectedRule of expectedRules) {
      const expectedLine = expectedRule.join(" ");
      if (identity.ownershipState === "pending-repository-access") {
        if (!codeowners.split(/\r?\n/).some((line) => line.trim() === `# ${expectedLine}`)) {
          problems.push(`.github/CODEOWNERS must document the intended rule ${expectedLine}`);
        }
      } else if (!activeRules.includes(expectedLine)) {
        problems.push(`.github/CODEOWNERS must activate the exact rule ${expectedLine}`);
      }
    }
    for (const owner of requiredOwners) {
      if (!expectedRules.some((rule) => rule.slice(1).includes(owner))) {
        problems.push(`.github/CODEOWNERS policy does not cover canonical owner ${owner}`);
      }
    }
    if (/administracionhyperion/i.test(codeowners)) {
      problems.push(".github/CODEOWNERS still contains the retired AdministracionHyperion identity");
    }
  }

  const security = contents.get("SECURITY.md");
  const advisoryUrl = `https://github.com/${identity.githubRepository}/security/advisories/new`;
  if (security && !security.includes(advisoryUrl)) problems.push(`SECURITY.md must use ${advisoryUrl}`);
  if (security && /github\.com\/AdministracionHyperion\//i.test(security)) {
    problems.push("SECURITY.md still points to the retired GitHub repository");
  }

  const releaseReadme = contents.get("releases/README.md");
  if (releaseReadme && !releaseReadme.includes(`${identity.ghcrNamespace}/`)) {
    problems.push(`releases/README.md must use ${identity.ghcrNamespace}`);
  }
  if (releaseReadme && /ghcr\.io\/administracionhyperion\//i.test(releaseReadme)) {
    problems.push("releases/README.md still points to the retired GHCR namespace");
  }
}

function expectedPlatformCodeownerRules(identity) {
  const architecture = identity.governanceOwners.architecture;
  const releaseSecurity = identity.governanceOwners.releaseSecurity;
  const platform = identity.cellOwners.platform;
  return [
    ["*", architecture],
    ["/apps/platform-admin-bff/", platform],
    ["/apps/platform-admin-console/", platform],
    ["/services/identity-service/", platform],
    ["/services/tenant-service/", platform],
    ["/services/audit-service/", platform],
    ["/packages/access-migrations/", platform],
    ["/packages/audit-migrations/", platform],
    ["/packages/platform-contracts/", platform],
    ["/packages/audit-contracts/", platform],
    ["/infra/docker-compose.platform*.yml", platform],
    ["/infra/platform.env.example", platform],
    ["/releases/", releaseSecurity, architecture],
    ["/releases/catalogs/platform/", platform, releaseSecurity],
    ["/scripts/releases/", releaseSecurity, architecture],
    ["/.github/workflows/build-attested-cell-images.yml", releaseSecurity],
    ["/.github/workflows/publish-provider-contracts.yml", releaseSecurity],
    ["/.github/workflows/publish-shared-libraries.yml", releaseSecurity],
    ["/.github/workflows/publish-release.yml", releaseSecurity],
    ["/.github/CODEOWNERS", architecture, releaseSecurity],
    ["/SECURITY.md", releaseSecurity]
  ];
}

export async function verifyGithubOwnershipAccess(
  identity,
  { token, fetchImpl = globalThis.fetch, apiOrigin = "https://api.github.com" } = {}
) {
  const problems = [];
  if (typeof token !== "string" || token.length === 0) {
    return ["GITHUB_OWNERSHIP_TOKEN is required to accredit CODEOWNERS team visibility and repository write access"];
  }
  if (typeof fetchImpl !== "function") return ["GitHub ownership verification requires fetch support"];

  const [repositoryOwner, repositoryName] = identity.githubRepository.split("/");
  // Team→repo membership returns 204 with application/vnd.github+json.
  // Request the repository representation so permissions.push|maintain|admin are present.
  const headers = {
    Accept: "application/vnd.github.v3.repository+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
  for (const handle of releaseIdentityOwnerHandles(identity)) {
    const slug = releaseIdentityTeamSlug(handle, identity.githubOrganization);
    if (!slug) {
      problems.push(`${handle} is not a team under @${identity.githubOrganization}`);
      continue;
    }

    let teamResponse;
    try {
      teamResponse = await fetchImpl(
        `${apiOrigin}/orgs/${encodeURIComponent(identity.githubOrganization)}/teams/${encodeURIComponent(slug)}`,
        { headers }
      );
    } catch (error) {
      problems.push(`${handle} visibility could not be accredited (${error.message})`);
      continue;
    }
    if (!teamResponse.ok) {
      problems.push(
        `${handle} visibility could not be accredited (GitHub API ${teamResponse.status}; team missing or token lacks organization visibility)`
      );
      continue;
    }
    const team = await readResponseJson(teamResponse);
    if (team?.slug !== slug || team?.privacy !== "closed") {
      problems.push(`${handle} must be an existing visible (privacy=closed) GitHub team`);
      continue;
    }

    let repositoryResponse;
    try {
      repositoryResponse = await fetchImpl(
        `${apiOrigin}/orgs/${encodeURIComponent(identity.githubOrganization)}/teams/${encodeURIComponent(slug)}/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}`,
        { headers }
      );
    } catch (error) {
      problems.push(`${handle} repository access could not be accredited (${error.message})`);
      continue;
    }
    if (!repositoryResponse.ok) {
      problems.push(
        `${handle} repository access could not be accredited (GitHub API ${repositoryResponse.status}; no explicit access or token lacks visibility)`
      );
      continue;
    }
    const repository = await readResponseJson(repositoryResponse);
    const permissions = repository?.permissions;
    const hasWrite = Boolean(permissions?.push || permissions?.maintain || permissions?.admin);
    if (repository?.full_name !== identity.githubRepository || !hasWrite) {
      problems.push(`${handle} lacks explicit write/admin access to ${identity.githubRepository}`);
    }
  }
  return problems;
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function validateRegistryCatalog(contents, identity, problems) {
  const source = contents.get("releases/registry/provider-artifacts.v1.json");
  if (!source) return;
  try {
    const catalog = JSON.parse(source);
    if (catalog.registryOrigin !== identity.npmRegistryOrigin) {
      problems.push(
        `releases/registry/provider-artifacts.v1.json registryOrigin must be ${identity.npmRegistryOrigin}`
      );
    }
  } catch (error) {
    problems.push(`releases/registry/provider-artifacts.v1.json is invalid JSON (${error.message})`);
  }
}

async function readJson(root, relativePath, problems) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    problems.push(`${relativePath} is missing or invalid JSON (${error.message})`);
    return null;
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseRegistryPublishPathArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--verify-github-access") {
      if (options.verifyGithubAccess) throw new Error(`${argument} may be supplied only once`);
      options.verifyGithubAccess = true;
    } else if (
      ["--source-repository", "--ghcr-namespace", "--registry-origin", "--cell", "--catalog-version"].includes(argument)
    ) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      const key = {
        "--source-repository": "sourceRepository",
        "--ghcr-namespace": "ghcrNamespace",
        "--registry-origin": "registryOrigin",
        "--cell": "cell",
        "--catalog-version": "catalogVersion"
      }[argument];
      if (options[key]) throw new Error(`${argument} may be supplied only once`);
      options[key] = value;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}`);
    }
  }
  return options;
}

async function main() {
  const options = parseRegistryPublishPathArguments(process.argv.slice(2));
  const result = await inspectRegistryPublishPath(options);
  if (result.problems.length > 0) {
    process.stderr.write(`Registry publish path verification failed:\n- ${result.problems.join("\n- ")}\n`);
    process.exitCode = 1;
    return;
  }
  const summary = result.summary;
  const scope = summary.releaseCells.map((cell) => `${cell} catalog ${summary.catalogVersions[cell]}`).join(", ");
  if (options.verifyGithubAccess) {
    process.stdout.write(
      `Registry publish path OK (live ownership verified): ${summary.githubRepository}; ` +
        `${summary.ghcrNamespace}; ${scope}; ${summary.npmRegistryOrigin}; ` +
        `environment ${summary.releaseEnvironment}.\n`
    );
  } else {
    const publicationBlocker =
      summary.ownershipState === "verified-repository-access"
        ? "Remote publication remains blocked until environment secrets, credentials and published artifacts have live evidence."
        : "Remote publication remains blocked until GitHub ownership, environment, credentials and artifacts have live evidence.";
    process.stdout.write(
      `Registry publish path locally consistent: ${summary.githubRepository}; ${summary.ghcrNamespace}; ` +
        `${scope}; ${summary.npmRegistryOrigin}; environment ${summary.releaseEnvironment}; ` +
        `ownership ${summary.ownershipState}. ${publicationBlocker}\n`
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

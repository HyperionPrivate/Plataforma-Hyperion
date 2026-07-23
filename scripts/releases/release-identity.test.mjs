import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadReleaseIdentity,
  readLatestReleaseCatalog,
  validateCatalogReleaseIdentity,
  validateReleaseIdentity
} from "./release-identity.mjs";
import {
  inspectRegistryPublishPath,
  parseRegistryPublishPathArguments,
  verifyGithubOwnershipAccess
} from "./verify-registry-publish-path.mjs";
import { validateCatalog } from "./release-model.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("canonical release identity owns the current Platform catalog and GHCR namespace", async () => {
  const identity = await loadReleaseIdentity(repositoryRoot);
  assert.deepEqual(validateReleaseIdentity(identity), []);
  assert.equal(identity.githubRepository, "HyperionPrivate/Plataforma-Hyperion");
  assert.equal(identity.ghcrNamespace, "ghcr.io/hyperionprivate");
  assert.deepEqual(identity.releaseCells, ["platform"]);
  assert.equal(identity.ownershipState, "verified-repository-access");
  assert.equal(identity.cellOwners.platform, "@HyperionPrivate/platform");

  const { catalog, version } = await readLatestReleaseCatalog(repositoryRoot, "platform");
  assert.equal(version, "2.4.0");
  assert.deepEqual(validateCatalog(catalog), []);
  assert.deepEqual(validateCatalogReleaseIdentity(identity, catalog), []);
});

test("release identity rejects retired owners, foreign repositories and mismatched registries", async () => {
  const identity = await loadReleaseIdentity(repositoryRoot);
  const retired = structuredClone(identity);
  retired.githubOrganization = "AdministracionHyperion";
  retired.githubRepository = "AdministracionHyperion/Plataforma-Hyperion";
  retired.ghcrNamespace = "ghcr.io/administracionhyperion";
  retired.cellOwners.platform = "@AdministracionHyperion/platform";
  assert.match(validateReleaseIdentity(retired).join("\n"), /retired AdministracionHyperion identity/);

  const foreign = structuredClone(identity);
  foreign.githubRepository = "OtherOrg/Plataforma-Hyperion";
  foreign.npmRegistryOrigin = "https://registry.example.invalid";
  assert.match(validateReleaseIdentity(foreign).join("\n"), /owner must match|npmRegistryOrigin/);
});

test("Platform catalog identity fails closed on a foreign owner or OCI namespace", async () => {
  const identity = await loadReleaseIdentity(repositoryRoot);
  const { catalog } = await readLatestReleaseCatalog(repositoryRoot, "platform");
  const foreign = structuredClone(catalog);
  foreign.owner = "@HyperionPrivate/nova";
  foreign.components.find((component) => component.distribution === "oci").imageRepository =
    "ghcr.io/foreign/identity-service";
  const errors = validateCatalogReleaseIdentity(identity, foreign).join("\n");
  assert.match(errors, /owner must be @HyperionPrivate\/platform/);
  assert.match(errors, /imageRepository must start with ghcr\.io\/hyperionprivate\//);
});

test("offline publication preflight binds workflows, CODEOWNERS and registry surfaces", async () => {
  const result = await inspectRegistryPublishPath({ root: repositoryRoot });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.summary, {
    githubRepository: "HyperionPrivate/Plataforma-Hyperion",
    ghcrNamespace: "ghcr.io/hyperionprivate",
    npmRegistryOrigin: "https://registry.npmjs.org",
    releaseEnvironment: "release-publication",
    releaseCells: ["platform"],
    ownershipState: "verified-repository-access",
    catalogVersions: { platform: "2.4.0" },
    platformCatalogVersion: "2.4.0"
  });
});

test("publication preflight rejects caller-supplied repository and registry drift", async () => {
  const result = await inspectRegistryPublishPath({
    root: repositoryRoot,
    sourceRepository: "OtherOrg/Plataforma-Hyperion",
    ghcrNamespace: "ghcr.io/otherorg",
    registryOrigin: "https://registry.example.invalid",
    cell: "nova",
    catalogVersion: "9.9.9"
  });
  const errors = result.problems.join("\n");
  assert.match(errors, /source repository .* differs/);
  assert.match(errors, /GHCR namespace .* differs/);
  assert.match(errors, /npm registry .* differs/);
  assert.match(errors, /release cell nova is outside the canonical identity scope/);
});

test("GitHub ownership verifier requires visible teams with explicit write evidence", async () => {
  const identity = await loadReleaseIdentity(repositoryRoot);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const slug = /\/teams\/([^/]+)/.exec(url)?.[1];
    if (url.includes("/repos/")) {
      return response({
        full_name: identity.githubRepository,
        permissions: { pull: true, triage: true, push: true, maintain: false, admin: false }
      });
    }
    return response({ slug, privacy: "closed" });
  };
  assert.deepEqual(await verifyGithubOwnershipAccess(identity, { token: "test-token", fetchImpl }), []);
  assert.equal(calls.length, 6);

  const inaccessible = await verifyGithubOwnershipAccess(identity, {
    token: "test-token",
    fetchImpl: async (url) =>
      url.includes("/repos/")
        ? response(null, 404)
        : response({ slug: /\/teams\/([^/]+)/.exec(url)?.[1], privacy: "closed" })
  });
  assert.equal(inaccessible.length, 3);
  assert.match(inaccessible.join("\n"), /repository access could not be accredited \(GitHub API 404/);
});

test("remote publication preflight accepts verified ownership with write evidence", async () => {
  const result = await inspectRegistryPublishPath({
    root: repositoryRoot,
    verifyGithubAccess: true,
    githubToken: "test-token",
    fetchImpl: async (url) => {
      const slug = /\/teams\/([^/]+)/.exec(url)?.[1];
      return url.includes("/repos/")
        ? response({
            full_name: "HyperionPrivate/Plataforma-Hyperion",
            permissions: { push: true }
          })
        : response({ slug, privacy: "closed" });
    }
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.summary?.ownershipState, "verified-repository-access");
});

test("publication preflight arguments are explicit and non-repeatable", () => {
  assert.deepEqual(
    parseRegistryPublishPathArguments([
      "--source-repository",
      "HyperionPrivate/Plataforma-Hyperion",
      "--ghcr-namespace",
      "ghcr.io/hyperionprivate",
      "--registry-origin",
      "https://registry.npmjs.org",
      "--cell",
      "platform",
      "--catalog-version",
      "2.4.0",
      "--verify-github-access"
    ]),
    {
      sourceRepository: "HyperionPrivate/Plataforma-Hyperion",
      ghcrNamespace: "ghcr.io/hyperionprivate",
      registryOrigin: "https://registry.npmjs.org",
      cell: "platform",
      catalogVersion: "2.4.0",
      verifyGithubAccess: true
    }
  );
  assert.throws(() => parseRegistryPublishPathArguments(["--source-repository"]), /requires a value/);
  assert.throws(
    () =>
      parseRegistryPublishPathArguments([
        "--registry-origin",
        "https://registry.npmjs.org",
        "--registry-origin",
        "https://registry.npmjs.org"
      ]),
    /only once/
  );
  assert.throws(() => parseRegistryPublishPathArguments(["--publish"]), /Unknown argument/);
});

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

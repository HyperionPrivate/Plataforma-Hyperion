import { createHash } from "node:crypto";

const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "verifier",
  "sourceRepository",
  "registryOrigin",
  "cell",
  "catalogVersion",
  "sourceRevision",
  "verifiedAt",
  "packages"
];
const PACKAGE_KEYS = [
  "package",
  "registryTarball",
  "integrity",
  "tarballSha256",
  "sourceRevision",
  "builderId",
  "registryMetadataSha256",
  "verifiedProvenanceSha256"
];

export function validateNpmVerification(evidence, catalog, options) {
  exactKeys(evidence, TOP_LEVEL_KEYS, "npm provenance verification");
  if (
    evidence.schemaVersion !== 1 ||
    evidence.verifier !== "npm-registry-sha512+gh-attestation" ||
    evidence.sourceRepository !== options.sourceRepository ||
    evidence.cell !== options.cell ||
    evidence.catalogVersion !== options.catalogVersion ||
    evidence.sourceRevision !== options.sourceRevision ||
    !Number.isFinite(Date.parse(evidence.verifiedAt)) ||
    !evidence.packages ||
    typeof evidence.packages !== "object" ||
    Array.isArray(evidence.packages)
  ) {
    throw new Error("npm provenance verification identity differs from the release input");
  }
  const registryOrigin = normalizeRegistryOrigin(evidence.registryOrigin);
  const npmComponents = catalog.components.filter((component) => component.distribution === "npm");
  const expectedIds = npmComponents.map((component) => component.id).sort();
  if (JSON.stringify(Object.keys(evidence.packages).sort()) !== JSON.stringify(expectedIds)) {
    throw new Error("npm provenance verification must cover every exact catalog npm component");
  }

  const packages = new Map();
  for (const component of npmComponents) {
    const entry = evidence.packages[component.id];
    exactKeys(entry, PACKAGE_KEYS, `npm provenance verification ${component.id}`);
    const packageReference = `${component.packageName}@${component.version}`;
    let tarball;
    try {
      tarball = new URL(entry.registryTarball);
    } catch {
      throw new Error(`npm provenance verification ${component.id} has an invalid tarball URL`);
    }
    if (
      entry.package !== packageReference ||
      entry.sourceRevision !== options.sourceRevision ||
      !INTEGRITY.test(entry.integrity) ||
      !SHA256.test(entry.tarballSha256) ||
      !SHA256.test(entry.registryMetadataSha256) ||
      !SHA256.test(entry.verifiedProvenanceSha256) ||
      typeof entry.builderId !== "string" ||
      !entry.builderId ||
      tarball.protocol !== "https:" ||
      tarball.username ||
      tarball.password ||
      tarball.search ||
      tarball.hash ||
      tarball.origin !== registryOrigin
    ) {
      throw new Error(`npm provenance verification ${component.id} is invalid`);
    }
    packages.set(component.id, entry);
  }
  return packages;
}

export function packageSetSha256(packages) {
  const lines = [...packages.entries()]
    .map(([id, entry]) => `${id}=${entry.package}|${entry.integrity}|${entry.tarballSha256}`)
    .sort();
  return createHash("sha256")
    .update(`${lines.join("\n")}\n`)
    .digest("hex");
}

function normalizeRegistryOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("npm provenance verification registryOrigin is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("npm provenance verification registryOrigin must be a credential-free HTTPS origin");
  }
  return url.origin;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} must contain exactly: ${keys.join(", ")}`);
  }
}

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const CELL_NAMES = Object.freeze(["platform", "nova", "lumen", "pulso"]);

export const CELL_COMPOSE_DESCRIPTORS = Object.freeze({
  platform: Object.freeze({
    composeFile: "infra/docker-compose.platform.yml",
    envFile: "infra/platform.env.example"
  }),
  nova: Object.freeze({ composeFile: "infra/docker-compose.nova.yml", envFile: "infra/nova.env.example" }),
  lumen: Object.freeze({ composeFile: "infra/docker-compose.lumen.yml", envFile: "infra/lumen.env.example" }),
  pulso: Object.freeze({ composeFile: "infra/docker-compose.pulso.yml", envFile: "infra/pulso.env.example" })
});

export const CELL_COMPOSE_SERVICES = Object.freeze({
  platform: Object.freeze([
    "access-database-bootstrap",
    "access-migrations",
    "access-role-bootstrap",
    "audit-database-bootstrap",
    "audit-migrations",
    "audit-role-bootstrap",
    "identity-service",
    "tenant-service",
    "audit-service",
    "platform-admin-bff",
    "platform-admin-console"
  ]),
  nova: Object.freeze([
    "nova-migrations",
    "nova-core-service",
    "voice-channel-service",
    "liwa-channel-service",
    "documents-service",
    "nova-bff",
    "nova-console",
    "coopfuturo-console"
  ]),
  lumen: Object.freeze([
    // The database, migration and role-bootstrap one-shots are three Compose
    // aliases of the same provider-owned @hyperion/lumen-migrations image.
    "lumen-database-bootstrap",
    "lumen-migrations",
    "lumen-role-bootstrap",
    "lumen-service",
    "lumen-bff",
    "lumen-console"
  ]),
  pulso: Object.freeze([
    "pulso-database-bootstrap",
    "pulso-migrations",
    "pulso-role-bootstrap",
    "agent-service",
    "prompt-flow-service",
    "knowledge-service",
    "integration-service",
    "pulso-iris-service",
    "whatsapp-channel-service",
    "pulso-bff",
    "pulso-console"
  ])
});

// The image smoke executes this artifact as the container process and probes its
// isolated HTTP health contract. Platform readiness depends on its Access/Tenant
// stack and is intentionally verified only by standalone integration, not here.
export const CELL_SMOKE_TARGETS = Object.freeze({
  platform: Object.freeze({
    service: "platform-admin-bff",
    artifact: "apps/platform-admin-bff/dist/index.js",
    containerPort: 8098,
    expectedService: "platform-admin-bff",
    audience: "platform-admin-bff"
  }),
  nova: Object.freeze({
    service: "nova-bff",
    artifact: "apps/nova-bff/dist/index.js",
    containerPort: 8095,
    expectedService: "nova-bff",
    audience: "nova-bff"
  }),
  lumen: Object.freeze({
    service: "lumen-bff",
    artifact: "apps/lumen-bff/dist/index.js",
    containerPort: 8096,
    expectedService: "lumen-bff",
    audience: "lumen-bff"
  }),
  pulso: Object.freeze({
    service: "pulso-bff",
    artifact: "apps/pulso-bff/dist/index.js",
    containerPort: 8097,
    expectedService: "pulso-bff",
    audience: "pulso-bff"
  })
});

const SERVICE_CELLS = Object.freeze({
  "identity-service": "platform",
  "tenant-service": "platform",
  "audit-service": "platform",
  "nova-core-service": "nova",
  "nova-bff": "nova",
  "voice-channel-service": "nova",
  "liwa-channel-service": "nova",
  "documents-service": "nova",
  "lumen-service": "lumen",
  "lumen-bff": "lumen",
  "agent-service": "pulso",
  "prompt-flow-service": "pulso",
  "knowledge-service": "pulso",
  "integration-service": "pulso",
  "pulso-iris-service": "pulso",
  "pulso-bff": "pulso",
  "whatsapp-channel-service": "pulso"
});

const APP_CELLS = Object.freeze({
  "api-gateway": "platform",
  "platform-admin-bff": "platform",
  "platform-admin-console": "platform",
  "nova-console": "nova",
  "nova-bff": "nova",
  "coopfuturo-console": "nova",
  "lumen-console": "lumen",
  "lumen-bff": "lumen",
  // Transitional redirect-only frontend. Product flows live in the dedicated
  // consoles; the legacy origin is an edge/platform compatibility surface.
  "web-console": "platform",
  "pulso-console": "pulso",
  "pulso-bff": "pulso"
});

// Provider ownership is explicit even for neutral packages. This prevents an
// Access-only migration change from being inferred as an unnamed shared root.
const PACKAGE_CELLS = Object.freeze({
  "access-migrations": "platform"
});

const PRODUCT_PATH_PATTERNS = Object.freeze([
  [/(?:^|\/)nova(?:\/|-|$)|coopfuturo/i, "nova"],
  [/(?:^|\/)lumen(?:\/|-|$)/i, "lumen"],
  [/(?:^|\/)pulso(?:\/|-|$)|sofia|whatsapp/i, "pulso"]
]);

export function normalizeRepoPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function assertCell(cell) {
  if (!CELL_NAMES.includes(cell)) {
    throw new Error(`Unknown cell ${JSON.stringify(cell)}; expected one of ${CELL_NAMES.join(", ")}`);
  }
  return cell;
}

export function cellForPackagePath(value) {
  const relativePath = normalizeRepoPath(value).replace(/\/$/, "");
  const [root, packageDirectory] = relativePath.split("/");
  if (!packageDirectory) return null;

  if (root === "apps") return APP_CELLS[packageDirectory] ?? inferProductCell(packageDirectory);
  if (root === "services") return SERVICE_CELLS[packageDirectory] ?? inferProductCell(packageDirectory);
  if (root === "packages") {
    return PACKAGE_CELLS[packageDirectory] ?? inferProductCell(packageDirectory) ?? "platform";
  }
  return null;
}

export function directCellsForPath(value) {
  const relativePath = normalizeRepoPath(value);
  const packageMatch = relativePath.match(/^(apps|services|packages)\/[^/]+/);
  if (packageMatch) {
    const cell = cellForPackagePath(packageMatch[0]);
    return cell ? [cell] : [];
  }

  const productDocumentCell = cellForProductDocument(relativePath);
  if (productDocumentCell) return [productDocumentCell];
  if (/^docs\/products\//i.test(relativePath)) return [...CELL_NAMES];

  for (const [pattern, cell] of PRODUCT_PATH_PATTERNS) {
    if (pattern.test(relativePath)) return [cell];
  }

  if (/^\.github\/workflows\/(platform|nova|lumen|pulso)\.yml$/i.test(relativePath)) {
    return [relativePath.match(/^\.github\/workflows\/(platform|nova|lumen|pulso)\.yml$/i)[1].toLowerCase()];
  }

  if (
    /^(?:\.github\/workflows\/_|\.github\/workflows\/check\.yml|infra\/|scripts\/(?:architecture|ci)\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig(?:\..+)?\.json$|eslint\.config\.|\.prettier)/.test(
      relativePath
    )
  ) {
    return [...CELL_NAMES];
  }

  // Unknown repository-level changes are conservatively global. It is safer to
  // run an extra cell than to silently miss a dependency not represented by a
  // workspace package (for example a root build configuration).
  return [...CELL_NAMES];
}

export function dependencyCellAllowed(sourceCell, targetCell) {
  assertCell(sourceCell);
  assertCell(targetCell);
  return sourceCell === targetCell || targetCell === "platform";
}

export async function discoverPackages(root) {
  const packages = [];
  for (const workspaceRoot of ["apps", "services", "packages"]) {
    const absoluteWorkspaceRoot = path.join(root, workspaceRoot);
    let entries;
    try {
      entries = await readdir(absoluteWorkspaceRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relativeDirectory = `${workspaceRoot}/${entry.name}`;
      const packageJsonPath = path.join(root, relativeDirectory, "package.json");
      let manifest;
      try {
        manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw new Error(`Cannot read ${normalizeRepoPath(path.relative(root, packageJsonPath))}: ${error.message}`, {
          cause: error
        });
      }

      const cell = cellForPackagePath(relativeDirectory);
      const dependencyNames = new Set();
      for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const dependencyName of Object.keys(manifest[section] ?? {})) dependencyNames.add(dependencyName);
      }

      packages.push({
        name: manifest.name ?? null,
        directory: relativeDirectory,
        absoluteDirectory: path.join(root, relativeDirectory),
        cell,
        manifest,
        dependencyNames: [...dependencyNames].sort()
      });
    }
  }

  return packages.sort((left, right) => left.directory.localeCompare(right.directory));
}

export function packageForPath(packages, value) {
  const relativePath = normalizeRepoPath(value);
  return (
    packages
      .filter((entry) => relativePath === entry.directory || relativePath.startsWith(`${entry.directory}/`))
      .sort((left, right) => right.directory.length - left.directory.length)[0] ?? null
  );
}

function inferProductCell(value) {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("nova-") || normalized === "nova" || normalized.includes("coopfuturo")) return "nova";
  if (normalized.startsWith("lumen-") || normalized === "lumen") return "lumen";
  if (normalized.startsWith("pulso-") || normalized === "pulso") return "pulso";
  return null;
}

function cellForProductDocument(value) {
  const normalized = value.toLowerCase();
  if (/^docs\/products\/(?:nova(?:[./-]|$)|coopfuturo)/.test(normalized)) return "nova";
  if (/^docs\/products\/lumen(?:[./-]|$)/.test(normalized)) return "lumen";
  if (/^docs\/products\/pulso(?:-iris)?(?:[./-]|$)/.test(normalized)) return "pulso";
  return null;
}

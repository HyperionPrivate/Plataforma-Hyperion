import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { normalizeRepoPath, packageForPath } from "./cell-policy.mjs";

const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const SKIPPED_DIRECTORIES = new Set([".git", ".next", ".turbo", "coverage", "dist", "node_modules"]);

async function walkSourceFiles(root) {
  const files = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }

  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...(await walkSourceFiles(absolutePath)));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files;
}

function tokenizeModuleSyntax(sourceText) {
  const tokens = [];
  let index = 0;

  while (index < sourceText.length) {
    const character = sourceText[index];
    const next = sourceText[index + 1];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < sourceText.length && !/[\r\n]/.test(sourceText[index])) index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = sourceText.indexOf("*/", index + 2);
      index = end === -1 ? sourceText.length : end + 2;
      continue;
    }
    if (character === "`") {
      index += 1;
      while (index < sourceText.length) {
        if (sourceText[index] === "\\") index += 2;
        else if (sourceText[index] === "`") {
          index += 1;
          break;
        } else index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      while (index < sourceText.length) {
        const current = sourceText[index];
        if (current === "\\") {
          if (index + 1 < sourceText.length) value += sourceText[index + 1];
          index += 2;
        } else if (current === quote) {
          index += 1;
          break;
        } else {
          value += current;
          index += 1;
        }
      }
      tokens.push({ type: "string", value });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < sourceText.length && /[A-Za-z0-9_$]/.test(sourceText[index])) index += 1;
      tokens.push({ type: "identifier", value: sourceText.slice(start, index) });
      continue;
    }

    tokens.push({ type: "punctuation", value: character });
    index += 1;
  }

  return tokens;
}

export function extractStaticModuleSpecifiers(sourceText) {
  const tokens = tokenizeModuleSyntax(sourceText);
  const specifiers = new Set();

  function addStringAt(index) {
    if (tokens[index]?.type === "string") specifiers.add(tokens[index].value);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "identifier") continue;

    if (token.value === "require" && tokens[index + 1]?.value === "(") {
      addStringAt(index + 2);
      continue;
    }
    if (token.value !== "import" && token.value !== "export") continue;
    if (token.value === "import" && tokens[index + 1]?.value === ".") continue;
    if (token.value === "import" && tokens[index + 1]?.value === "(") {
      addStringAt(index + 2);
      continue;
    }
    if (token.value === "import" && tokens[index + 1]?.type === "string") {
      addStringAt(index + 1);
      continue;
    }

    for (let cursor = index + 1; cursor < tokens.length && tokens[cursor]?.value !== ";"; cursor += 1) {
      if (tokens[cursor]?.type === "identifier" && tokens[cursor].value === "from") {
        addStringAt(cursor + 1);
        break;
      }
    }
  }

  return [...specifiers].sort();
}

function packageNameFromSpecifier(specifier) {
  if (!specifier.startsWith("@")) return specifier.split("/", 1)[0];
  const [scope, name] = specifier.split("/");
  return scope && name ? `${scope}/${name}` : specifier;
}

function targetPackageForSpecifier(root, packages, packagesByName, sourceFile, specifier) {
  if (specifier.startsWith(".")) {
    const targetPath = normalizeRepoPath(path.relative(root, path.resolve(path.dirname(sourceFile), specifier)));
    return packageForPath(packages, targetPath);
  }
  return packagesByName.get(packageNameFromSpecifier(specifier)) ?? null;
}

export async function validateWorkspaceDependencyGraph(root, packages) {
  const errors = [];
  const packagesByName = new Map();

  for (const packageEntry of packages) {
    if (!packageEntry.name) {
      errors.push(`workspace package ${packageEntry.directory} has no stable name`);
      continue;
    }
    if (packagesByName.has(packageEntry.name)) {
      errors.push(`duplicate workspace package name ${packageEntry.name}`);
    } else {
      packagesByName.set(packageEntry.name, packageEntry);
    }
  }

  for (const packageEntry of packages) {
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dependencyName, range] of Object.entries(packageEntry.manifest[section] ?? {})) {
        if (typeof range === "string" && range.startsWith("workspace:") && !packagesByName.has(dependencyName)) {
          errors.push(
            `${packageEntry.name ?? packageEntry.directory} declares unresolved ${section} edge ${dependencyName}@${range}`
          );
        }
      }
    }
  }

  for (const packageEntry of packages) {
    if (!packageEntry.name) continue;
    for (const sourceFile of await walkSourceFiles(packageEntry.absoluteDirectory)) {
      const sourceText = await readFile(sourceFile, "utf8");
      for (const specifier of extractStaticModuleSpecifiers(sourceText)) {
        const targetPackage = targetPackageForSpecifier(root, packages, packagesByName, sourceFile, specifier);
        if (targetPackage && targetPackage !== packageEntry) {
          if (!packageEntry.dependencyNames.includes(targetPackage.name)) {
            errors.push(
              `${packageEntry.name} imports undeclared workspace edge ${targetPackage.name} from ${normalizeRepoPath(
                path.relative(root, sourceFile)
              )} (${specifier})`
            );
          }
          continue;
        }
        if (
          specifier.startsWith("@hyperion/") &&
          !packageEntry.dependencyNames.includes(packageNameFromSpecifier(specifier))
        ) {
          errors.push(
            `${packageEntry.name} imports unresolved Hyperion dependency ${specifier} from ${normalizeRepoPath(
              path.relative(root, sourceFile)
            )}`
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Workspace dependency graph is incomplete:\n${[...new Set(errors)].sort().join("\n")}`);
  }
}

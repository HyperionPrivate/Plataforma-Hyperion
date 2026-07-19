export const NOVA_PROVIDER_SCHEMAS = ["nova", "voice", "liwa", "documents"] as const;

const ALLOWED_SCHEMAS = new Set<string>(NOVA_PROVIDER_SCHEMAS);
const IDENTIFIER = `(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)`;
const SCHEMA_REFERENCE_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `\\b(?:create|alter|drop)\\s+schema\\s+(?:(?:if\\s+(?:not\\s+)?exists)\\s+)?(?<schema>${IDENTIFIER})`,
    "gi"
  ),
  new RegExp(
    `\\b(?:from|join|into|update|references|copy)\\s+(?:only\\s+)?(?<schema>${IDENTIFIER})\\s*\\.\\s*${IDENTIFIER}`,
    "gi"
  ),
  new RegExp(
    `\\b(?:create|alter|drop|comment\\s+on|security\\s+label\\s+on)\\s+(?:or\\s+replace\\s+)?(?:table|view|materialized\\s+view|sequence|index|function|procedure|type|domain|trigger)\\s+(?:concurrently\\s+)?(?:if\\s+(?:not\\s+)?exists\\s+)?(?<schema>${IDENTIFIER})\\s*\\.`,
    "gi"
  ),
  new RegExp(
    `\\bcreate\\s+(?:unique\\s+)?index\\b[\\s\\S]{0,240}?\\bon\\s+(?:only\\s+)?(?<schema>${IDENTIFIER})\\s*\\.\\s*${IDENTIFIER}`,
    "gi"
  ),
  new RegExp(
    `\\bcreate\\s+(?:or\\s+replace\\s+)?(?:constraint\\s+)?trigger\\b[\\s\\S]{0,500}?\\bon\\s+(?:only\\s+)?(?<schema>${IDENTIFIER})\\s*\\.\\s*${IDENTIFIER}`,
    "gi"
  ),
  new RegExp(`\\b(?:in|on)\\s+schema\\s+(?<schema>${IDENTIFIER})`, "gi"),
  new RegExp(`(?<![a-z0-9_$])(?<schema>${IDENTIFIER})\\s*\\.\\s*${IDENTIFIER}\\s*\\(`, "gi"),
  new RegExp(`::\\s*(?<schema>${IDENTIFIER})\\s*\\.\\s*${IDENTIFIER}`, "gi"),
  new RegExp(
    `['"](?<schema>[a-z_][a-z0-9_$]*)\\s*\\.\\s*[a-z_][a-z0-9_$]*['"]\\s*::\\s*(?:regclass|regtype|regprocedure)`,
    "gi"
  )
];

const SEARCH_PATH_PATTERN = /\bset\s+(?:(?:local|session)\s+)?search_path\s*(?:=|to)\s*(?<schemas>[^;]+)/gi;
const SET_CONFIG_SEARCH_PATH_PATTERN = /\b(?:pg_catalog\s*\.\s*)?set_config\s*\(\s*['"]search_path['"]\s*,/i;
const DYNAMIC_SCHEMA_IDENTIFIER_PATTERN = /%I\s*\.\s*(?:%I|[a-z_][a-z0-9_$]*|"[^"]+")/i;

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\r\n]*/g, " ");
}

function normalizeIdentifier(identifier: string): string {
  if (identifier.startsWith('"')) return identifier.slice(1, -1).replaceAll('""', '"');
  return identifier.toLowerCase();
}

function referencedSchemas(sql: string): Set<string> {
  const schemas = new Set<string>();
  for (const pattern of SCHEMA_REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of sql.matchAll(pattern)) {
      const schema = match.groups?.schema;
      if (schema) schemas.add(normalizeIdentifier(schema));
    }
  }

  SEARCH_PATH_PATTERN.lastIndex = 0;
  for (const match of sql.matchAll(SEARCH_PATH_PATTERN)) {
    for (const value of (match.groups?.schemas ?? "").split(",")) {
      const identifier = value.trim().match(new RegExp(`^${IDENTIFIER}$`, "i"))?.[0];
      schemas.add(identifier ? normalizeIdentifier(identifier) : "<dynamic search_path>");
    }
  }
  if (SET_CONFIG_SEARCH_PATH_PATTERN.test(sql)) schemas.add("<dynamic search_path>");
  if (DYNAMIC_SCHEMA_IDENTIFIER_PATTERN.test(sql)) schemas.add("<dynamic schema>");
  return schemas;
}

/** Reject provider migrations that can address a schema outside the NOVA cell. */
export function assertNovaProviderSqlUsesAllowedSchemas(name: string, sql: string): void {
  const foreignSchemas = [...referencedSchemas(stripComments(sql))]
    .filter((schema) => !ALLOWED_SCHEMAS.has(schema))
    .sort();
  if (foreignSchemas.length > 0) {
    throw new Error(
      `NOVA migration ${name} references schemas outside the provider allowlist: ${foreignSchemas.join(", ")}`
    );
  }
}

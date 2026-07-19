const ALLOWED_SCHEMAS = new Set(["access_runtime", "platform"]);

const ALLOWED_DYNAMIC_DATABASE_STATEMENTS = [
  /^revoke all privileges on database %I from (?:public|hyperion_identity|hyperion_tenant)$/i,
  /^grant connect on database %I to (?:hyperion_identity|hyperion_tenant)$/i
] as const;

export function assertAccessProviderSqlUsesAllowedSchemas(filename: string, sql: string): void {
  const withoutComments = stripSqlComments(sql);
  const withoutHardenedFunctionSearchPath = withoutComments.replace(
    /\blanguage\s+plpgsql\s+set\s+search_path\s*=\s*pg_catalog\s+as\b/gi,
    "language plpgsql as"
  );
  if (
    /\bset\s+(?:local\s+)?search_path\b/i.test(withoutHardenedFunctionSearchPath) ||
    /\bset_config\s*\(/i.test(withoutComments)
  ) {
    throw new Error(`Access migration ${filename} must not change search_path`);
  }
  if (/\breset\s+(?:all|search_path)\b/i.test(withoutComments) || /\bset\s+schema\b/i.test(withoutComments)) {
    throw new Error(`Access migration ${filename} must not reset or replace the hardened search_path`);
  }
  if (
    /\bset\s+(?:local\s+)?role\b/i.test(withoutComments) ||
    /\bset\s+session\s+authorization\b/i.test(withoutComments)
  ) {
    throw new Error(`Access migration ${filename} must not change the database session identity`);
  }
  if (/\b(?:do|as)\s+(?:e|u&)?'(?:''|[^'])*'/i.test(withoutComments)) {
    throw new Error(`Access migration ${filename} must use inspectable dollar-quoted executable bodies`);
  }

  assertOnlyAllowlistedDynamicSql(filename, withoutComments);
  if (
    /\b(?:(?:query|table|schema|database|cursor)_to_xml(?:schema|_and_xmlschema)?|dblink(?:_[a-z0-9_]+)?|(?:next|curr|set)val|pg_get_serial_sequence|to_reg[a-z0-9_]*)\s*\(/i.test(
      withoutComments
    ) ||
    /::\s*(?:pg_catalog\.)?reg(?:class|collation|config|dictionary|namespace|oper|operator|procedure|role|type)\b/i.test(
      withoutComments
    ) ||
    /\bcopy\b/i.test(withoutComments)
  ) {
    throw new Error(`Access migration ${filename} contains a forbidden dynamic evaluator or COPY statement`);
  }

  // Provider migrations deliberately use unquoted, lowercase identifiers. A
  // quoted identifier could make a case-sensitive schema escape invisible to
  // the static qualified-name allowlist below. Single-quoted values are masked;
  // dollar-quoted PL/pgSQL bodies remain visible because they are executable.
  const executable = maskSingleQuotedStrings(withoutComments);
  if (executable.includes('"')) {
    throw new Error(`Access migration ${filename} must not use quoted identifiers`);
  }

  const triggerPseudoRecord = /\b(?:new|old)\s*\.\s*[a-z_][a-z0-9_]*/gi;
  const hasTriggerPseudoRecord = triggerPseudoRecord.test(executable);
  triggerPseudoRecord.lastIndex = 0;
  const definesTriggerFunction = /\breturns\s+trigger\b/i.test(executable);
  if (
    hasTriggerPseudoRecord &&
    (!definesTriggerFunction || /\b(?:from|join|into|table|references|truncate)\s+(?:new|old)\s*\./i.test(executable))
  ) {
    throw new Error(`Access migration ${filename} contains an invalid trigger pseudo-record reference`);
  }
  const qualifiedSource = definesTriggerFunction
    ? executable.replace(triggerPseudoRecord, "trigger_record_field")
    : executable;
  const qualifiedIdentifiers = [...qualifiedSource.matchAll(/\b([a-z_][a-z0-9_]*)\s*\./gi)].map((match) =>
    match[1]!.toLowerCase()
  );
  const forbidden = [...new Set(qualifiedIdentifiers.filter((schema) => !ALLOWED_SCHEMAS.has(schema)))].sort();
  if (forbidden.length > 0) {
    throw new Error(`Access migration ${filename} references forbidden schemas: ${forbidden.join(", ")}`);
  }
  if (/\bplatform\.schema_migrations\b/i.test(executable)) {
    throw new Error(`Access migration ${filename} references the legacy global migration ledger`);
  }

  const schemaDdl = [
    ...executable.matchAll(/\b(?:create|alter|drop)\s+schema(?:\s+if\s+(?:not\s+)?exists)?\s+([a-z_][a-z0-9_]*)/gi)
  ].map((match) => match[1]!.toLowerCase());
  const forbiddenDdl = [...new Set(schemaDdl.filter((schema) => !ALLOWED_SCHEMAS.has(schema)))].sort();
  if (forbiddenDdl.length > 0) {
    throw new Error(`Access migration ${filename} changes forbidden schemas: ${forbiddenDdl.join(", ")}`);
  }

  const persistentDdl = [
    ...executable.matchAll(
      /\b(?:create|alter|drop)\s+(?:table|view|materialized\s+view|function|procedure|sequence|type)\s+(?:if\s+(?:not\s+)?exists\s+)?([a-z_][a-z0-9_]*)(\s*\.)?/gi
    )
  ];
  if (persistentDdl.some((match) => match[2] === undefined)) {
    throw new Error(`Access migration ${filename} contains unqualified persistent-object DDL`);
  }
}

function assertOnlyAllowlistedDynamicSql(filename: string, sql: string): void {
  // GRANT/REVOKE EXECUTE ON FUNCTION and CREATE TRIGGER ... EXECUTE FUNCTION
  // are static object references, not dynamic PL/pgSQL execution.
  const executeTokens = [...sql.matchAll(/\bexecute\b(?!\s+(?:on|function|procedure)\b)/gi)];
  if (executeTokens.length === 0) return;

  const allowlisted = [
    ...sql.matchAll(/\bexecute\s+format\s*\(\s*'((?:''|[^'])*)'\s*,\s*current_database\s*\(\s*\)\s*\)/gi)
  ];
  if (allowlisted.length !== executeTokens.length) {
    throw new Error(`Access migration ${filename} contains non-allowlisted dynamic SQL`);
  }
  for (const match of allowlisted) {
    const statement = match[1]!.replaceAll("''", "'").replace(/\s+/g, " ").trim();
    if (!ALLOWED_DYNAMIC_DATABASE_STATEMENTS.some((pattern) => pattern.test(statement))) {
      throw new Error(`Access migration ${filename} contains non-allowlisted dynamic SQL`);
    }
  }
}

function stripSqlComments(sql: string): string {
  let result = "";
  let index = 0;
  let singleQuoted = false;
  while (index < sql.length) {
    if (singleQuoted) {
      const character = sql[index]!;
      result += character;
      if (character === "'" && sql[index + 1] === "'") {
        result += "'";
        index += 2;
        continue;
      }
      if (character === "'") singleQuoted = false;
      index += 1;
      continue;
    }
    if (sql[index] === "'") {
      singleQuoted = true;
      result += "'";
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      if (newline === -1) break;
      result += " ".repeat(newline - index) + "\n";
      index = newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) throw new Error("Unterminated SQL block comment");
      result += " ".repeat(end + 2 - index);
      index = end + 2;
      continue;
    }
    result += sql[index]!;
    index += 1;
  }
  return result;
}

function maskSingleQuotedStrings(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''");
}

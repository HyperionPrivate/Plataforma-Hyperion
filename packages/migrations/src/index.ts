import { fileURLToPath } from "node:url";
import { assertNoPlaceholderSecrets } from "@hyperion/config";
import { createLogger } from "@hyperion/logger";
import { runMigrations } from "./runner.js";

const logger = createLogger("migrations");

assertNoPlaceholderSecrets(process.env);

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  logger.error("DATABASE_URL is required");
  process.exit(1);
}

const sqlDir = fileURLToPath(new URL("../sql", import.meta.url));

try {
  const result = await runMigrations(databaseUrl, sqlDir);
  logger.info("migrations completed", {
    applied: result.applied,
    skippedCount: result.skipped.length
  });
} catch (error) {
  logger.error("migrations failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

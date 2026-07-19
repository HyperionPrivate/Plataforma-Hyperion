import { registerRollbackVerifierTests } from "./rollback-verifier-test-helper.mjs";

registerRollbackVerifierTests({ cell: "lumen", expectedImageCount: 3, expectedMigrationCount: 2 });

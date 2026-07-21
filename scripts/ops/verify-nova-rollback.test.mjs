import { registerRollbackVerifierTests } from "./rollback-verifier-test-helper.mjs";

registerRollbackVerifierTests({ cell: "nova", expectedImageCount: 7, expectedMigrationCount: 9 });

import { registerRollbackVerifierTests } from "./rollback-verifier-test-helper.mjs";

registerRollbackVerifierTests({ cell: "pulso", expectedImageCount: 8, expectedMigrationCount: 5 });

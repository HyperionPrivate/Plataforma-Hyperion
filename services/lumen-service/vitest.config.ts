import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration files share the configured PostgreSQL database. LUMEN's
    // cluster-wide orphan readiness invariant intentionally observes every
    // owner, so parallel files could mistake another test's in-flight attempt
    // for an abandoned workload.
    fileParallelism: false
  }
});

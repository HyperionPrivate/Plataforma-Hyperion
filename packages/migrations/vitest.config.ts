import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PostgreSQL roles are cluster-scoped even when integration cases use
    // separate temporary databases. Serial files prevent one migration fence
    // from changing LOGIN state while another case is exercising a role.
    fileParallelism: false
  }
});

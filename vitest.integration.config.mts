import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Integration tests talk to a real PostgreSQL instance (see DATABASE_URL).
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // These tests empty the tables: refuse to run against a real ingestion.
    globalSetup: ["tests/integration/global-setup.ts"],
    // Every file works on the same database, so run them one after another.
    fileParallelism: false,
  },
});

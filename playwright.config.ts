import { defineConfig, devices } from "@playwright/test";

import { e2eDatabaseUrls } from "./tests/e2e/support/database";

/**
 * Browser tests of the page (`npm run test:e2e`). They need the PostgreSQL
 * server of `docker compose up -d db` and nothing else: the models are a fake
 * server (`tests/e2e/support/fake-models.ts`), and the data is the nine fixture
 * regulations, loaded into a database of their own (`normativa_e2e`).
 */
const APP_PORT = 3100;
const MODELS_PORT = 11500;

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // The tests share one server and one database: one at a time keeps them apart.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // A browser already on the machine, instead of `npx playwright install`.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: [
    {
      command: `npx tsx tests/e2e/support/fake-models.ts ${MODELS_PORT}`,
      url: `http://127.0.0.1:${MODELS_PORT}`,
      reuseExistingServer: false,
    },
    {
      // The production build: what is tested is what would be deployed.
      command: `npm run build && npm run start -- --port ${APP_PORT}`,
      url: `http://localhost:${APP_PORT}/es`,
      timeout: 300_000,
      reuseExistingServer: false,
      // These win over `.env`: no test reaches the real corpus or a real model.
      env: {
        DATABASE_URL: e2eDatabaseUrls().e2e,
        OLLAMA_BASE_URL: `http://127.0.0.1:${MODELS_PORT}`,
        EMBEDDING_MODEL: "test-hashing",
        CHAT_PROVIDER: "ollama",
        OLLAMA_CHAT_MODEL: "fake",
        GEMINI_API_KEY: "",
        CHAT_API_KEY: "",
        // No limit per minute: the tests ask more often than a reader would.
        ANSWER_LIMIT_PER_CLIENT: "0",
        ANSWER_LIMIT_TOTAL: "0",
      },
    },
  ],
});

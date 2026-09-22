const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4175", headless: true, serviceWorkers: "block",
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: { command: "node tests/support/static-server.cjs", url: "http://127.0.0.1:4175", reuseExistingServer: false }
});

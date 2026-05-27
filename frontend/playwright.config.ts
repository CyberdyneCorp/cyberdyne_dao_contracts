import {defineConfig, devices} from "@playwright/test";

// E2E for the toy frontend against a LOCAL forked chain with the DAO deployed.
//
// Prereq: bring the stack up first — `just demo-up` (anvil fork + deploy +
// seed). globalSetup verifies it's reachable and fails fast with guidance if
// not. Playwright then starts the Vite dev server itself (webServer below).
const PORT = Number(process.env.E2E_PORT || 4317);

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  timeout: 90_000,
  expect: {timeout: 15_000},
  fullyParallel: false, // shared chain state — run specs serially
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", {open: "never", outputFolder: "playwright-report"}]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{name: "chromium", use: {...devices["Desktop Chrome"]}}],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

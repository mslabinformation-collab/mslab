import { defineConfig, devices } from "@playwright/test";
import { LOCAL_ENV } from "./tests/local-secrets";
import { GATE_PORT, GATE_PREVIEW_SECRET, GATE_URL } from "./tests/e2e/gate";

// The coming-soon gate (hotfix 08.10) against a real server: `npx playwright test -c playwright.gate.config.ts`. The main
// e2e run's server has no gate (the site as it is), so this run builds the working tree and starts it on its own port
// (tests/e2e/gate.ts) with SITE_GATE=1, a made-up PREVIEW_SECRET and the local settings; never a server that is already
// running (it would not have the gate). No global setup: it reads the local database, and writes only one newsletter
// sign-up and one admin sign-in of the placeholder addresses, which the spec deletes again. The mail and Telegram keys
// are blanked (blank counts as not set): nothing is sent. Payments are on with the e2e run's made-up Montonio keys (no fake server is
// started: the gate tests never create an order).

process.env.E2E_SITE_GATE = "1"; // tests/e2e/gate.ts gateRun(): gate.spec.ts runs (it skips in the main run)
process.env.E2E_BASE_URL = GATE_URL; // tests/e2e/target.ts and fixtures.ts: a local server, not the dev server

const chrome = devices["Desktop Chrome"];

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "gate.spec.ts",
  outputDir: "test-results/gate",
  timeout: 60_000,
  use: { baseURL: GATE_URL },
  projects: [
    { name: "w1440", use: { ...chrome, viewport: { width: 1440, height: 900 } } },
    { name: "w834", use: { ...chrome, viewport: { width: 834, height: 1112 }, hasTouch: true } },
    { name: "w390", use: { ...chrome, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: `npm run build && npm run start -- --port ${GATE_PORT}`,
    url: `${GATE_URL}/robots.txt`,
    reuseExistingServer: false,
    timeout: 600_000,
    env: {
      ...LOCAL_ENV,
      SITE_URL: GATE_URL,
      SITE_GATE: "1",
      PREVIEW_SECRET: GATE_PREVIEW_SECRET,
      RESEND_API_KEY: "",
      TELEGRAM_BOT_TOKEN: "",
      PAYMENT_MOCK_IN_PRODUCTION: "1", // payments on (the fake Montonio's keys of LOCAL_ENV): the payment routes answer as the app's, not 404
    },
  },
});

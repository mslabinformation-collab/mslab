import type { PlaywrightTestConfig } from "@playwright/test";
import { LOCAL_ENV } from "../local-secrets";
import { E2E_BUNNY } from "./bunny-values";
import { E2E_MONTONIO } from "./montonio-values";
import { PROD_ENV } from "./prod-build";
import { LOCAL_URL, PROD_BUILD, PROD_PORT, PROD_URL, TARGET } from "./target";

/**
 * On top of LOCAL_ENV for `next dev`: its own address as the site's (SITE_URL), as the production build has its own (prod-build.ts
 * PROD_ENV). Montonio's webhook is always sent to SITE_URL (server/payments/start.ts StartDeps.notifyBase, never the request's origin), and
 * the fake Montonio posts it only to this machine: with the public SITE_URL of .env.example, the "bank confirms later" webhook of the e2e run
 * would never reach the dev server.
 */
export const DEV_ENV = { SITE_URL: LOCAL_URL };

/**
 * The server both Playwright configs start (tests/e2e/target.ts):
 * - E2E_PROD_BUILD=1: a fresh production build of the working tree, `next build && next start` on PROD_URL, with the
 *   local settings and the production build's switches (prod-build.ts). Never a server that is already running: it
 *   would not be this build, or not have the switches;
 * - a deployment (E2E_BASE_URL): none;
 * - otherwise `next dev` on LOCAL_URL; a dev server already running is used as it is.
 * The local settings (the local database and the placeholder admin allow-list of .env.example that the tests sign in
 * with) win over a .env.local of your own.
 * Both local modes also start the fake Bunny Stream (fake-bunny.ts) on E2E_BUNNY.port (3998, or E2E_BUNNY_PORT when that
 * port is taken), which the local settings point the app's video calls at; one that is already running there is used.
 * Both local modes also start the fake Montonio (fake-montonio.ts) on E2E_MONTONIO.port (3997, or E2E_MONTONIO_PORT), which the local
 * settings point the payments at (PAYMENT_PROVIDER=mock).
 */
export function e2eWebServer(): PlaywrightTestConfig["webServer"] {
  const bunny = { command: "npx tsx tests/e2e/fake-bunny.ts", url: `${E2E_BUNNY.url}/health`, reuseExistingServer: !process.env.CI, timeout: 30_000 };
  const montonio = { command: "npx tsx tests/e2e/fake-montonio.ts", url: `${E2E_MONTONIO.url}/health`, reuseExistingServer: !process.env.CI, timeout: 30_000 };
  if (PROD_BUILD)
    return [{ command: `npm run build && npm run start -- --port ${PROD_PORT}`, url: PROD_URL, reuseExistingServer: false, timeout: 600_000, env: { ...LOCAL_ENV, ...PROD_ENV } }, bunny, montonio];
  if (TARGET) return undefined;
  return [{ command: "npm run dev", url: LOCAL_URL, reuseExistingServer: !process.env.CI, timeout: 180_000, env: { ...LOCAL_ENV, ...DEV_ENV } }, bunny, montonio];
}

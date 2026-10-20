import { defineConfig, devices } from "@playwright/test";
import { e2eWebServer } from "./tests/e2e/server";
import { LOCAL_URL, TARGET } from "./tests/e2e/target";

// E2E_BASE_URL (or BASE_URL) = a deployment, read-only; E2E_PROD_BUILD=1 = the local production build; else the local
// dev server (tests/e2e/target.ts)
const baseURL = TARGET || LOCAL_URL;

const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };
const phone = { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/**
 * Specs that change the public site's content (a seed course's title, badge, gallery and order; sessions in the
 * calendar; hero slides, FAQ, practice packages, the trainer page, posts, the campaign and settings). They restore
 * everything afterwards, but while they run another test could see the change (the catalogue counts 6 cards, the
 * calendar 8 rows, the hero 5 slides). So they run after all other tests: "chromium-edit" and "mobile-edit" are the
 * teardown projects of "before-edits-*", on which "chromium" and "mobile" depend, and a teardown starts only when every
 * project depending on its setup has finished. Unlike `dependencies`, a teardown also runs when an earlier test failed.
 * contracts.spec.ts is one of them (contracts Task 7): it writes the contact contract's text and the seller card, which every registration reads.
 * reviews-public.spec.ts is one too (student reviews, Task 5): it writes published and featured reviews, which the course pages and the home page show.
 * So is reviews.spec.ts (Task 6), the whole path of one review: it publishes and features one, and adds one of Maria's own. (reviews-race.spec.ts is not:
 * it talks to the database in its own process and no page shows what it writes.)
 * And newsletter-campaigns.spec.ts (the simple newsletter, Task 5): its real send mails every confirmed subscriber there is (the ones other specs leave in the
 * database until the run's teardown among them), so it runs after them. (newsletter-race.spec.ts is not: it has a scratch database of its own.)
 */
const EDITS = /(admin-(edit|site)\.spec\.ts|[\\/]contracts\.spec\.ts|[\\/]reviews(-public)?\.spec\.ts|[\\/]newsletter-campaigns\.spec\.ts)$/;
const ORDER = /order\.setup\.ts$/;
/** The visual suite has its own config: playwright.visual.config.ts (npm run visual). */
const VISUAL = /[\\/]visual[\\/]/;

export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.spec.ts",
  // Seat fixtures (full / few sessions) in the local dev DB for the calendar tests; removed again afterwards.
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: { baseURL },
  projects: [
    { name: "before-edits-desktop", testMatch: ORDER, teardown: "chromium-edit" },
    { name: "before-edits-mobile", testMatch: ORDER, teardown: "mobile-edit" },
    { name: "chromium", use: desktop, testIgnore: [EDITS, VISUAL], dependencies: ["before-edits-desktop", "before-edits-mobile"] },
    { name: "mobile", use: phone, testIgnore: [EDITS, VISUAL], dependencies: ["before-edits-desktop", "before-edits-mobile"] },
    { name: "chromium-edit", use: desktop, testMatch: EDITS },
    { name: "mobile-edit", use: phone, testMatch: EDITS },
  ],
  // `next dev`, or the production build (E2E_PROD_BUILD=1), with the local settings; none for a deployment
  webServer: e2eWebServer(),
});

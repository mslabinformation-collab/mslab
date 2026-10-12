import { holdLocalLock } from "./fixtures";
import { PROD_BUILD } from "./target";
import { test as base } from "./test";

/** How long a content test waits for its turn: the other project's test in front of it, one test (about 10 s, the slowest 30). */
const TURN_WAIT_MS = 120_000;

/**
 * `test` of the content editors' specs (admin-edit.spec.ts, admin-site.spec.ts) in the production build: one test at a time across both edit
 * projects ("chromium-edit" and "mobile-edit" run side by side). They change different rows, but they share the build's page cache: a test writes
 * to the database, marks every cached page stale (prod-build.ts) and loads the page it changed, and a page that the OTHER project's test was
 * rendering at that moment, from rows read before the write, is stored after the mark — or is the very render the test's own request joins (Next.js
 * answers requests for one page that overlap with one render) — and so the test sees the old content. Over twenty runs of the edit phase that
 * failed one in four (the home page's popup tests, the trainer page's text), never when the projects took turns (`--workers=1`). Under `next dev`
 * every request renders from the database, nothing is cached and nothing is shared, so there the tests still run side by side.
 *
 * The turn is a Postgres advisory lock (fixtures.ts holdLocalLock), taken when the test is set up and let go when its fixtures are torn down: the
 * test and its afterEach hooks (the restores of the rows it changed) are over by then, before the next test's turn.
 */
export const test = base.extend<{ editTurn: void }>({
  editTurn: [
    async ({}, provide, info) => {
      if (!PROD_BUILD) return provide();
      info.setTimeout(info.timeout + TURN_WAIT_MS);
      const release = await holdLocalLock("e2e-edit-content", TURN_WAIT_MS);
      try {
        await provide();
      } finally {
        await release();
      }
    },
    { auto: true },
  ],
});

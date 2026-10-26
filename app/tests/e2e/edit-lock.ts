import { holdLocalLock, LOCK_WAIT_MS, PRACTICE_DRAFTS_LOCK, removePracticeDrafts } from "./fixtures";
import { PROD_BUILD } from "./target";
import { test as base } from "./test";

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
 *
 * `practiceDrafts` (`test.use({ practiceDrafts: true })`): the test makes drafts of Praktika's packages, so it takes the practice turn as well
 * (fixtures.ts PRACTICE_DRAFTS_LOCK) — under `next dev` too, since a publish or a discard there acts on every practice draft, whoever made it. The turn
 * is taken after the edit turn and given back before it (no two tests ever wait for each other's), and at its end every practice draft goes.
 */
export const test = base.extend<{ editTurn: void; practiceDrafts: boolean; practiceTurn: void }>({
  editTurn: [
    async ({}, provide, info) => {
      if (!PROD_BUILD) return provide();
      // (the wait for the turn is added to the test's own time: with 8 workers up to three tests of both projects can be ahead, about 10 s each, the
      // slowest 30 s; LOCK_WAIT_MS, the 3 minutes every lock of these tests waits, is room for a queue several times that)
      info.setTimeout(info.timeout + LOCK_WAIT_MS);
      const release = await holdLocalLock("e2e-edit-content", LOCK_WAIT_MS);
      try {
        await provide();
      } finally {
        await release();
      }
    },
    { auto: true },
  ],
  practiceDrafts: [false, { option: true }],
  practiceTurn: [
    async ({ practiceDrafts, editTurn }, provide, info) => {
      void editTurn; // (set up first, torn down last: the edit turn is always taken before this one)
      if (!practiceDrafts) return provide();
      info.setTimeout(info.timeout + LOCK_WAIT_MS);
      const release = await holdLocalLock(PRACTICE_DRAFTS_LOCK, LOCK_WAIT_MS);
      try {
        await provide();
      } finally {
        try {
          await removePracticeDrafts();
        } finally {
          await release();
        }
      }
    },
    { auto: true },
  ],
});

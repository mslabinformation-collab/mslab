import type { TestInfo } from "@playwright/test";
import { holdLocalLock, LOCK_WAIT_MS, PRACTICE_DRAFTS_LOCK, removePracticeDrafts, removeTrainerDrafts, TRAINER_DRAFTS_LOCK } from "./fixtures";
import { PROD_BUILD } from "./target";
import { test as base } from "./test";

/** A test's turn on one site entity's drafts (`lock`), from its set-up until its fixtures are torn down: its drafts gone at both ends. */
async function draftsTurn(lock: string, remove: () => Promise<number>, provide: () => Promise<void>, info: TestInfo): Promise<void> {
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  const release = await holdLocalLock(lock, LOCK_WAIT_MS);
  try {
    await remove();
    await provide();
  } finally {
    try {
      await remove();
    } finally {
      await release();
    }
  }
}

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
 * is taken after the edit turn and given back before it (no two tests ever wait for each other's). Every practice draft goes when the turn is taken
 * (one a run killed half-way left behind, whose teardown never ran — review M-5) and again at its end.
 *
 * `trainerDrafts` (piece 4a, Task 5): the same for Koolitaja's drafts (fixtures.ts TRAINER_DRAFTS_LOCK), taken after the practice turn and given back
 * before it, so the turns are always taken in one order. Its value may name the one project whose run of the test makes the drafts ("chromium-edit"):
 * the other project's run, which skips itself in its body, takes no turn (the fixtures are set up before the body, so it would wait for nothing).
 */
export const test = base.extend<{ editTurn: void; practiceDrafts: boolean; practiceTurn: void; trainerDrafts: boolean | "chromium-edit" | "mobile-edit"; trainerTurn: void }>({
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
      await draftsTurn(PRACTICE_DRAFTS_LOCK, removePracticeDrafts, provide, info);
    },
    { auto: true },
  ],
  trainerDrafts: [false, { option: true }],
  trainerTurn: [
    async ({ trainerDrafts, practiceTurn }, provide, info) => {
      void practiceTurn; // (after the edit and the practice turns, and given back before them: one order for every test)
      if (!trainerDrafts || (trainerDrafts !== true && trainerDrafts !== info.project.name)) return provide();
      await draftsTurn(TRAINER_DRAFTS_LOCK, removeTrainerDrafts, provide, info);
    },
    { auto: true },
  ],
});

import { test } from "./test";

// The newsletter on real Postgres (newsletter campaigns, Task 5): the race tests of the Resend list machinery (the sync's lease and the broadcast's
// row lock) went with that machinery (the 20.10 design: docs/superpowers/specs/2026-10-20-newsletter-simple-design.md). Task 5 of its plan rewrites
// this file for the simple send: the press and the daily job at once on a scratch database (scratch-db.ts, race.ts), each waiting row sent once and
// the counts exact, and a mutation check of `FOR UPDATE SKIP LOCKED`. Until then it holds this one skipped test, so that the file's place stays.

test.skip("the press and the daily job at once send each waiting row once (rewritten in Task 5 of the newsletter plan)", async () => {});

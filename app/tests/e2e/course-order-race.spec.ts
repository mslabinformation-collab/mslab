import postgres from "postgres";
import type { Db } from "../../src/db/client";
import { moveCourseTo } from "../../src/db/queries/admin";
import { inFlight, racePool, type OnDb } from "./race";
import { createScratchDatabase, type Scratch } from "./scratch-db";
import { expect, submitsForms, test } from "./test";

// The course list's move on real Postgres (B1 Koolitused, piece 3a, Task 3 fix round; the review's M-2): what the unit tests' single-connection PGlite cannot show,
// because it runs one transaction at a time. The app's own moveCourseTo, in this process, on a pool of a SCRATCH database (scratch-db.ts: made on the local server,
// migrated with the app's migrations, dropped afterwards), so the order of the local test database's own courses is never touched.
//
// Two moves at the same moment (two tabs, or Dim and Maria): each is made on the order the other left. A `select … order by sort, id for update` does not give that:
// under READ COMMITTED a transaction that waited for the other's row locks gets the rows' new values in the order it had worked out before it waited, and so
// applies its move to the old order and overwrites the other's. moveCourseTo locks first (`order by id`, a key no move changes) and reads the order in a second
// statement. "At the same moment" is proven, not hoped for (race.ts inFlight): another connection holds the courses' row locks while both moves start, and lets
// them go only once this pool shows both waiting. They stand in the lock's queue in the order started, so which goes first is the test's. Run against the
// one-statement form it ends in the wrong order, and the test says so.
// Nothing here depends on the screen: the desktop project runs these once.

test.skip(({ isMobile }) => isMobile, "nothing here depends on the screen: the desktop project runs these once");

const APPLICATION = `mslab-e2e-course-order-race-${process.pid}`;

let scratch: Scratch;
let pool: postgres.Sql;
let db: Db;
/** A connection of its own to the scratch database: the tests' reads and writes and the lock `inFlight` holds. */
let other: postgres.Sql;
/** Where the lock is held: the scratch database (race.ts inFlight defaults to the local test database). */
const onScratch: OnDb = (work) => work(other);

test.beforeAll(async () => {
  test.setTimeout(120_000);
  scratch = await createScratchDatabase("courseorder");
  ({ pool, db } = racePool(APPLICATION, scratch.url, 5));
  other = postgres(scratch.url, { max: 4, connect_timeout: 20, onnotice: () => {} });
});
test.afterAll(async () => {
  await pool?.end();
  await other?.end();
  await scratch?.drop();
});
test.beforeEach(async () => {
  submitsForms();
  test.setTimeout(60_000);
  await other`truncate table courses restart identity cascade`;
});

/** Five courses a to e, in that order (sort 1 to 5); their ids by slug. */
async function fiveCourses(): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};
  for (const [i, slug] of ["a", "b", "c", "d", "e"].entries()) {
    const [row] = await other<{ id: number }[]>`
      insert into courses (slug, type, level, title, summary, body, sort)
      values (${slug}, 'contact', 'basic', ${other.json({ et: slug })}, ${other.json({ et: "" })}, ${other.json({ et: "" })}, ${i + 1})
      returning id`;
    ids[slug] = row.id;
  }
  return ids;
}

const order = async () => (await other<{ slug: string; sort: number }[]>`select slug, sort from courses order by sort, id`).map((r) => [r.slug, r.sort] as const);

test("two moves at once are both kept, in the order they were started: the second is made on the order the first left", async () => {
  const id = await fiveCourses();
  const answers = await inFlight(
    APPLICATION,
    async (tx) => {
      await tx`select id from courses order by id for update`;
    },
    () => moveCourseTo(db, id.c, 0), // c first: c a b d e
    () => moveCourseTo(db, id.a, 99), // then a last, on THAT order: c b d e a
    onScratch,
  );
  expect(answers).toEqual(["ok", "ok"]);
  expect(await order()).toEqual([["c", 1], ["b", 2], ["d", 3], ["e", 4], ["a", 5]]);
});

test("in the other order too, and with a move to a place in the middle", async () => {
  const id = await fiveCourses();
  const answers = await inFlight(
    APPLICATION,
    async (tx) => {
      await tx`select id from courses order by id for update`;
    },
    () => moveCourseTo(db, id.a, 99), // b c d e a
    () => moveCourseTo(db, id.e, 1), // e into place 2, on THAT order: b e c d a
    onScratch,
  );
  expect(answers).toEqual(["ok", "ok"]);
  expect(await order()).toEqual([["b", 1], ["e", 2], ["c", 3], ["d", 4], ["a", 5]]);
});

test("the answer is the same when nothing is held: ten moves from two sets of tabs, every course once and the sorts 1 to 5", async () => {
  const id = await fiveCourses();
  const slugs = ["a", "b", "c", "d", "e"];
  await Promise.all(Array.from({ length: 10 }, (_, i) => moveCourseTo(db, id[slugs[i % 5]], (i * 3) % 5)));
  const after = await order();
  expect(after.map(([slug]) => slug).sort()).toEqual(slugs);
  expect(after.map(([, sort]) => sort)).toEqual([1, 2, 3, 4, 5]);
});

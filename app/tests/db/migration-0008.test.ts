import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { clients, courseAccess, courses, courseTests, practicalPhotos, protocols, registrations, testAttempts } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0008 (e-course completion) as the Railway database goes through it: 0000–0007 applied, a contact course with a registration and
// its protocol, and an e-course with an access, all written by the live code (which knows none of 0008's columns), then 0008. The protocol
// stays a registration's (no access, no verdicts, round 0), the access gets no extra tries and no completion, and the three new tables are
// there, empty, with their rules: a protocol has exactly one owner and an access at most one protocol, the test's pass mark and tries within
// their ranges, one attempt per number, and the account's deletion takes the access, its protocol and photos, and the attempts with it.
// A rule that fails is checked by the name of the constraint in the database's own error, so that another failure cannot pass for it.

/** The statement fails, and the database names `constraint` in its error (drizzle puts it in `cause`). */
async function violates(statement: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(statement).then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error, `a failure on ${constraint}`).not.toBeNull();
  expect(error!.cause?.message ?? error!.message).toContain(`"${constraint}"`);
}

test("0008 keeps every protocol a registration's, gives every access no extra tries and no completion, and adds the test and photo tables with their rules", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0007_protocols");
  // the live code's rows (raw SQL: drizzle would name the columns 0008 adds)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price_group, protocol_stages) values ('k', 'contact', 'basic', '{"et":"K"}', '{"et":""}', '{"et":""}', 35000, '["Ettevalmistus"]')`);
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price, protocol_stages) values ('e', 'e_learning', 'basic', '{"et":"E"}', '{"et":""}', '{"et":""}', 9900, '["Punkt 1","Punkt 2"]')`);
  const id = Object.fromEntries((await db.select({ id: courses.id, slug: courses.slug }).from(courses)).map((c) => [c.slug, c.id]));
  await db.execute(sql`insert into clients (email) values ('kati@example.test')`);
  const [{ id: clientId }] = await db.select({ id: clients.id }).from(clients);
  for (const email of ["kati@example.test", "mari@example.test"])
    await db.execute(sql`insert into registrations (course_id, kind, name, email, payment_choice, client_id) values (${id.k}, 'individual', 'X', ${email}, 'full', ${email === "kati@example.test" ? clientId : null})`);
  const regs = Object.fromEntries((await db.select({ id: registrations.id, email: registrations.email }).from(registrations)).map((r) => [r.email, r.id]));
  await db.execute(sql`insert into protocols (registration_id, stages, general_note, version) values (${regs["kati@example.test"]}, '[{"title":"Ettevalmistus","note":"Hästi"}]', 'Tubli', 3)`);
  await db.execute(sql`insert into course_access (client_id, course_id, granted_by, expires_at) values (${clientId}, ${id.e}, 'payment', '2027-04-13T00:00:00Z')`);

  await through("0008_ecourse_completion");

  // what was there: the protocol stays the registration's, as it was; the access is not completed and has no extra tries
  const [old] = await db.select().from(protocols);
  expect(old).toMatchObject({ registrationId: regs["kati@example.test"], accessId: null, generalNote: "Tubli", version: 3, verdicts: [], round: 0, submittedAt: null, sentRound: null });
  const [access] = await db.select().from(courseAccess);
  expect([access.extraTries, access.completedAt]).toEqual([0, null]);
  expect(await db.select().from(courseTests)).toEqual([]);
  expect(await db.select().from(testAttempts)).toEqual([]);
  expect(await db.select().from(practicalPhotos)).toEqual([]);

  // a protocol has exactly one owner, a registration or an access, and an access at most one protocol
  const stages = [{ title: "Punkt 1", note: "" }];
  await violates(db.insert(protocols).values({ stages }), "protocols_one_owner");
  await violates(db.insert(protocols).values({ registrationId: regs["mari@example.test"], accessId: access.id, stages }), "protocols_one_owner");
  const [mine] = await db.insert(protocols).values({ accessId: access.id, stages }).returning();
  expect(mine).toMatchObject({ registrationId: null, accessId: access.id, version: 1, verdicts: [], round: 0, submittedAt: null, sent: null, sentRound: null });
  await violates(db.insert(protocols).values({ accessId: access.id, stages }), "protocols_access");
  await db.insert(protocols).values({ registrationId: regs["mari@example.test"], stages }); // a registration's protocol is written as before

  // the test of a course: the defaults, the pass mark 1–100 and the tries 1–10; one row per course
  await violates(db.insert(courseTests).values({ courseId: id.e, passPercent: 0 }), "course_tests_pass_percent");
  await violates(db.insert(courseTests).values({ courseId: id.e, passPercent: 101 }), "course_tests_pass_percent");
  await violates(db.insert(courseTests).values({ courseId: id.e, tries: 0 }), "course_tests_tries");
  await violates(db.insert(courseTests).values({ courseId: id.e, tries: 11 }), "course_tests_tries");
  const [t] = await db.insert(courseTests).values({ courseId: id.e }).returning();
  expect(t).toMatchObject({ courseId: id.e, questions: [], passPercent: 80, tries: 3 });
  await violates(db.insert(courseTests).values({ courseId: id.e }), "course_tests_pkey");

  // one attempt per number of a student and a course; a photo of the access's protocol
  const attempt = { clientId, courseId: id.e, questions: [], answers: {}, correct: 0, total: 0, status: "passed" as const, submittedAt: new Date("2026-10-13T10:00:00Z") };
  const [first] = await db.insert(testAttempts).values({ ...attempt, number: 1 }).returning();
  expect(first).toMatchObject({ review: null, reviewedAt: null, reviewedBy: null });
  await violates(db.insert(testAttempts).values({ ...attempt, number: 1 }), "test_attempts_number");
  await db.insert(testAttempts).values({ ...attempt, number: 2 });
  const [photo] = await db
    .insert(practicalPhotos)
    .values({ protocolId: mine.id, stage: 0, round: 1, key: "practical/a.jpg", thumbKey: "practical/a-t.jpg", size: 1000, width: 800, height: 600 })
    .returning();
  expect(photo.createdAt).toBeInstanceOf(Date);

  // the account's deletion: the access, its protocol and its photos, and the attempts go; the registrations' protocols stay (unlinked)
  await db.delete(clients).where(eq(clients.id, clientId));
  expect(await db.select().from(courseAccess)).toEqual([]);
  expect(await db.select().from(practicalPhotos)).toEqual([]);
  expect(await db.select().from(testAttempts)).toEqual([]);
  expect((await db.select({ registrationId: protocols.registrationId }).from(protocols)).map((p) => p.registrationId).sort()).toEqual(
    [regs["kati@example.test"], regs["mari@example.test"]].sort(),
  );

  // the course's deletion takes its test with it
  await db.delete(courses).where(eq(courses.id, id.e));
  expect(await db.select().from(courseTests)).toEqual([]);
});

import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { courseFeedback, courses, protocols, registrations } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0007 (protocols) as the Railway database goes through it: 0000–0006 applied, a contact course and a registration written by the
// live code (which knows no protocol_stages), then 0007. The course gets no headings ([]), and the two new tables are there, empty, with their
// rules: one protocol and one feedback row per registration, both deleted with their registration. Additive: nothing else changes.

/** The statement fails on that very constraint (its name in the error), not on any other (as migration-0006.test.ts's). */
async function violates(statement: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(statement).then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error, `a failure on ${constraint}`).not.toBeNull();
  expect(error!.cause?.message ?? error!.message).toContain(`"${constraint}"`);
}

test("0007 gives every course an empty protocol_stages and adds protocols and course_feedback, one per registration, deleted with it", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0006_phase2b_payments");
  // the live code's inserts (raw SQL: drizzle would name the new column)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price_group) values ('k', 'contact', 'basic', '{"et":"K"}', '{"et":""}', '{"et":""}', 35000)`);
  const [{ id: courseId }] = await db.select({ id: courses.id }).from(courses);
  await db.execute(sql`insert into registrations (course_id, kind, name, email, payment_choice) values (${courseId}, 'individual', 'Kati', 'kati@example.test', 'full')`);

  await through("0007_protocols");

  // The protocols' columns as 0007 made them, and raw SQL for their inserts: this test stops at 0007, and drizzle would name the columns
  // migration 0008 adds (access_id, verdicts, round, submitted_at, sent_round).
  const v0007 = {
    id: protocols.id, registrationId: protocols.registrationId, stages: protocols.stages, generalNote: protocols.generalNote, version: protocols.version,
    sent: protocols.sent, sentAt: protocols.sentAt, sentVersion: protocols.sentVersion, createdAt: protocols.createdAt,
  };
  const [course] = await db.select().from(courses);
  expect(course.protocolStages).toEqual([]);
  expect(await db.select(v0007).from(protocols)).toEqual([]);
  expect(await db.select().from(courseFeedback)).toEqual([]);
  const [reg] = await db.select({ id: registrations.id }).from(registrations);

  await db.execute(sql`insert into protocols (registration_id, stages) values (${reg.id}, '[{"title":"Ettevalmistus","note":""}]')`);
  const [p] = await db.select(v0007).from(protocols);
  expect(p).toMatchObject({ registrationId: reg.id, stages: [{ title: "Ettevalmistus", note: "" }], generalNote: "", version: 1, sent: null, sentAt: null, sentVersion: null });
  expect(p.createdAt).toBeInstanceOf(Date);
  await violates(db.execute(sql`insert into protocols (registration_id, stages) values (${reg.id}, '[]')`), "protocols_registration"); // one per registration
  const [f] = await db.insert(courseFeedback).values({ registrationId: reg.id }).returning();
  expect(f).toMatchObject({ answers: null, locale: null, submittedAt: null, dismissedAt: null });
  await violates(db.insert(courseFeedback).values({ registrationId: reg.id }), "course_feedback_registration");

  await db.delete(registrations).where(eq(registrations.id, reg.id));
  expect(await db.select(v0007).from(protocols)).toEqual([]);
  expect(await db.select().from(courseFeedback)).toEqual([]);
});

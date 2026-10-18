import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/db/schema";
import { clients, courseAccess, courseFeedback, courses, registrations, reviews } from "@/db/schema";
import { migrationsThrough } from "./helpers";

// Migration 0014 (student reviews, phase 4 piece 4) as the Railway database goes through it: 0000–0013 applied, a contact registration with
// answered and dismissed feedback written by the code of 0013 (which knows no access_id), then 0014. The new table is there, empty; the old
// feedback rows are untouched (registration_id set, access_id null, so the new "exactly one" check holds for them); nothing else changes (the
// migration only adds). The rules fail by the name of their constraint or index (the database's own error, so that another failure cannot pass
// for it): exactly one of registration_id and access_id, one feedback per access and per registration, one review per feedback (manual reviews
// have none, and are many); and a registration's, an access's, a feedback's or a course's deletion takes the review with it.

/** The statement fails, and the database names `constraint` in its error (drizzle puts it in `cause`). */
async function violates(statement: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(statement).then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error, `a failure on ${constraint}`).not.toBeNull();
  expect(error!.cause?.message ?? error!.message).toContain(`"${constraint}"`);
}

type Column = { table_name: string; column_name: string };

test("0014 adds reviews, empty, and course_feedback.access_id for the e-course path, with their rules; the old feedback is untouched; deleting the owners takes the review", async () => {
  const db = drizzle(new PGlite(), { schema });
  const through = async (tag: string) => {
    const dir = migrationsThrough(tag);
    try {
      await migrate(db, { migrationsFolder: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  await through("0013_contracts");
  // the code of 0013's rows (raw SQL: drizzle would name the column 0014 adds)
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price_group) values ('k', 'contact', 'basic', '{"et":"K"}', '{"et":""}', '{"et":""}', 35000)`);
  await db.execute(sql`insert into courses (slug, type, level, title, summary, body, price) values ('e', 'e_learning', 'basic', '{"et":"E"}', '{"et":""}', '{"et":""}', 9900)`);
  const id = Object.fromEntries((await db.select({ id: courses.id, slug: courses.slug }).from(courses)).map((c) => [c.slug, c.id]));
  await db.execute(sql`insert into clients (email, name) values ('kati@example.test', 'Kati Kask'), ('mari@example.test', 'Mari Mänd'), ('liis@example.test', 'Liis Lepp')`);
  const who = Object.fromEntries((await db.select({ id: clients.id, email: clients.email }).from(clients)).map((c) => [c.email, c.id]));
  await db.execute(sql`insert into registrations (course_id, kind, name, email, payment_choice, status, client_id) values (${id.k}, 'group', 'Kati Kask', 'kati@example.test', 'full', 'confirmed', ${who["kati@example.test"]})`);
  await db.execute(sql`insert into registrations (course_id, kind, name, email, payment_choice, status, client_id) values (${id.k}, 'group', 'Mari Mänd', 'mari@example.test', 'full', 'confirmed', ${who["mari@example.test"]})`);
  const regs = Object.fromEntries((await db.select({ id: registrations.id, email: registrations.email }).from(registrations)).map((r) => [r.email, r.id]));
  await db.execute(
    sql`insert into course_access (client_id, course_id, granted_by, expires_at, completed_at) values (${who["kati@example.test"]}, ${id.e}, 'payment', '2027-04-13T00:00:00Z', '2026-10-10T09:00:00Z'), (${who["mari@example.test"]}, ${id.e}, 'payment', '2027-04-13T00:00:00Z', '2026-10-11T09:00:00Z'), (${who["liis@example.test"]}, ${id.e}, 'payment', '2027-04-13T00:00:00Z', null)`,
  );
  const access = Object.fromEntries((await db.select({ id: courseAccess.id, clientId: courseAccess.clientId }).from(courseAccess)).map((a) => [a.clientId, a.id]));
  await db.execute(sql`insert into course_feedback (registration_id, answers, locale, submitted_at) values (${regs["kati@example.test"]}, '{"score":9,"recommend":"Soovitaksin."}', 'et', '2026-10-12T09:00:00Z')`);
  await db.execute(sql`insert into course_feedback (registration_id, dismissed_at) values (${regs["mari@example.test"]}, '2026-10-13T09:00:00Z')`);
  const columnsBefore = await db.execute<Column>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
  const tablesBefore = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);
  const indexesBefore = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'course_feedback' order by indexname`);

  await through("0014_reviews");

  // the migration only adds: course_feedback.access_id and the new table's columns, nothing removed
  const columnsAfter = await db.execute<Column>(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, column_name`);
  const isNew = (c: Column) => !columnsBefore.rows.some((b) => b.table_name === c.table_name && b.column_name === c.column_name);
  expect(columnsAfter.rows.filter(isNew).map((c) => `${c.table_name}.${c.column_name}`).sort()).toEqual([
    "course_feedback.access_id",
    "reviews.course_id", "reviews.created_at", "reviews.decided_at", "reviews.featured", "reviews.feedback_id", "reviews.id", "reviews.kind", "reviews.locale",
    "reviews.name", "reviews.note", "reviews.status", "reviews.text", "reviews.updated_at", "reviews.written_at",
  ]);
  expect(columnsBefore.rows.filter((b) => !columnsAfter.rows.some((c) => b.table_name === c.table_name && b.column_name === c.column_name))).toEqual([]);
  const tablesAfter = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);
  expect(tablesAfter.rows.filter((t) => !tablesBefore.rows.some((b) => b.table_name === t.table_name))).toEqual([{ table_name: "reviews" }]);

  // course_feedback: registration_id may now be null, access_id is a nullable integer; the other columns keep their nullability
  const feedbackColumns = await db.execute<{ column_name: string; data_type: string; is_nullable: string }>(
    sql`select column_name, data_type, is_nullable from information_schema.columns where table_name = 'course_feedback' order by column_name`,
  );
  expect(Object.fromEntries(feedbackColumns.rows.map((c) => [c.column_name, `${c.data_type} ${c.is_nullable === "NO" ? "not null" : "null"}`]))).toEqual({
    access_id: "integer null", answers: "jsonb null", created_at: "timestamp with time zone not null", dismissed_at: "timestamp with time zone null",
    id: "integer not null", locale: "text null", registration_id: "integer null", submitted_at: "timestamp with time zone null",
  });

  // reviews: the columns, their types, and which may be empty; the defaults are false (featured) and now() (the two stamps), none else
  const info = await db.execute<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'reviews' order by column_name`,
  );
  expect(Object.fromEntries(info.rows.map((c) => [c.column_name, `${c.data_type} ${c.is_nullable === "NO" ? "not null" : "null"}`]))).toEqual({
    course_id: "integer not null", created_at: "timestamp with time zone not null", decided_at: "timestamp with time zone null", feedback_id: "integer null",
    featured: "boolean not null", id: "integer not null", kind: "text not null", locale: "text not null", name: "text not null", note: "text null",
    status: "text not null", text: "text not null", updated_at: "timestamp with time zone not null", written_at: "timestamp with time zone not null",
  });
  expect(Object.fromEntries(info.rows.filter((c) => c.column_default !== null && c.column_name !== "id").map((c) => [c.column_name, c.column_default]))).toEqual({
    created_at: "now()", featured: "false", updated_at: "now()",
  });

  // (the rest runs on the schema as it stands, so that a later migration does not break what this one checks)
  await migrate(db, { migrationsFolder: "./drizzle" });

  // what was there is untouched: the two feedback rows keep their registration and have no access, so the "exactly one" check holds for them
  const old = await db.select().from(courseFeedback).orderBy(courseFeedback.id);
  expect(old.map((f) => ({ registrationId: f.registrationId, accessId: f.accessId, submitted: f.submittedAt !== null, dismissed: f.dismissedAt !== null }))).toEqual([
    { registrationId: regs["kati@example.test"], accessId: null, submitted: true, dismissed: false },
    { registrationId: regs["mari@example.test"], accessId: null, submitted: false, dismissed: true },
  ]);
  expect(old[0]).toMatchObject({ answers: { score: 9, recommend: "Soovitaksin." }, locale: "et" });
  expect(await db.select().from(reviews)).toEqual([]);

  // the indexes: the old two stay, course_feedback_access is unique; reviews_feedback is unique, reviews_course_status is (course, status, newest first)
  const feedbackIndexes = await db.execute<{ indexname: string; indexdef: string }>(sql`select indexname, indexdef from pg_indexes where tablename = 'course_feedback' and indexname not like '%_pkey' order by indexname`);
  expect(indexesBefore.rows.map((i) => i.indexname)).toEqual(["course_feedback_pkey", "course_feedback_registration", "course_feedback_submitted"]);
  expect(feedbackIndexes.rows.map((i) => i.indexdef.replace("public.", ""))).toEqual([
    "CREATE UNIQUE INDEX course_feedback_access ON course_feedback USING btree (access_id)",
    "CREATE UNIQUE INDEX course_feedback_registration ON course_feedback USING btree (registration_id)",
    "CREATE INDEX course_feedback_submitted ON course_feedback USING btree (submitted_at)",
  ]);
  const reviewIndexes = await db.execute<{ indexname: string; indexdef: string }>(sql`select indexname, indexdef from pg_indexes where tablename = 'reviews' and indexname not like '%_pkey' order by indexname`);
  expect(reviewIndexes.rows.map((i) => i.indexdef.replace("public.", ""))).toEqual([
    "CREATE INDEX reviews_course_status ON reviews USING btree (course_id, status, written_at DESC)",
    "CREATE UNIQUE INDEX reviews_feedback ON reviews USING btree (feedback_id)",
  ]);

  // course_feedback: exactly one of registration_id and access_id (course_feedback_one_target)
  const [katiAccess, mariAccess, liisAccess] = [access[who["kati@example.test"]], access[who["mari@example.test"]], access[who["liis@example.test"]]];
  const [forAccess] = await db.insert(courseFeedback).values({ accessId: katiAccess, answers: { recommend: "Soovitaksin e-kursust." }, locale: "ru", submittedAt: new Date("2026-10-14T09:00:00Z") }).returning();
  expect(forAccess).toMatchObject({ registrationId: null, accessId: katiAccess, locale: "ru" });
  await violates(db.insert(courseFeedback).values({ registrationId: regs["kati@example.test"], accessId: mariAccess }), "course_feedback_one_target"); // both
  await violates(db.insert(courseFeedback).values({}), "course_feedback_one_target"); // neither
  await violates(db.insert(courseFeedback).values({ answers: { score: 5 } }), "course_feedback_one_target");
  await violates(db.update(courseFeedback).set({ accessId: mariAccess }).where(eq(courseFeedback.id, old[0].id)), "course_feedback_one_target"); // an old row given a second owner
  await violates(db.update(courseFeedback).set({ registrationId: null }).where(eq(courseFeedback.id, old[0].id)), "course_feedback_one_target"); // an old row given none
  await violates(db.update(courseFeedback).set({ accessId: null }).where(eq(courseFeedback.id, forAccess.id)), "course_feedback_one_target"); // an access row given none
  // one feedback per access (course_feedback_access) and still one per registration (course_feedback_registration); the empty side is no clash
  await violates(db.insert(courseFeedback).values({ accessId: katiAccess }), "course_feedback_access");
  await violates(db.insert(courseFeedback).values({ registrationId: regs["kati@example.test"] }), "course_feedback_registration");
  const [second] = await db.insert(courseFeedback).values({ accessId: mariAccess, dismissedAt: new Date("2026-10-15T09:00:00Z") }).returning();
  expect(second.registrationId).toBeNull();
  // the access must exist, and so must the registration
  await violates(db.insert(courseFeedback).values({ accessId: 999_999 }), "course_feedback_access_id_course_access_id_fk");
  await violates(db.insert(courseFeedback).values({ registrationId: 999_999 }), "course_feedback_registration_id_registrations_id_fk");

  // a review: a copy of the answer, pending, not featured, never decided, its stamps set
  const base = { courseId: id.e, kind: "student" as const, text: "Soovitaksin e-kursust.", name: "Kati K.", locale: "ru" as const, writtenAt: new Date("2026-10-14T09:00:00Z"), status: "pending" as const };
  const [review] = await db.insert(reviews).values({ ...base, feedbackId: forAccess.id }).returning();
  expect(review).toMatchObject({ ...base, feedbackId: forAccess.id, featured: false, decidedAt: null, note: null });
  expect(review.createdAt).toBeInstanceOf(Date);
  expect(review.updatedAt).toBeInstanceOf(Date);
  // one review per feedback (reviews_feedback) ...
  await violates(db.insert(reviews).values({ ...base, feedbackId: forAccess.id }), "reviews_feedback");
  // ... another feedback has its own, and reviews of no feedback (Maria's) are many
  const katiFeedback = old[0].id;
  const [contactReview] = await db.insert(reviews).values({ ...base, courseId: id.k, feedbackId: katiFeedback, locale: "et" }).returning();
  const manual = { courseId: id.k, kind: "manual" as const, text: "Paberilt.", name: "Liis L.", locale: "et" as const, writtenAt: new Date("2026-09-01T09:00:00Z"), status: "published" as const, note: "Paberkandjal vorm" };
  const [m1] = await db.insert(reviews).values({ ...manual, feedbackId: null }).returning();
  const [m2] = await db.insert(reviews).values({ ...manual, feedbackId: null }).returning();
  expect(m1).toMatchObject({ feedbackId: null, note: "Paberkandjal vorm", kind: "manual", status: "published" });
  expect(m2.id).not.toBe(m1.id);
  // the links must name something
  await violates(db.insert(reviews).values({ ...manual, courseId: 999_999 }), "reviews_course_id_courses_id_fk");
  await violates(db.insert(reviews).values({ ...manual, feedbackId: 999_999 }), "reviews_feedback_id_course_feedback_id_fk");
  // a review needs its text, name, language, kind, status and date (the columns are not null, and have no default)
  await violates(db.execute(sql`insert into reviews (course_id, kind, text, name, locale, written_at) values (${id.k}, 'manual', 't', 'n', 'et', now())`), "status");
  await violates(db.execute(sql`insert into reviews (course_id, text, name, locale, written_at, status) values (${id.k}, 't', 'n', 'et', now(), 'pending')`), "kind");

  // a feedback row's deletion takes its review (and only its): the registration's own answer, here by the registration's deletion
  await db.delete(registrations).where(eq(registrations.id, regs["kati@example.test"]));
  expect(await db.select({ id: courseFeedback.id }).from(courseFeedback).where(eq(courseFeedback.id, katiFeedback))).toEqual([]);
  expect(await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, contactReview.id))).toEqual([]);
  expect((await db.select({ id: reviews.id }).from(reviews).orderBy(reviews.id)).map((r) => r.id)).toEqual([review.id, m1.id, m2.id]); // the others stay

  // an access's deletion takes its feedback, and that takes the review (two steps of cascade); the manual reviews of the course stay
  await db.delete(courseAccess).where(eq(courseAccess.id, katiAccess));
  expect(await db.select({ id: courseFeedback.id }).from(courseFeedback).where(eq(courseFeedback.id, forAccess.id))).toEqual([]);
  expect(await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, review.id))).toEqual([]);
  expect((await db.select({ id: reviews.id }).from(reviews).orderBy(reviews.id)).map((r) => r.id)).toEqual([m1.id, m2.id]);
  // (the other access's feedback is untouched)
  expect((await db.select({ id: courseFeedback.id }).from(courseFeedback).where(eq(courseFeedback.id, second.id))).length).toBe(1);

  // the account's deletion takes its access, the feedback and the review the same way
  const [liisFeedback] = await db.insert(courseFeedback).values({ accessId: liisAccess, answers: { recommend: "Hea." }, locale: "et", submittedAt: new Date("2026-10-16T09:00:00Z") }).returning();
  const [liisReview] = await db.insert(reviews).values({ ...base, feedbackId: liisFeedback.id, locale: "et", name: "Liis L." }).returning();
  await db.delete(clients).where(eq(clients.id, who["liis@example.test"]));
  expect(await db.select({ id: courseFeedback.id }).from(courseFeedback).where(eq(courseFeedback.id, liisFeedback.id))).toEqual([]);
  expect(await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, liisReview.id))).toEqual([]);

  // a course's deletion takes its reviews, the manual ones too (they have no feedback to go with); another course's reviews stay
  const [other] = await db.insert(reviews).values({ ...manual, courseId: id.e, text: "E-kursuse oma." }).returning();
  expect((await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.courseId, id.k))).length).toBe(2);
  await db.delete(registrations).where(eq(registrations.id, regs["mari@example.test"])); // (a registration holds its course: courses.id has no cascade there)
  await db.delete(courses).where(eq(courses.id, id.k));
  expect(await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.courseId, id.k))).toEqual([]);
  expect((await db.select({ id: reviews.id }).from(reviews)).map((r) => r.id)).toEqual([other.id]);
  await db.delete(courses).where(eq(courses.id, id.e));
  expect(await db.select().from(reviews)).toEqual([]);
  expect(await db.select().from(courseFeedback)).toEqual([]); // (the e-course's accesses went with the course, and their feedback with them)
});

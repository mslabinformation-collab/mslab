import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "@/db/client";
import { assessmentCount, assessmentQueue, attemptForReview, attemptsOf } from "@/db/queries/assessment";
import { clients, courseAccess, courseTests, protocols, registrations } from "@/db/schema";
import { ANSWERS, at, attempt, COURSE_TITLE, ecourse, LATER, practical, QUESTIONS, student } from "./hindamine-fixtures";
import { makeTestDb } from "./helpers";

// "Hindamine" (e-course completion, spec §5.2, §8) on a real (PGlite) database: what waits for Maria — the practical work sent and not
// assessed, the open answers waiting for her review, the students out of tries — oldest first, and the count the menu badge shows. An access
// an admin ended leaves the list, one that ran out stays (she can still assess it), a completed one has nothing left (Review Focus 4). And
// one attempt as her review reads it: the attempt's own copy of the questions, whatever the course's test says now.

let db: Db;
let course: { id: number };

beforeEach(async () => {
  db = await makeTestDb();
  course = await ecourse(db);
});

describe("assessmentQueue", () => {
  test("three groups, oldest first, each row with what Hindamine shows; the badge's count is their sum", async () => {
    const anu = await student(db, course.id, "Anu");
    await practical(db, anu, 1, null, at(8));
    const berit = await student(db, course.id, "Berit");
    await practical(db, berit, 2, 1, at(6)); // her second round, after a "Paranda"
    const carmen = await student(db, course.id, "Carmen");
    await practical(db, carmen, 1, 1, at(5)); // assessed: nothing waits
    const dora = await student(db, course.id, "Dora");
    await practical(db, dora, 0, null, null); // photos of a round she has not sent
    const eve = await student(db, course.id, "Eve");
    const waiting = await attempt(db, eve, course.id, 1, "review", at(7));
    const fia = await student(db, course.id, "Fia");
    await attempt(db, fia, course.id, 1, "fix", at(4)); // hers to rewrite
    const gea = await student(db, course.id, "Gea");
    await attempt(db, gea, course.id, 1, "failed", at(2), { correct: 1, total: 2 });
    await attempt(db, gea, course.id, 2, "failed", at(3), { correct: 0, total: 2 });
    const hele = await student(db, course.id, "Hele");
    await attempt(db, hele, course.id, 1, "failed", at(1), { correct: 0 }); // one of her two tries left
    const ida = await student(db, course.id, "Ida", { extraTries: 2 });
    for (const n of [1, 2]) await attempt(db, ida, course.id, n, "failed", at(n), { correct: 0 }); // reopened: two more
    const juta = await student(db, course.id, "Juta");
    await attempt(db, juta, course.id, 1, "failed", at(1), { correct: 0 });
    await attempt(db, juta, course.id, 2, "passed", at(2), { correct: 2 });

    const q = await assessmentQueue(db);
    expect(q.practicals).toEqual([
      { accessId: berit.access.id, name: "Berit", course: COURSE_TITLE, round: 2, submittedAt: at(6) },
      { accessId: anu.access.id, name: "Anu", course: COURSE_TITLE, round: 1, submittedAt: at(8) },
    ]);
    expect(q.tests).toEqual([{ attemptId: waiting.id, accessId: eve.access.id, name: "Eve", course: COURSE_TITLE, number: 1, allowed: 2, submittedAt: at(7) }]);
    expect(q.triesUsed).toEqual([{ accessId: gea.access.id, name: "Gea", course: COURSE_TITLE, best: 50, attempts: 2 }]);
    expect(await assessmentCount(db)).toBe(4);
  });

  test("Review Focus 4: an access an admin ended leaves Hindamine; one that ran out stays (Maria can still assess it); a completed one is never listed", async () => {
    const anu = await student(db, course.id, "Anu");
    await practical(db, anu, 1, null, at(8));
    const eve = await student(db, course.id, "Eve", { expiresAt: new Date("2026-10-01T20:59:59.999Z") });
    await attempt(db, eve, course.id, 1, "review", at(7));
    const gea = await student(db, course.id, "Gea");
    for (const n of [1, 2]) await attempt(db, gea, course.id, n, "failed", at(n), { correct: 0 });
    expect(await assessmentCount(db)).toBe(3);

    await db.update(courseAccess).set({ revokedAt: at(9) }).where(eq(courseAccess.id, anu.access.id));
    await db.update(courseAccess).set({ completedAt: at(9) }).where(eq(courseAccess.id, gea.access.id));
    const q = await assessmentQueue(db);
    expect(q.practicals).toEqual([]);
    expect(q.tests.map((t) => t.accessId)).toEqual([eve.access.id]);
    expect(q.triesUsed).toEqual([]);
    expect(await assessmentCount(db)).toBe(1);
  });

  test("the name: her own, else her latest registration's, else her address", async () => {
    const [liis] = await db.insert(clients).values({ email: "liis@example.test" }).returning();
    await db.insert(registrations).values({ courseId: course.id, kind: "individual", name: "Liis Tamm", email: "liis@example.test", paymentChoice: "full", clientId: liis.id });
    const [mari] = await db.insert(clients).values({ email: "mari@example.test" }).returning();
    for (const [i, c] of [liis, mari].entries()) {
      const [a] = await db.insert(courseAccess).values({ clientId: c.id, courseId: course.id, grantedBy: "e2e", expiresAt: LATER }).returning();
      await db.insert(protocols).values({ accessId: a.id, stages: [], round: 1, submittedAt: at(i + 1) });
    }
    expect((await assessmentQueue(db)).practicals.map((p) => p.name)).toEqual(["Liis Tamm", "mari@example.test"]);
  });

  test("the tries allowed: the course's (3 when it has no test row) and her extra tries; the best score is rounded down", async () => {
    const other = await ecourse(db, { slug: "e-ripsmed", title: { et: "Ripsmete e-koolitus" }, test: null });
    const kati = await student(db, other.id, "Kati");
    for (const n of [1, 2]) await attempt(db, kati, other.id, n, "failed", at(n), { correct: 0 });
    expect((await assessmentQueue(db)).triesUsed).toEqual([]);
    await attempt(db, kati, other.id, 3, "failed", at(3), { correct: 2, total: 3 }); // 66.6… % → 66
    expect((await assessmentQueue(db)).triesUsed).toEqual([{ accessId: kati.access.id, name: "Kati", course: { et: "Ripsmete e-koolitus" }, best: 66, attempts: 3 }]);
    await db.update(courseAccess).set({ extraTries: 3 }).where(eq(courseAccess.id, kati.access.id));
    expect((await assessmentQueue(db)).triesUsed).toEqual([]);
    expect(await assessmentCount(db)).toBe(0);
  });
});

describe("one attempt for Maria's review", () => {
  test("its own copy of the questions with the key, her answers, the score, the tries allowed and the course's pass mark (Review Focus 3)", async () => {
    const eve = await student(db, course.id, "Eve", { extraTries: 2 });
    const a = await attempt(db, eve, course.id, 1, "review", at(7));
    // Maria changes the test afterwards: the attempt keeps the questions it answered
    await db.update(courseTests).set({ questions: [{ id: "uus00001", kind: "open", text: "Uus küsimus" }], passPercent: 90 }).where(eq(courseTests.courseId, course.id));
    expect(await attemptForReview(db, a.id)).toEqual({
      id: a.id,
      accessId: eve.access.id,
      name: "Eve",
      course: COURSE_TITLE,
      number: 1,
      allowed: 4,
      status: "review",
      percent: 50,
      passPercent: 90,
      questions: QUESTIONS,
      answers: ANSWERS,
      review: null,
      submittedAt: at(7),
    });
    expect(await attemptForReview(db, 999_999)).toBeNull();
    await db.update(courseAccess).set({ revokedAt: at(9) }).where(eq(courseAccess.id, eve.access.id));
    expect(await attemptForReview(db, a.id)).toBeNull();
  });

  test("every attempt of an access, newest first; none yet is an empty list; an access an admin ended, or none, is null", async () => {
    const gea = await student(db, course.id, "Gea");
    const first = await attempt(db, gea, course.id, 1, "failed", at(2), { correct: 0 });
    const second = await attempt(db, gea, course.id, 2, "fix", at(3), { correct: 2, review: { qavatud1: { verdict: "fix", comment: "Lisa samm." } } });
    const list = (await attemptsOf(db, gea.access.id))!;
    expect([list.name, list.course]).toEqual(["Gea", COURSE_TITLE]);
    expect(list.attempts.map((x) => [x.id, x.number, x.status, x.percent, x.allowed])).toEqual([
      [second.id, 2, "fix", 100, 2],
      [first.id, 1, "failed", 0, 2],
    ]);
    expect(list.attempts[0].review).toEqual({ qavatud1: { verdict: "fix", comment: "Lisa samm." } });
    const anu = await student(db, course.id, "Anu");
    expect(await attemptsOf(db, anu.access.id)).toEqual({ name: "Anu", course: COURSE_TITLE, attempts: [] });
    expect(await attemptsOf(db, 999_999)).toBeNull();
    await db.update(courseAccess).set({ revokedAt: at(9) }).where(eq(courseAccess.id, gea.access.id));
    expect(await attemptsOf(db, gea.access.id)).toBeNull();
  });
});

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "@/db/client";
import { feedbackById, feedbackOf, feedbackStats, pageFeedback } from "@/db/queries/protocols";
import { clients, courseFeedback, registrations } from "@/db/schema";
import type { FeedbackAnswers } from "@/domain/protocols";
import { clientDetail } from "@/server/admin-clients";
import { COURSE_DAY, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// Maria's "Tagasiside" (spec §7): the answers newest first with the course filter, the numbers per course, one answer by its id, and the
// answers of one registration or one student for the drawers. "Ei soovi" is never an answer.

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
});

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12));
async function answered(registrationId: number, answers: FeedbackAnswers, day: number, locale: "et" | "ru" = "et") {
  const [row] = await db.insert(courseFeedback).values({ registrationId, answers, locale, submittedAt: at(day), createdAt: at(day) }).returning();
  return row;
}

/** Two courses; Mari and Anu answered the first (Anu in Russian), Tiina the second; Liis pressed "Ei soovi". */
async function setup() {
  const { course, session } = await protocolCourse(db);
  const { course: other, session: otherSession } = await protocolCourse(db, { slug: "ripsmete-tostmine", title: { et: "Ripsmete tõstmine", ru: "Лифтинг ресниц" } });
  const mari = await student(db, course, session, "Mari Maasikas");
  const anu = await student(db, course, session, "Anu Aas");
  const tiina = await student(db, other, otherSession, "Tiina Tamm");
  const liis = await student(db, course, session, "Liis Lepp");
  const a = await answered(mari.id, { score: 9, expectations: "met", message: "Aitäh!" }, 13);
  const b = await answered(anu.id, { score: 6, expectations: "exceeded", ready: "mostly" }, 14, "ru");
  const c = await answered(tiina.id, { clarity: "very_clear" }, 15);
  const [dismissed] = await db.insert(courseFeedback).values({ registrationId: liis.id, dismissedAt: at(13), createdAt: at(13) }).returning();
  return { course, other, mari, anu, tiina, liis, a, b, c, dismissed };
}

describe("the Tagasiside page's reads", () => {
  test("the answers newest first, a page at a time (here 2); 'Ei soovi' is no answer; the course filter", async () => {
    const { course, a, b, c } = await setup();
    const all = await pageFeedback(db, { page: 1, size: 2 });
    expect([all.total, all.pages, all.rows.map((r) => r.id)]).toEqual([3, 2, [c.id, b.id]]);
    expect((await pageFeedback(db, { page: 2, size: 2 })).rows.map((r) => r.id)).toEqual([a.id]);
    const one = await pageFeedback(db, { courseId: course.id, page: 1 });
    expect(one.rows.map((r) => [r.name, r.answers.score, r.locale])).toEqual([
      ["Anu Aas", 6, "ru"],
      ["Mari Maasikas", 9, "et"],
    ]);
    expect(one.rows[1]).toEqual({
      id: a.id,
      registrationId: a.registrationId,
      accessId: null,
      clientId: null,
      name: "Mari Maasikas",
      email: "marimaasikas@example.com",
      course: { id: course.id, title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } },
      startsAt: COURSE_DAY,
      completedAt: null,
      answers: { score: 9, expectations: "met", message: "Aitäh!" },
      locale: "et",
      submittedAt: at(13),
    });
  });

  test("the search (piece 4c, S4-40): a part of a name or of an e-mail address finds the answer, in any case, with the order, the count and the course filter", async () => {
    const { course, other, a, b, c } = await setup();
    const ids = async (search: string, courseId?: number) => (await pageFeedback(db, { search, courseId, page: 1 })).rows.map((r) => r.id);
    expect(await ids("maas")).toEqual([a.id]);
    expect(await ids("MAASIKAS")).toEqual([a.id]);
    expect(await ids("anuaas@example")).toEqual([b.id]);
    expect(await ids("tiina")).toEqual([c.id]);
    // (all three are at example.com: newest first, as the unsearched list)
    expect(await ids("example.com")).toEqual([c.id, b.id, a.id]);
    // the course filter and the search narrow it together
    expect(await ids("tiina", course.id)).toEqual([]);
    expect(await ids("tiina", other.id)).toEqual([c.id]);
    expect(await ids("a", course.id)).toEqual([b.id, a.id]);
    // the count and the pages are those of the search
    const second = await pageFeedback(db, { search: "example.com", page: 2, size: 2 });
    expect([second.total, second.pages, second.rows.map((r) => r.id)]).toEqual([3, 2, [a.id]]);
    // nothing typed, or only spaces: every answer; a text nobody has: none; "Ei soovi" (Liis) is no answer, so she is not found
    expect(await ids("")).toEqual([c.id, b.id, a.id]);
    expect(await ids("   ")).toEqual([c.id, b.id, a.id]);
    expect((await pageFeedback(db, { search: "zzz", page: 1 })).total).toBe(0);
    expect(await ids("liis")).toEqual([]);
  });

  test("the search takes % _ and a backslash for themselves, in a name and in an e-mail address, never as wildcards", async () => {
    const { course, session } = await protocolCourse(db);
    const answerOf = async (name: string, email: string, day: number) => (await answered((await student(db, course, session, name, { email })).id, { score: 8 }, day)).id;
    const percent = await answerOf("Mari 50% Maasikas", "mari@example.test", 13);
    const underscore = await answerOf("Anu_Aas", "anu@example.test", 14);
    const backslash = await answerOf("Liis\\Lepp", "liis@example.test", 15);
    const plain = await answerOf("Tiina Tamm", "tiina_tamm@example.test", 16);
    const ids = async (search: string) => (await pageFeedback(db, { search, page: 1 })).rows.map((r) => r.id);
    expect(await ids("%")).toEqual([percent]); // as a wildcard it would find all four
    expect(await ids("50%")).toEqual([percent]);
    expect(await ids("_")).toEqual([plain, underscore]); // the name "Anu_Aas" and the address "tiina_tamm@…"
    expect(await ids("i_a")).toEqual([]); // as a wildcard it would find "Tiina"
    expect(await ids("tiina_t")).toEqual([plain]);
    expect(await ids("\\")).toEqual([backslash]);
  });

  test("per course, by its title: the answers, the scores, the average to one decimal, every option of every choice question counted", async () => {
    const { course, other } = await setup();
    const stats = await feedbackStats(db);
    expect(stats.map((s) => [s.course.id, s.summary.count, s.summary.scored, s.summary.average])).toEqual([
      [course.id, 2, 2, 7.5],
      [other.id, 1, 0, null],
    ]);
    expect(stats[0].summary.options.expectations).toEqual({ exceeded: 1, met: 1, not_met: 0 });
    expect(stats[0].summary.options.ready).toEqual({ fully: 0, mostly: 1, rather_not: 0, no: 0 });
    expect(stats[1].summary.options.clarity).toEqual({ very_clear: 1, fairly_clear: 0, needs_work: 0 });
    expect(await feedbackStats(await makeTestDb())).toEqual([]);
  });

  test("one answer by its id; a dismissed row or an unknown id is none", async () => {
    const { a, dismissed } = await setup();
    expect(await feedbackById(db, a.id)).toMatchObject({ id: a.id, name: "Mari Maasikas" });
    expect(await feedbackById(db, dismissed.id)).toBeNull();
    expect(await feedbackById(db, 999)).toBeNull();
  });

  test("the drawers: a registration's answer; a student's, through her registrations, newest first", async () => {
    const { mari, anu, liis, a, b } = await setup();
    const [kati] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati" }).returning();
    for (const r of [mari, anu]) await db.update(registrations).set({ clientId: kati.id }).where(eq(registrations.id, r.id));
    expect((await feedbackOf(db, { registrationId: mari.id })).map((f) => f.id)).toEqual([a.id]);
    expect(await feedbackOf(db, { registrationId: liis.id })).toEqual([]);
    expect((await feedbackOf(db, { clientId: kati.id })).map((f) => [f.id, f.clientId])).toEqual([
      [b.id, kati.id],
      [a.id, kati.id],
    ]);
    expect((await clientDetail(db, kati.id))!.feedback.map((f) => f.id)).toEqual([b.id, a.id]);
  });
});

import { expect, test } from "vitest";
import { protocolIndex } from "@/db/queries/protocols";
import { courses, courseSessions, protocols } from "@/db/schema";
import type { Db } from "@/db/client";
import { protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// The Protokollid index (admin UX pass, B8): the contact courses' sessions of today and the 14 days before it, in Tallinn's dates, newest first, with
// how many students are listed, how many protocols are sent and how many are drafts; below them the individual registrations still without a sent
// protocol.

const draftOf = (registrationId: number) => ({ registrationId, stages: [], version: 1 });
const sentOf = (registrationId: number) => ({ registrationId, stages: [], version: 1, sent: { stages: [], generalNote: "" }, sentAt: new Date("2026-10-12T12:00:00Z"), sentVersion: 1 });

/** A session of the course at `startsAt` (a Tallinn city; `status` scheduled unless said). */
async function sessionAt(db: Db, courseId: number, startsAt: string, status: "scheduled" | "cancelled" = "scheduled") {
  return (await db.insert(courseSessions).values({ courseId, startsAt: new Date(startsAt), city: "Tartu", venue: "", status }).returning())[0];
}

test("lists sessions from today back 14 Tallinn days, newest first, today on top; 15 days ago and the future are left out", async () => {
  const db = await makeTestDb();
  const { course, session: base } = await protocolCourse(db); // 12.10 10:00 in Tallinn: 9 days before the 21st
  const now = new Date("2026-10-21T09:00:00Z"); // 12:00 on 21.10 in Tallinn (summer time until 25.10)
  const laterToday = await sessionAt(db, course.id, "2026-10-21T15:00:00Z"); // 18:00 today: still to come, but today's
  const morning = await sessionAt(db, course.id, "2026-10-21T07:00:00Z"); // 10:00 today
  const edge = await sessionAt(db, course.id, "2026-10-07T07:00:00Z"); // 14 days ago: in
  await sessionAt(db, course.id, "2026-10-06T07:00:00Z"); // 15 days ago: out
  await sessionAt(db, course.id, "2026-10-22T07:00:00Z"); // tomorrow: out
  await sessionAt(db, course.id, "2026-10-15T07:00:00Z", "cancelled"); // called off: nothing to write protocols for
  const [ecourse] = await db.insert(courses).values({ slug: "e", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" } }).returning();
  await sessionAt(db, ecourse.id, "2026-10-20T07:00:00Z"); // only contact courses have protocols of the course day

  const { sessions } = await protocolIndex(db, now);
  expect(sessions.map((s) => s.id)).toEqual([laterToday.id, morning.id, base.id, edge.id]);
  expect(sessions[2]).toMatchObject({ id: base.id, startsAt: base.startsAt, course: "Kulmude lamineerimine", place: "Pärnu, MS LAB stuudio", students: 0, sent: 0, drafts: 0 });
  expect(sessions[0].place).toBe("Tartu"); // no venue: the city alone
});

test("the window follows Tallinn's dates: just after midnight there, and over the new year", async () => {
  const db = await makeTestDb();
  const { course, session: base } = await protocolCourse(db); // 12.10 10:00: in the October window, long out of the December one
  const at = (startsAt: string) => sessionAt(db, course.id, startsAt);
  // 00:30 on 21.10 in Tallinn is still the 20th in UTC; 14 days back is the 7th
  const justToday = await at("2026-10-20T21:10:00Z"); // 00:10 on the 21st: today
  const edgeIn = await at("2026-10-06T21:30:00Z"); // 00:30 on the 7th: 14 days ago, in (the 6th in UTC)
  await at("2026-10-06T20:30:00Z"); // 23:30 on the 6th: 15 days ago, out
  await at("2026-10-21T21:30:00Z"); // 00:30 on the 22nd: tomorrow, out
  expect((await protocolIndex(db, new Date("2026-10-20T21:30:00Z"))).sessions.map((s) => s.id)).toEqual([justToday.id, base.id, edgeIn.id]);
  // 23:30 UTC on 31 December is already 1 January in Tallinn; the 14 days reach back to 18 December
  const jan = await at("2026-12-31T22:10:00Z"); // 00:10 on 1.01.2027
  const first = await at("2026-12-18T08:00:00Z");
  const before = await at("2026-12-17T08:00:00Z");
  expect((await protocolIndex(db, new Date("2026-12-31T22:30:00Z"))).sessions.map((s) => s.id)).toEqual([jan.id, first.id]);
  // an hour earlier it is still the 31st in Tallinn: 17 December is the 14th day back and in, and 1 January is tomorrow
  expect((await protocolIndex(db, new Date("2026-12-31T21:30:00Z"))).sessions.map((s) => s.id)).toEqual([first.id, before.id]);
});

test("counts the listed students, the sent protocols and the drafts of each session", async () => {
  const db = await makeTestDb();
  const { course, session } = await protocolCourse(db); // 12.10
  const done = await sessionAt(db, course.id, "2026-10-13T07:00:00Z");
  const mari = await student(db, course, session, "Mari Maasikas");
  const anu = await student(db, course, session, "Anu Aas", { status: "awaiting_prepayment" }); // listed on the screen too
  await student(db, course, session, "Tiina Tamm"); // no protocol yet
  const kati = await student(db, course, session, "Kati Kask", { status: "cancelled" }); // not listed, whatever her protocol says
  const eve = await student(db, course, done, "Eve Esi");
  await db.insert(protocols).values([sentOf(mari.id), draftOf(anu.id), sentOf(kati.id), sentOf(eve.id)]);

  const { sessions } = await protocolIndex(db, new Date("2026-10-14T09:00:00Z"));
  expect(sessions.map((s) => [s.id, s.students, s.sent, s.drafts])).toEqual([
    [done.id, 1, 1, 0],
    [session.id, 3, 1, 1],
  ]);
});

test("a protocol sent and edited since is still sent; one draft is one draft", async () => {
  const db = await makeTestDb();
  const { course, session } = await protocolCourse(db);
  const mari = await student(db, course, session, "Mari Maasikas");
  await db.insert(protocols).values({ ...sentOf(mari.id), version: 2 });
  const { sessions } = await protocolIndex(db, new Date("2026-10-12T09:00:00Z"));
  expect(sessions[0]).toMatchObject({ students: 1, sent: 1, drafts: 0 });
});

test("lists open individual registrations, newest first: not cancelled, protocol not sent", async () => {
  const db = await makeTestDb();
  const { course, session } = await protocolCourse(db);
  const old = await student(db, course, null, "Piret Kalda"); // individual: no session
  const draft = await student(db, course, null, "Liis Lepik");
  const fresh = await student(db, course, null, "Maire Mänd", { status: "awaiting_prepayment" });
  const sent = await student(db, course, null, "Reet Rebane");
  await student(db, course, null, "Tiina Tamm", { status: "cancelled" });
  await student(db, course, session, "Mari Maasikas"); // a group student: in her session's count
  const [other] = await db.insert(courses).values({ slug: "e", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" } }).returning();
  await student(db, other, null, "Siiri Sepp"); // not a contact course: no protocol screen for it
  await db.insert(protocols).values([draftOf(draft.id), sentOf(sent.id)]);
  // (the rows are made within one millisecond of each other: newest is by creation, then by id)
  const { individual } = await protocolIndex(db, new Date("2026-12-01T09:00:00Z"));
  expect(individual).toEqual([
    { registrationId: fresh.id, name: "Maire Mänd", course: "Kulmude lamineerimine", draft: false },
    { registrationId: draft.id, name: "Liis Lepik", course: "Kulmude lamineerimine", draft: true },
    { registrationId: old.id, name: "Piret Kalda", course: "Kulmude lamineerimine", draft: false },
  ]);
});

test("nothing in the last 14 days and no open individual registration: both lists are empty", async () => {
  const db = await makeTestDb();
  await protocolCourse(db); // 12.10
  expect(await protocolIndex(db, new Date("2026-11-30T09:00:00Z"))).toEqual({ sessions: [], individual: [] });
});

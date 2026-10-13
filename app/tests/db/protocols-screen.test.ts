import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { protocolScreen } from "@/db/queries/protocols";
import { courses, courseSessions, protocols } from "@/db/schema";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// What the course day's screen reads (spec §4): one session's students, or one registration; each protocol's status; the course's headings
// for a protocol not created yet, its own copy for one that is (spec §9).

test("a session: its confirmed and awaiting students by name with their status; the cancelled ones hidden and counted; headings for none yet", async () => {
  const db = await makeTestDb();
  const { course, session } = await protocolCourse(db);
  const mari = await student(db, course, session, "Mari Maasikas");
  await student(db, course, session, "Anu Aas", { status: "awaiting_prepayment" });
  await student(db, course, session, "Tiina Tamm", { status: "cancelled" });
  await db.insert(protocols).values({ registrationId: mari.id, stages: [{ title: "Vana pealkiri", note: "Hea algus" }], version: 2 });

  const screen = (await protocolScreen(db, { sessionId: session.id }))!;
  expect(screen).toMatchObject({
    kind: "session",
    course: { id: course.id, title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } },
    session: { id: session.id, startsAt: session.startsAt, city: "Pärnu", venue: "MS LAB stuudio", cancelled: false },
    hidden: 1,
  });
  expect(screen.students.map((s) => [s.name, s.status, s.state, s.protocol.version])).toEqual([
    ["Anu Aas", "awaiting_prepayment", "none", 0],
    ["Mari Maasikas", "confirmed", "draft", 2],
  ]);
  expect(screen.students[0].protocol).toEqual({ id: null, version: 0, stages: HEADINGS.map((title) => ({ title, note: "" })), generalNote: "", sentVersion: null, sentAt: null, updatedAt: null });
  // a created protocol keeps its own copy of the headings
  expect(screen.students[1].protocol.stages).toEqual([{ title: "Vana pealkiri", note: "Hea algus" }]);
});

test("each protocol's status: a draft, sent, changed after it was sent", async () => {
  const db = await makeTestDb();
  const { course, session } = await protocolCourse(db);
  const [a, b, c] = [await student(db, course, session, "Aili"), await student(db, course, session, "Berit"), await student(db, course, session, "Carmen")];
  const sentAt = new Date("2026-10-12T15:00:00Z");
  const sent = { stages: [], generalNote: "Tubli" };
  await db.insert(protocols).values([
    { registrationId: a.id, stages: [], generalNote: "x", version: 1 },
    { registrationId: b.id, stages: [], generalNote: "Tubli", version: 3, sent, sentAt, sentVersion: 3 },
    { registrationId: c.id, stages: [], generalNote: "Tubli!", version: 4, sent, sentAt, sentVersion: 3 },
  ]);
  const screen = (await protocolScreen(db, { sessionId: session.id }))!;
  expect(screen.students.map((s) => [s.name, s.state])).toEqual([["Aili", "draft"], ["Berit", "sent"], ["Carmen", "changed"]]);
  expect(screen.students[2].protocol).toMatchObject({ version: 4, sentVersion: 3, sentAt });
});

test("one registration (an individual course): that student alone; a cancelled one is hidden; an e-course's, or an unknown one, is no screen", async () => {
  const db = await makeTestDb();
  const { course } = await protocolCourse(db);
  const kati = await student(db, course, null, "Kati Kask");
  const one = (await protocolScreen(db, { registrationId: kati.id }))!;
  expect(one).toMatchObject({ kind: "registration", session: null, hidden: 0 });
  expect(one.students.map((s) => [s.registrationId, s.name, s.state])).toEqual([[kati.id, "Kati Kask", "none"]]);

  const gone = await student(db, course, null, "Liis Lepp", { status: "cancelled" });
  expect(await protocolScreen(db, { registrationId: gone.id })).toMatchObject({ students: [], hidden: 1 });

  const [ecourse] = await db.insert(courses).values({ slug: "e", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" }, price: 9000 }).returning();
  const buyer = await student(db, ecourse, null, "Eva");
  expect(await protocolScreen(db, { registrationId: buyer.id })).toBeNull();
  expect(await protocolScreen(db, { registrationId: 999_999 })).toBeNull();
  expect(await protocolScreen(db, { sessionId: 999_999 })).toBeNull();
});

test("a session called off: its protocols stay reachable for the record (spec §9)", async () => {
  const db = await makeTestDb();
  const { course, session } = await protocolCourse(db);
  await student(db, course, session, "Mari");
  await db.update(courseSessions).set({ status: "cancelled" }).where(eq(courseSessions.id, session.id));
  const screen = (await protocolScreen(db, { sessionId: session.id }))!;
  expect(screen.session?.cancelled).toBe(true);
  expect(screen.students.map((s) => s.name)).toEqual(["Mari"]);
});

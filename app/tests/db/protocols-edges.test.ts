import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { protocolScreen, studentProtocol } from "@/db/queries/protocols";
import { clients, courseFeedback, courses, courseSessions, protocols, registrations, type Registration } from "@/db/schema";
import { deleteClient, loadDashboard } from "@/server/client-data";
import { submitFeedback } from "@/server/course-feedback";
import { saveProtocol, sendProtocol, sendProtocols, type SendDeps } from "@/server/protocols";
import { fakeKv } from "../fakes";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// Spec §9, the cases no other task's tests own (the table in the plan's Task 10 says where the others are), and the account's deletion
// (spec §3): her protocols and feedback go, her registrations stay with Maria.

const SITE = "https://mslab.example";
const NOW = new Date("2026-10-12T16:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// no RESEND_API_KEY: nothing is mailed (the mails are Task 3's)
const deps = (): SendDeps => ({ db, env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE }, siteUrl: SITE, now: NOW, later: () => {} });
const write = (registrationId: number, version: number, note: string, titles: readonly string[] = HEADINGS) =>
  saveProtocol(db, { registrationId, version, titles: [...titles], notes: [note, ...Array<string>(titles.length - 1).fill("")], generalNote: "Tubli töö" }, NOW);
const stored = async (registrationId: number) => (await db.select().from(protocols).where(eq(protocols.registrationId, registrationId)))[0];
const accountOf = async (r: Registration) => (await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].clientId!;
const names = async (sessionId: number) => (await protocolScreen(db, { sessionId }))!.students.map((s) => [s.name, s.state]);

describe("a registration cancelled, or moved, while it has a protocol", () => {
  test("cancelled: off the screen and never sent, alone or with the others; reinstated, it is back with every word", async () => {
    const { course, session } = await protocolCourse(db);
    const mari = await student(db, course, session, "Mari Maasikas");
    const anu = await student(db, course, session, "Anu Aas");
    await write(mari.id, 0, "Hea algus");
    await write(anu.id, 0, "Ühtlane joon");
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, mari.id));
    expect(await names(session.id)).toEqual([["Anu Aas", "draft"]]);
    const results = await sendProtocols(deps(), [
      { registrationId: mari.id, version: 1 },
      { registrationId: anu.id, version: 1 },
    ]);
    expect(results.map((r) => [r.registrationId, r.result.kind])).toEqual([
      [mari.id, "cancelled"],
      [anu.id, "sent"],
    ]);
    expect((await stored(mari.id)).sentAt).toBeNull();
    await db.update(registrations).set({ status: "confirmed" }).where(eq(registrations.id, mari.id));
    expect(await names(session.id)).toEqual([
      ["Anu Aas", "sent"],
      ["Mari Maasikas", "draft"],
    ]);
    expect((await protocolScreen(db, { registrationId: mari.id }))!.students[0].protocol.stages[0]).toEqual({ title: HEADINGS[0], note: "Hea algus" });
  });

  test("moved to another session: the protocol follows her, a sent one too, and she still reads it on her card", async () => {
    const { course, session } = await protocolCourse(db);
    const [later] = await db.insert(courseSessions).values({ courseId: course.id, startsAt: new Date("2026-10-19T07:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio", capacity: 6 }).returning();
    const mari = await student(db, course, session, "Mari Maasikas");
    await write(mari.id, 0, "Hea algus");
    await sendProtocol(deps(), { registrationId: mari.id, version: 1 });
    await db.update(registrations).set({ courseSessionId: later.id }).where(eq(registrations.id, mari.id));
    expect(await names(session.id)).toEqual([]);
    expect(await names(later.id)).toEqual([["Mari Maasikas", "sent"]]);
    const account = await accountOf(mari);
    expect(await studentProtocol(db, account, mari.id)).toMatchObject({ session: { startsAt: "2026-10-19T07:00:00.000Z" }, stages: [{ title: HEADINGS[0], note: "Hea algus" }, ...HEADINGS.slice(1).map((title) => ({ title, note: "" }))] });
    const card = (await loadDashboard(db, account, NOW))!.cards.find((c) => c.kind === "contact" && c.registrationId === mari.id);
    expect(card).toMatchObject({ session: { startsAt: "2026-10-19T07:00:00.000Z" }, protocolSent: true });
  });

  test("the course's headings changed after a send: the student's copy keeps the headings it was written under", async () => {
    const { course, session } = await protocolCourse(db);
    const mari = await student(db, course, session, "Mari Maasikas");
    await write(mari.id, 0, "Hea algus");
    await sendProtocol(deps(), { registrationId: mari.id, version: 1 });
    await db.update(courses).set({ protocolStages: ["Uus punkt"] }).where(eq(courses.id, course.id));
    expect((await studentProtocol(db, await accountOf(mari), mari.id))!.stages.map((s) => s.title)).toEqual(HEADINGS);
    const anu = await student(db, course, session, "Anu Aas");
    expect((await protocolScreen(db, { registrationId: anu.id }))!.students[0].protocol.stages).toEqual([{ title: "Uus punkt", note: "" }]);
  });
});

describe("the account deleted (spec §3)", () => {
  async function twoSent() {
    const { course, session } = await protocolCourse(db);
    const mari = await student(db, course, session, "Mari Maasikas");
    const anu = await student(db, course, session, "Anu Aas");
    for (const r of [mari, anu]) {
      await write(r.id, 0, `Märkus: ${r.name}`);
      await sendProtocol(deps(), { registrationId: r.id, version: 1 });
      expect(await submitFeedback(db, { clientId: await accountOf(r), target: { registrationId: r.id }, answers: { score: 9 }, locale: "et", consent: null }, NOW)).toMatchObject({ kind: "submitted" });
    }
    return { course, session, mari, anu };
  }

  test("her protocols and feedback go; her registrations stay with Maria, unlinked; another student's stay; Maria's screen shows her with nothing written", async () => {
    const { session, mari, anu } = await twoSent();
    const account = await accountOf(mari);
    const before = (await db.select().from(registrations).where(eq(registrations.id, mari.id)))[0];
    expect(await deleteClient(db, account)).toEqual({ email: "marimaasikas@example.com", locale: "et", photoKeys: [], reviewCourses: [] });
    expect((await db.select().from(protocols)).map((p) => p.registrationId)).toEqual([anu.id]);
    expect((await db.select().from(courseFeedback)).map((f) => f.registrationId)).toEqual([anu.id]);
    expect((await db.select().from(registrations).where(eq(registrations.id, mari.id)))[0]).toEqual({ ...before, clientId: null });
    expect((await db.select().from(clients)).map((c) => c.email)).toEqual(["anuaas@example.com"]);
    expect(await names(session.id)).toEqual([
      ["Anu Aas", "sent"],
      ["Mari Maasikas", "none"],
    ]);
  });

  test("a feedback answer and the deletion, one after the other in either order: nothing of hers is left", async () => {
    const { course, session } = await protocolCourse(db);
    const mari = await student(db, course, session, "Mari Maasikas");
    const anu = await student(db, course, session, "Anu Aas");
    for (const r of [mari, anu]) {
      await write(r.id, 0, "Hea algus");
      await sendProtocol(deps(), { registrationId: r.id, version: 1 });
    }
    // the answer first, then the deletion: the answer goes with the account
    const first = await accountOf(mari);
    expect(await submitFeedback(db, { clientId: first, target: { registrationId: mari.id }, answers: { score: 9 }, locale: "et", consent: null }, NOW)).toMatchObject({ kind: "submitted" });
    await deleteClient(db, first);
    expect(await db.select().from(courseFeedback)).toEqual([]);
    // the deletion first, then the answer: the registration is no longer hers, and the answer finds nothing
    const second = await accountOf(anu);
    await deleteClient(db, second);
    expect(await submitFeedback(db, { clientId: second, target: { registrationId: anu.id }, answers: { score: 9 }, locale: "et", consent: null }, NOW)).toEqual({ kind: "notFound" });
    expect(await db.select().from(courseFeedback)).toEqual([]);
    expect(await db.select().from(protocols)).toEqual([]);
  });
});

test("signed in under another address: none of her registration's protocol or feedback is hers until Maria links them", async () => {
  const { course, session } = await protocolCourse(db);
  const mari = await student(db, course, session, "Mari Maasikas");
  await write(mari.id, 0, "Hea algus");
  await sendProtocol(deps(), { registrationId: mari.id, version: 1 });
  const [other] = await db.insert(clients).values({ email: "mari.teine@example.com", name: "Mari" }).returning();
  expect(await studentProtocol(db, other.id, mari.id)).toBeNull();
  const dashboard = (await loadDashboard(db, other.id, NOW))!;
  expect(dashboard.cards).toEqual([]);
  expect(dashboard).not.toHaveProperty("feedback");
  expect(await submitFeedback(db, { clientId: other.id, target: { registrationId: mari.id }, answers: { score: 9 }, locale: "et", consent: null }, NOW)).toEqual({ kind: "notFound" });
});

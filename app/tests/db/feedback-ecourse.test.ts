import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { feedbackById, feedbackOf, feedbackStats, pageFeedback } from "@/db/queries/protocols";
import { clients, courseAccess, courseFeedback, courses, reviews } from "@/db/schema";
import { clientDetail } from "@/server/admin-clients";
import { deleteClient } from "@/server/client-data";
import { feedbackState, hideFeedback, notifyFeedback, submitFeedback } from "@/server/course-feedback";
import { fakeKv, stubFetch } from "../fakes";
import { makeTestDb } from "./helpers";
import { protocolCourse, student } from "./protocols-fixtures";
import { contactStudent, graduate, NOW, RECOMMEND, submit } from "./reviews-fixtures";

// The e-course graduate's feedback (student reviews, spec D3): the same form as a contact course's, open once the access is „Lõpetatud“
// (completed_at set, not revoked), reached by the course's slug; the admin's reads (Tagasiside, the drawers) cover its answers too.

let db: Db;
let logged: () => string;
beforeEach(async () => {
  db = await makeTestDb();
  const spies = (["info", "error"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  logged = () => spies.flatMap((spy) => spy.mock.calls).map((args) => args.map(String).join(" ")).join("\n");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SLUG = { courseSlug: "kulmud-e" };
const stored = () => db.select().from(courseFeedback);
const reviewRows = () => db.select().from(reviews);

describe("when the form is open", () => {
  test("before the access is completed: no form, and a submit is notFound (nothing stored); after it, the form and the submit work", async () => {
    const { client, access } = await graduate(db, { completed: false });
    expect(await feedbackState(db, client.id, SLUG, NOW)).toBeNull();
    expect(await submit(db, client.id, SLUG, null)).toEqual({ kind: "notFound" });
    expect(await hideFeedback(db, { clientId: client.id, target: SLUG }, NOW)).toBe(false);
    expect(await stored()).toEqual([]);
    await db.update(courseAccess).set({ completedAt: new Date("2026-10-10T09:00:00Z") }).where(eq(courseAccess.id, access.id));
    expect(await feedbackState(db, client.id, SLUG, NOW)).toEqual({ course: { slug: "kulmud-e", title: { et: "Kulmude e-kursus", ru: "Брови онлайн" } }, sent: false, shownName: "Kati K." });
    expect(await submit(db, client.id, SLUG, null)).toMatchObject({ kind: "submitted" });
    expect(await stored()).toHaveLength(1);
  });

  test("a revoked access (completed or not): notFound, no form, nothing stored", async () => {
    const { client } = await graduate(db, { revoked: true });
    expect(await feedbackState(db, client.id, SLUG, NOW)).toBeNull();
    expect(await submit(db, client.id, SLUG, null)).toEqual({ kind: "notFound" });
    expect(await hideFeedback(db, { clientId: client.id, target: SLUG }, NOW)).toBe(false);
    expect(await stored()).toEqual([]);
  });

  test("an access that has ended (expires_at past) but was completed is still open: completion is never cleared (course_access.completed_at)", async () => {
    const { client, access } = await graduate(db);
    await db.update(courseAccess).set({ expiresAt: new Date("2026-10-11T00:00:00Z") }).where(eq(courseAccess.id, access.id));
    expect(await feedbackState(db, client.id, SLUG, NOW)).toMatchObject({ sent: false });
    expect(await submit(db, client.id, SLUG, null)).toMatchObject({ kind: "submitted" });
  });

  test("not hers: another client, a course she has no access to, a contact course's slug and an unknown slug are all notFound", async () => {
    const { client } = await graduate(db);
    const [other] = await db.insert(clients).values({ email: "teine@example.test", name: "Teine Inimene" }).returning();
    const contact = await contactStudent(db);
    for (const [who, slug] of [[other.id, "kulmud-e"], [client.id, contact.course.slug], [client.id, "olematu"], [client.id, "KULMUD-E"]] as const) {
      const target = { courseSlug: slug };
      expect(await feedbackState(db, who, target, NOW), slug).toBeNull();
      expect(await submit(db, who, target, null), slug).toEqual({ kind: "notFound" });
      expect(await hideFeedback(db, { clientId: who, target }, NOW), slug).toBe(false);
    }
    expect(await stored()).toEqual([]);
  });
});

describe("the submit", () => {
  test("stores the answers on the access (no registration), once; the notice names the access, has no day, and is not publishable without a consent", async () => {
    const { client, access } = await graduate(db);
    const result = await submit(db, client.id, SLUG, null, { answers: { score: 8, recommend: RECOMMEND }, locale: "ru" });
    expect(result).toEqual({
      kind: "submitted",
      notice: { target: { accessId: access.id }, name: "Kati Kask", email: "kati@example.test", course: "Kulmude e-kursus", startsAt: null, answers: { score: 8, recommend: RECOMMEND }, publishable: false },
    });
    expect(await stored()).toEqual([
      expect.objectContaining({ registrationId: null, accessId: access.id, answers: { score: 8, recommend: RECOMMEND }, locale: "ru", submittedAt: NOW, dismissedAt: null }),
    ]);
    expect(await reviewRows()).toEqual([]);
    expect(await submit(db, client.id, SLUG, null, { answers: { score: 3 } })).toEqual({ kind: "sent" });
    expect((await stored())[0].answers).toEqual({ score: 8, recommend: RECOMMEND });
    expect(await feedbackState(db, client.id, SLUG, NOW)).toMatchObject({ sent: true });
    expect(logged()).toContain(`[feedback] access ${access.id}: submitted`);
  });

  test("after the submit, a revoked access still answers 'sent' (the card is gone for good), never a second answer", async () => {
    const { client, access } = await graduate(db);
    await submit(db, client.id, SLUG, null);
    await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, access.id));
    expect(await feedbackState(db, client.id, SLUG, NOW)).toMatchObject({ sent: true });
    expect(await submit(db, client.id, SLUG, null)).toEqual({ kind: "sent" });
    expect(await stored()).toHaveLength(1);
  });

  test("with a consent: a pending review of the e-course with the typed name and the recommend text; the notice is publishable", async () => {
    const { course, client, access } = await graduate(db);
    const result = await submit(db, client.id, SLUG, { name: "  Kati   K. " }, { locale: "ru" });
    expect(result).toMatchObject({ kind: "submitted", notice: { target: { accessId: access.id }, publishable: true } });
    const [feedback] = await stored();
    expect(await reviewRows()).toEqual([
      expect.objectContaining({
        courseId: course.id, feedbackId: feedback.id, kind: "student", text: RECOMMEND, name: "Kati K.", locale: "ru", writtenAt: NOW, status: "pending",
        featured: false, decidedAt: null, note: null,
      }),
    ]);
  });

  test("a consent without a usable answer or name is refused with its field, and nothing is stored: the form still takes a good submit after", async () => {
    const { client } = await graduate(db);
    expect(await submit(db, client.id, SLUG, { name: "Kati K." }, { answers: { score: 9 } })).toEqual({ kind: "consentText" });
    expect(await submit(db, client.id, SLUG, { name: "Kati K." }, { answers: { score: 9, recommend: "   " } })).toEqual({ kind: "consentText" });
    expect(await submit(db, client.id, SLUG, { name: "" })).toEqual({ kind: "consentName" });
    expect(await submit(db, client.id, SLUG, { name: " \t " })).toEqual({ kind: "consentName" });
    expect(await submit(db, client.id, SLUG, { name: "K".repeat(41) })).toEqual({ kind: "consentName" });
    expect(await stored()).toEqual([]);
    expect(await reviewRows()).toEqual([]);
    expect(await submit(db, client.id, SLUG, { name: "K".repeat(40) })).toMatchObject({ kind: "submitted" });
    expect((await reviewRows())[0].name).toBe("K".repeat(40));
  });

  test("'Ei soovi' first, then the answers with a consent: the same feedback row is answered and the review is made from it", async () => {
    const { client, access } = await graduate(db);
    expect(await hideFeedback(db, { clientId: client.id, target: SLUG }, NOW)).toBe(true);
    expect(await stored()).toEqual([expect.objectContaining({ accessId: access.id, registrationId: null, answers: null, submittedAt: null, dismissedAt: NOW })]);
    expect(await hideFeedback(db, { clientId: client.id, target: SLUG }, NOW)).toBe(true); // twice: the same
    expect(await submit(db, client.id, SLUG, { name: "Kati K." })).toMatchObject({ kind: "submitted" });
    const [feedback] = await stored();
    expect(feedback).toMatchObject({ answers: { score: 9, recommend: RECOMMEND }, submittedAt: NOW, dismissedAt: NOW });
    expect(await stored()).toHaveLength(1);
    expect((await reviewRows())[0].feedbackId).toBe(feedback.id);
  });

  test("two submits at the same moment: one is 'submitted', the other 'sent'; one feedback row and one review", async () => {
    const { client } = await graduate(db);
    const results = await Promise.all([submit(db, client.id, SLUG, { name: "Kati K." }), submit(db, client.id, SLUG, { name: "Kati K." })]);
    expect(results.map((r) => r.kind).sort()).toEqual(["sent", "submitted"]);
    expect(await stored()).toHaveLength(1);
    expect(await reviewRows()).toHaveLength(1);
  });

  test("the name offered: the account's name as Kati K., a single word as it is, none as ''", async () => {
    const { client } = await graduate(db);
    expect((await feedbackState(db, client.id, SLUG, NOW))!.shownName).toBe("Kati K.");
    await db.update(clients).set({ name: "Kati" }).where(eq(clients.id, client.id));
    expect((await feedbackState(db, client.id, SLUG, NOW))!.shownName).toBe("Kati");
    await db.update(clients).set({ name: "" }).where(eq(clients.id, client.id));
    expect((await feedbackState(db, client.id, SLUG, NOW))!.shownName).toBe("");
  });

  test("an account with no name: Maria's notice names her by her address", async () => {
    const { client } = await graduate(db, { name: "" });
    const result = await submit(db, client.id, SLUG, null);
    expect(result).toMatchObject({ kind: "submitted", notice: { name: "kati@example.test", email: "kati@example.test" } });
  });

  test("a submit whose transaction does not commit leaves neither the feedback nor the review", async () => {
    const { client } = await graduate(db);
    const failing = new Proxy(db, {
      get: (target, prop) =>
        prop === "transaction"
          ? (work: (tx: never) => Promise<unknown>) =>
              target.transaction(async (tx) => {
                await work(tx as never);
                throw new Error("commit failed");
              })
          : Reflect.get(target, prop, target),
    });
    await expect(submitFeedback(failing, { clientId: client.id, target: SLUG, answers: { recommend: RECOMMEND }, locale: "et", consent: { name: "Kati K." } }, NOW)).rejects.toThrow("commit failed");
    expect(await stored()).toEqual([]);
    expect(await reviewRows()).toEqual([]);
    expect(logged()).not.toContain("submitted");
  });
});

describe("Maria's notice", () => {
  const SITE = "https://mslab.example";
  const env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" };

  test("an e-course answer's notice: the course without a day; the line 'Lubab avaldada' only when she allowed it; the log says 'access N' and no names", async () => {
    const net = stubFetch((url) => (url.includes("telegram") ? Response.json({ ok: true }) : Response.json({ id: "email_1" })));
    const { client, access } = await graduate(db);
    const first = await submit(db, client.id, SLUG, { name: "Kati K." }, { answers: { score: 9, recommend: RECOMMEND } });
    if (first.kind !== "submitted") throw new Error(first.kind);
    await notifyFeedback(env, SITE, first.notice);
    const [mail] = net.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as { subject: string; text: string });
    expect(mail.subject).toBe("Uus tagasiside: Kati Kask, Kulmude e-kursus, 9/10");
    expect(mail.text).toContain("Koolitus: Kulmude e-kursus\n");
    expect(mail.text).toContain("Lubab avaldada — vaata „Tagasiside“ lehel.");
    const ping = net.calls.find((c) => c.url.includes("telegram"))!.body as { text: string };
    expect(ping.text).toContain("Lubab avaldada — vaata „Tagasiside“ lehel.");
    const log = logged();
    expect(log).toContain(`[feedback] access ${access.id}: Maria notified by e-mail`);
    for (const text of ["Kati", "Kask", "example.test", RECOMMEND, "re_test", "123:abc"]) expect(log, text).not.toContain(text);
  });
});

describe("the admin's reads cover the e-course answers (Tagasiside, the drawers)", () => {
  /** A contact answer (Mari, day 13) and an e-course answer (Kati, day 14) of different courses, Kati's with a review. */
  async function both() {
    const mari = await contactStudent(db);
    await submit(db, mari.client.id, { registrationId: mari.registration.id }, null, { answers: { score: 6, expectations: "met" }, now: new Date("2026-10-13T12:00:00Z") });
    const kati = await graduate(db);
    await submit(db, kati.client.id, SLUG, { name: "Kati K." }, { answers: { score: 10, expectations: "exceeded", recommend: RECOMMEND }, locale: "ru", now: new Date("2026-10-14T12:00:00Z") });
    const [contactFeedback, ecourseFeedback] = await db.select().from(courseFeedback).orderBy(courseFeedback.id);
    return { mari, kati, contactFeedback, ecourseFeedback };
  }

  test("pageFeedback lists both, newest first; the e-course row has the access, the completion, the student's name and address, no registration or day", async () => {
    const { mari, kati, contactFeedback, ecourseFeedback } = await both();
    const page = await pageFeedback(db, { page: 1 });
    expect([page.total, page.rows.map((r) => r.id)]).toEqual([2, [ecourseFeedback.id, contactFeedback.id]]);
    expect(page.rows[0]).toEqual({
      id: ecourseFeedback.id,
      registrationId: null,
      accessId: kati.access.id,
      clientId: kati.client.id,
      name: "Kati Kask",
      email: "kati@example.test",
      course: { id: kati.course.id, title: { et: "Kulmude e-kursus", ru: "Брови онлайн" } },
      startsAt: null,
      completedAt: new Date("2026-10-10T09:00:00Z"),
      answers: { score: 10, expectations: "exceeded", recommend: RECOMMEND },
      locale: "ru",
      submittedAt: new Date("2026-10-14T12:00:00Z"),
    });
    expect(page.rows[1]).toMatchObject({ registrationId: mari.registration.id, accessId: null, completedAt: null, name: "Mari Maasikas", clientId: mari.client.id });
    expect(page.rows[1].startsAt).not.toBeNull();
  });

  test("the course filter, the count and the paging are right for both kinds", async () => {
    const { mari, kati, contactFeedback, ecourseFeedback } = await both();
    const eOnly = await pageFeedback(db, { courseId: kati.course.id, page: 1 });
    expect([eOnly.total, eOnly.rows.map((r) => r.id)]).toEqual([1, [ecourseFeedback.id]]);
    const cOnly = await pageFeedback(db, { courseId: mari.course.id, page: 1 });
    expect([cOnly.total, cOnly.rows.map((r) => r.id)]).toEqual([1, [contactFeedback.id]]);
    expect((await pageFeedback(db, { courseId: 9999, page: 1 })).total).toBe(0);
    const first = await pageFeedback(db, { page: 1, size: 1 });
    const second = await pageFeedback(db, { page: 2, size: 1 });
    expect([first.total, first.pages, first.rows.map((r) => r.id), second.rows.map((r) => r.id)]).toEqual([2, 2, [ecourseFeedback.id], [contactFeedback.id]]);
  });

  test("the search (piece 4c, S4-40) finds an e-course answer by the account's name or address and a contact one by the registration's, and counts both", async () => {
    const { contactFeedback, ecourseFeedback } = await both();
    const ids = async (search: string) => (await pageFeedback(db, { search, page: 1 })).rows.map((r) => r.id);
    expect(await ids("kask")).toEqual([ecourseFeedback.id]); // her name
    expect(await ids("kati@")).toEqual([ecourseFeedback.id]); // her address
    expect(await ids("maasikas")).toEqual([contactFeedback.id]); // the registration's name
    expect(await ids("marimaasikas@example")).toEqual([contactFeedback.id]); // and its address
    expect(await ids("example.test")).toEqual([ecourseFeedback.id, contactFeedback.id]);
    expect(await ids("nobody")).toEqual([]);
    const found = await pageFeedback(db, { search: "kask", page: 1 });
    expect([found.total, found.pages]).toEqual([1, 1]);
  });

  test("an e-course answer whose account has no name is listed under her address; an 'Ei soovi' of an e-course is no answer", async () => {
    const kati = await graduate(db, { name: "" });
    await submit(db, kati.client.id, SLUG, null);
    expect((await pageFeedback(db, { page: 1 })).rows.map((r) => r.name)).toEqual(["kati@example.test"]);
    const other = await graduate(db, { slug: "ripsmed-e", email: "liis@example.test", name: "Liis Lepp" });
    await hideFeedback(db, { clientId: other.client.id, target: { courseSlug: "ripsmed-e" } }, NOW);
    expect((await pageFeedback(db, { page: 1 })).total).toBe(1);
    expect(await feedbackStats(db)).toHaveLength(1);
  });

  test("feedbackStats counts the e-course's answers with its own average, next to the contact course's", async () => {
    const { mari, kati } = await both();
    const stats = await feedbackStats(db);
    expect(stats.map((s) => [s.course.id, s.summary.count, s.summary.scored, s.summary.average])).toEqual([
      [kati.course.id, 1, 1, 10], // "Kulmude e-kursus" sorts before "Kulmude lamineerimine"
      [mari.course.id, 1, 1, 6],
    ]);
    expect(stats[0].summary.options.expectations).toEqual({ exceeded: 1, met: 0, not_met: 0 });
  });

  test("feedbackById opens an e-course answer; feedbackOf finds it by the student, never by a registration", async () => {
    const { mari, kati, contactFeedback, ecourseFeedback } = await both();
    expect(await feedbackById(db, ecourseFeedback.id)).toMatchObject({ id: ecourseFeedback.id, accessId: kati.access.id, registrationId: null, name: "Kati Kask" });
    expect((await feedbackOf(db, { clientId: kati.client.id })).map((f) => f.id)).toEqual([ecourseFeedback.id]);
    expect((await feedbackOf(db, { clientId: mari.client.id })).map((f) => f.id)).toEqual([contactFeedback.id]);
    expect((await feedbackOf(db, { registrationId: mari.registration.id })).map((f) => f.id)).toEqual([contactFeedback.id]);
    expect(await feedbackOf(db, { registrationId: 9999 })).toEqual([]);
    expect((await clientDetail(db, kati.client.id))!.feedback.map((f) => f.id)).toEqual([ecourseFeedback.id]);
  });

  test("a client with both a contact registration and an e-course sees both answers in her drawer, newest first", async () => {
    const kati = await graduate(db);
    const { course, session } = await protocolCourse(db);
    const registration = await student(db, course, session, "Kati Kask", { clientId: kati.client.id, email: "kati@example.test" });
    await submit(db, kati.client.id, { registrationId: registration.id }, null, { now: new Date("2026-10-13T12:00:00Z") });
    await submit(db, kati.client.id, SLUG, null, { now: new Date("2026-10-14T12:00:00Z") });
    const rows = await feedbackOf(db, { clientId: kati.client.id });
    expect(rows.map((r) => [r.registrationId === null ? "access" : "registration", r.clientId])).toEqual([["access", kati.client.id], ["registration", kati.client.id]]);
  });
});

describe("her account's deletion takes the e-course answer and its review", () => {
  test("deleteClient: the access goes, and the feedback and the review with it; another graduate's are untouched", async () => {
    const kati = await graduate(db);
    const liis = await graduate(db, { slug: "ripsmed-e", email: "liis@example.test", name: "Liis Lepp" });
    await submit(db, kati.client.id, SLUG, { name: "Kati K." });
    await submit(db, liis.client.id, { courseSlug: "ripsmed-e" }, { name: "Liis L." });
    expect(await deleteClient(db, kati.client.id)).not.toBeNull();
    expect((await stored()).map((f) => f.accessId)).toEqual([liis.access.id]);
    expect((await reviewRows()).map((r) => r.name)).toEqual(["Liis L."]);
    expect(await db.select({ id: courses.id }).from(courses)).toHaveLength(2);
  });
});

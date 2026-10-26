import { beforeEach, describe, expect, test } from "vitest";
import { makeTestDb } from "./helpers";
import type { Db } from "@/db/client";
import { courses, courseSessions, registrations, requests, subscribers } from "@/db/schema";
import {
  adminCounts,
  countSubscribers,
  getRegistration,
  listCourseNames,
  listRequests,
  listSessionsByIds,
  listSubscribers,
  pageRegistrations,
  pageRequests,
  pageSubscribers,
  setRequestHandled,
  subscriberCounts,
} from "@/db/queries/admin";
import { NOTE_MAX } from "@/domain/registration";
import { cancel, saveHandled, saveStatus, subscribersCsv, subscribersCsvName } from "@/server/admin";
import { addManualPayment } from "@/server/registration-money";

// Task 12: the admin inbox's queries and form handling on a real (PGlite) database.

const base = { level: "basic" as const, title: { et: "Kulmumeistri baaskoolitus" }, summary: { et: "" }, body: { et: "" } };
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

// (a day with no session on it: the fixture's session is on 14.11.2026)
const NOW = new Date("2026-10-21T09:00:00Z");

let db: Db;
let contact: { id: number };
let online: { id: number };
let session: { id: number };

beforeEach(async () => {
  db = await makeTestDb();
  [contact] = await db.insert(courses).values({ ...base, slug: "kulm", type: "contact", priceGroup: 35000, priceIndividual: 45000 }).returning();
  [online] = await db.insert(courses).values({ ...base, slug: "e", type: "e_learning", price: 9500 }).returning();
  [session] = await db.insert(courseSessions).values({ courseId: contact.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu" }).returning();
});

const register = async (over: Partial<typeof registrations.$inferInsert> = {}) => {
  const [r] = await db
    .insert(registrations)
    .values({ courseId: contact.id, courseSessionId: session.id, kind: "group", name: "Liis", email: "liis@example.com", paymentChoice: "half", ...over })
    .returning();
  return r;
};

// (the typed „Laekunud summa“ — recordRegistrationPayment, savePayment — is gone, admin UX pass B4: money is added with „Lisa laekumine“,
// tests/db/registration-money.test.ts)

describe("saveStatus / cancel", () => {
  // (admin UX pass, piece 2, Task 5: the status pills „Ootab ettemaksu“ / „Kinnitatud“ save the status alone, at once; the note is its own autosaved
  // part, tests/db/registration-note-route.test.ts; cancelling is „Tühista registreerimine“'s alone, and a cancelled registration is not put back)
  test("Maria sets „Ootab ettemaksu“ or „Kinnitatud“ by hand; the note is not touched; any other status is invalid", async () => {
    const r = await register({ note: "helistas" });
    const save = (fields: Record<string, string>) => saveStatus(db, form({ id: String(r.id), ...fields }));
    expect(await save({ status: "confirmed", expected: "awaiting_prepayment", note: "ignoreeritakse" })).toEqual({ ok: true });
    expect(await getRegistration(db, r.id)).toMatchObject({ status: "confirmed", note: "helistas" });
    expect(await save({ status: "awaiting_prepayment", expected: "confirmed" })).toEqual({ ok: true });
    expect((await getRegistration(db, r.id))?.status).toBe("awaiting_prepayment");
    expect(await save({ status: "maybe", expected: "awaiting_prepayment" })).toEqual({ ok: false, error: "invalid" });
    // cancelling goes through „Tühista registreerimine“ (cancel), never through the pills
    expect(await save({ status: "cancelled", expected: "awaiting_prepayment" })).toEqual({ ok: false, error: "invalid" });
    expect((await getRegistration(db, r.id))?.status).toBe("awaiting_prepayment");
    expect(await saveStatus(db, form({ id: "9999", status: "confirmed", expected: "awaiting_prepayment" }))).toEqual({ ok: false, error: "notFound" });
    expect(await saveStatus(db, form({ id: "x", status: "confirmed", expected: "awaiting_prepayment" }))).toEqual({ ok: false, error: "invalid" });
    expect(NOTE_MAX).toBe(2000);
  });

  test("a pill press that saw an old status is refused (stale) and changes nothing; without `expected` it is invalid; a cancelled one is not put back", async () => {
    const r = await register({ note: "algne" });
    // another tab cancels it meanwhile
    expect(await cancel(db, form({ id: String(r.id) }))).toEqual({ ok: true });
    expect(await saveStatus(db, form({ id: String(r.id), status: "confirmed", expected: "awaiting_prepayment" }))).toEqual({ ok: false, error: "stale" });
    expect(await getRegistration(db, r.id)).toMatchObject({ status: "cancelled", note: "algne" });
    expect(await saveStatus(db, form({ id: String(r.id), status: "confirmed" }))).toEqual({ ok: false, error: "invalid" });
    // a cancelled registration cannot be put back from the drawer (spec §10): a press that says it saw „Tühistatud“ is invalid
    expect(await saveStatus(db, form({ id: String(r.id), status: "confirmed", expected: "cancelled" }))).toEqual({ ok: false, error: "invalid" });
    expect((await getRegistration(db, r.id))?.status).toBe("cancelled");
    // a payment confirms it meanwhile („Lisa laekumine“ in another tab): a press that still saw "awaiting" is refused
    const p = await register();
    expect(await addManualPayment(db, { registrationId: p.id, cents: 17500, paidOn: "2026-10-21", method: "bank", receipt: false, expectedPaidCents: 0 }, NOW)).toMatchObject({ ok: true, status: "confirmed" });
    expect(await saveStatus(db, form({ id: String(p.id), status: "awaiting_prepayment", expected: "awaiting_prepayment" }))).toEqual({
      ok: false,
      error: "stale",
    });
    expect((await getRegistration(db, p.id))?.status).toBe("confirmed");
  });

  test("Tühista cancels and keeps the note", async () => {
    const r = await register({ note: "helistas" });
    expect(await cancel(db, form({ id: String(r.id) }))).toEqual({ ok: true });
    expect(await getRegistration(db, r.id)).toMatchObject({ status: "cancelled", note: "helistas" });
    expect(await cancel(db, form({ id: "0" }))).toEqual({ ok: false, error: "invalid" });
  });
});

describe("getRegistration", () => {
  test("joins the course and the session; an individual one has no session", async () => {
    const r = await register();
    const row = await getRegistration(db, r.id);
    expect(row?.course.slug).toBe("kulm");
    expect(row?.courseSession?.city).toBe("Pärnu");
    const i = await register({ kind: "individual", courseSessionId: null });
    expect((await getRegistration(db, i.id))?.courseSession).toBeNull();
    expect(await getRegistration(db, 9999)).toBeNull();
  });
});

describe("requests", () => {
  test("setRequestHandled / saveHandled toggle both ways", async () => {
    const [q] = await db.insert(requests).values({ kind: "practice", payload: { name: "Liis", email: "liis@example.com" } }).returning();
    expect((await setRequestHandled(db, q.id, true))?.handled).toBe(true);
    // (the form is the page's own: { id, handled, expected } — the card's button and the UndoBar's „Võta tagasi“; tests/db/admin-requests.test.ts)
    expect(await saveHandled(db, { id: q.id, handled: false, expected: true })).toMatchObject({ ok: true });
    expect((await setRequestHandled(db, q.id, true))?.handled).toBe(true);
    expect(await saveHandled(db, { id: q.id, handled: "yes", expected: true })).toEqual({ ok: false, error: "invalid" });
    expect(await saveHandled(db, { id: 9999, handled: true, expected: false })).toEqual({ ok: false, error: "notFound" });
    expect(await setRequestHandled(db, 9999, true)).toBeNull();
  });

  test("course names and sessions for the inbox", async () => {
    expect((await listCourseNames(db)).map((c) => c.slug).sort()).toEqual(["e", "kulm"]);
    expect((await listSessionsByIds(db, [session.id, 9999])).map((s) => s.id)).toEqual([session.id]);
    expect(await listSessionsByIds(db, [])).toEqual([]);
  });
});

describe("pages of 50 (?leht=)", () => {
  test("registrations: 51 rows are two pages; an out-of-range page shows the last one; filters count too", async () => {
    await db.insert(registrations).values(
      Array.from({ length: 51 }, (_, i) => ({
        courseId: contact.id,
        courseSessionId: session.id,
        kind: "group" as const,
        name: `R${String(i).padStart(2, "0")}`,
        email: `r${i}@example.com`,
        paymentChoice: "half" as const,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
      })),
    );
    const first = await pageRegistrations(db, {}, 1);
    expect(first).toMatchObject({ page: 1, pages: 2, total: 51, size: 50, offset: 0 });
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0].name).toBe("R50"); // newest first
    expect(first.rows[49].name).toBe("R01");
    const second = await pageRegistrations(db, {}, 2);
    expect(second).toMatchObject({ page: 2, pages: 2, total: 51, offset: 50 });
    expect(second.rows.map((r) => r.name)).toEqual(["R00"]);
    const beyond = await pageRegistrations(db, {}, 99);
    expect(beyond).toMatchObject({ page: 2, pages: 2 });
    expect(beyond.rows.map((r) => r.name)).toEqual(["R00"]);
    expect(beyond.rows[0].course.slug).toBe("kulm");
    const none = await pageRegistrations(db, { type: "e_learning" }, 3);
    expect(none).toMatchObject({ page: 1, pages: 1, total: 0, rows: [] });
    expect((await pageRegistrations(db, { status: "awaiting_prepayment" }, 1, 20)).pages).toBe(3);
  });

  test("requests: the open ones and the done ones are two lists, each newest first and paged by itself; only the tab's kind", async () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 1, h));
    await db.insert(requests).values([
      { kind: "practice", payload: { name: "open-old" }, createdAt: at(1) },
      { kind: "practice", payload: { name: "done-new" }, handled: true, createdAt: at(9) },
      { kind: "practice", payload: { name: "open-new" }, createdAt: at(5) },
      { kind: "practice", payload: { name: "done-old" }, handled: true, createdAt: at(2) },
      { kind: "practice", payload: { name: "open-mid" }, createdAt: at(3) },
      { kind: "contact", payload: { name: "other kind" }, createdAt: at(10) },
    ]);
    const names = async (handled: boolean, page: number) => (await pageRequests(db, { kind: "practice", handled, page }, 2)).rows.map((r) => r.payload.name);
    expect(await names(false, 1)).toEqual(["open-new", "open-mid"]);
    expect(await names(false, 2)).toEqual(["open-old"]);
    expect(await names(true, 1)).toEqual(["done-new", "done-old"]);
    expect(await pageRequests(db, { kind: "practice", handled: false, page: 2 }, 2)).toMatchObject({ page: 2, pages: 2, total: 3 });
    expect(await pageRequests(db, { kind: "practice", handled: true, page: 1 }, 2)).toMatchObject({ page: 1, pages: 1, total: 2 });
    expect(await names(false, 4)).toEqual(["open-old"]); // clamped
    // the plain list keeps its newest-first order
    expect((await listRequests(db, "practice")).map((r) => r.payload.name)).toEqual(["done-new", "open-new", "open-mid", "done-old", "open-old"]);
  });

  test("subscribers: pages of the given size, newest consent first; empty is one empty page", async () => {
    expect(await pageSubscribers(db, {}, 5)).toMatchObject({ page: 1, pages: 1, total: 0, rows: [] });
    await db.insert(subscribers).values(Array.from({ length: 5 }, (_, i) => ({ email: `s${i}@example.com`, token: `t${i}`, consentAt: new Date(Date.UTC(2026, 9, 1, i)) })));
    const p1 = await pageSubscribers(db, {}, 1, 2);
    expect(p1.rows.map((r) => r.email)).toEqual(["s4@example.com", "s3@example.com"]);
    expect((await pageSubscribers(db, {}, 3, 2)).rows.map((r) => r.email)).toEqual(["s0@example.com"]);
    expect(await pageSubscribers(db, {}, 0, 2)).toMatchObject({ page: 1 });
  });
});

describe("adminCounts", () => {
  test("registrations waiting for the prepayment, open requests per kind (e-learning purchase interest is a contact request), subscribers", async () => {
    expect(await adminCounts(db, "maria@example.test", NOW)).toEqual({
      awaitingPrepayment: 0,
      openRequests: { contact: 0, individual: 0, practice: 0, waitlist: 0, change_request: 0 },
      subscribers: 0,
      confirmedSubscribers: 0,
      assessment: 0,
      todaySessions: [],
      waitingReviews: 0,
      paymentsAttention: 0,
      ownFaults: 0,
    });
    await register();
    await register({ status: "confirmed" });
    await register({ status: "cancelled" });
    await register({ courseId: online.id, courseSessionId: null });
    await db.insert(requests).values([
      { kind: "contact", payload: { name: "A", email: "a@example.com", message: "Tere" } },
      { kind: "contact", payload: { course: "e", intent: "purchase", email: "b@example.com" } },
      { kind: "contact", payload: { course: "e", intent: "purchase", email: "c@example.com" }, handled: true },
      { kind: "practice", payload: { name: "P", email: "p@example.com" } },
      { kind: "practice", payload: { name: "Q", email: "q@example.com" }, handled: true },
      { kind: "waitlist", payload: { name: "W", email: "w@example.com", session: session.id } },
    ]);
    await db.insert(subscribers).values([
      { email: "s1@example.com", token: "t1", confirmedAt: new Date() },
      { email: "s2@example.com", token: "t2" },
    ]);
    expect(await adminCounts(db, "maria@example.test", NOW)).toEqual({
      awaitingPrepayment: 2,
      openRequests: { contact: 2, individual: 0, practice: 1, waitlist: 1, change_request: 0 },
      subscribers: 2,
      confirmedSubscribers: 1,
      assessment: 0,
      todaySessions: [],
      waitingReviews: 0,
      paymentsAttention: 0,
      ownFaults: 0,
    });
  });
});

describe("subscriber export", () => {
  test("the rows it is given, in Estonian time, formula cells defused; the file is named after the state (piece3-texts P-13)", async () => {
    await db.insert(subscribers).values([
      { email: "ok@example.test", locale: "ru", token: "t1", consentAt: new Date("2026-09-30T09:00:00Z"), confirmedAt: new Date("2026-09-30T09:10:00Z") },
      { email: "wait@example.test", locale: "=cmd", token: "t2", consentAt: new Date("2026-10-01T11:05:00Z") },
    ]);
    expect(subscribersCsv(await listSubscribers(db)).split("\r\n")).toEqual([
      "\uFEFFE-post,Keel,Nõusolek,Kinnitatud,Kinnitamise aeg",
      "wait@example.test,'=CMD,2026-10-01 14:05,ei,",
      "ok@example.test,RU,2026-09-30 12:00,jah,2026-09-30 12:10",
      "",
    ]);
    // (a state is chosen by the query now, not by a flag of the file: the rows are what the file holds)
    expect(subscribersCsv(await listSubscribers(db, { state: "confirmed" })).split("\r\n")).toEqual([
      "\uFEFFE-post,Keel,Nõusolek,Kinnitatud,Kinnitamise aeg",
      "ok@example.test,RU,2026-09-30 12:00,jah,2026-09-30 12:10",
      "",
    ]);
    const day = new Date("2026-10-01T22:30:00Z"); // (already 2 October in Tallinn)
    expect(subscribersCsvName(day, null)).toBe("mslab-uudiskiri-2026-10-02.csv");
    expect(subscribersCsvName(day, "confirmed")).toBe("mslab-uudiskiri-kinnitatud-2026-10-02.csv");
    expect(subscribersCsvName(day, "pending")).toBe("mslab-uudiskiri-ootab-kinnitust-2026-10-02.csv");
  });
});

// Tellijad (admin UX pass, piece 3b Task 7; README B5, piece3-texts P-13, ruling R-h): the search by a part of an address, the two states, and the
// pills' counts.
describe("subscribers: search by address, the two states, the counts", () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour));
  let tokens = 0;
  const add = (email: string, confirmed: boolean, hour: number) =>
    db.insert(subscribers).values({ email, token: `tok${++tokens}`, consentAt: at(hour), confirmedAt: confirmed ? at(hour) : null });
  const emails = async (filter: Parameters<typeof listSubscribers>[1]) => (await listSubscribers(db, filter)).map((r) => r.email);

  test("the search finds an address by a part of it, in either case; empty text and spaces are no search; a part of nothing finds nothing", async () => {
    await add("kati.kask@example.test", true, 1);
    await add("mari@sample.example.test", false, 2);
    await add("TIINA@Example.TEST", true, 3);
    expect(await emails({ search: "kask" })).toEqual(["kati.kask@example.test"]);
    expect(await emails({ search: "KATI.K" })).toEqual(["kati.kask@example.test"]);
    expect(await emails({ search: "tiina@example" })).toEqual(["TIINA@Example.TEST"]);
    expect(await emails({ search: "@sample." })).toEqual(["mari@sample.example.test"]);
    expect(await emails({ search: "example.test" })).toEqual(["TIINA@Example.TEST", "mari@sample.example.test", "kati.kask@example.test"]); // (newest consent first)
    expect(await emails({ search: "" })).toHaveLength(3);
    expect(await emails({ search: "   " })).toHaveLength(3);
    expect(await emails({ search: undefined })).toHaveLength(3);
    expect(await emails({ search: "olematu" })).toEqual([]);
  });

  test("a percent sign, an underscore or a backslash in the search is the character itself, never a wildcard", async () => {
    await add("a_b@example.test", true, 1);
    await add("axb@example.test", true, 2);
    await add("50%off@example.test", true, 3);
    await add("500off@example.test", true, 4);
    await add("back\\slash@example.test", false, 5);
    expect(await emails({ search: "a_b" })).toEqual(["a_b@example.test"]);
    expect(await emails({ search: "_" })).toEqual(["a_b@example.test"]);
    expect(await emails({ search: "50%" })).toEqual(["50%off@example.test"]);
    expect(await emails({ search: "%" })).toEqual(["50%off@example.test"]);
    expect(await emails({ search: "k\\s" })).toEqual(["back\\slash@example.test"]);
    expect(await emails({ search: "\\" })).toEqual(["back\\slash@example.test"]);
    expect(await emails({ search: "%%" })).toEqual([]);
    expect(await emails({ search: "_%_" })).toEqual([]);
  });

  test("the state: „Kinnitatud“ has a confirmation time, „Ootab kinnitust“ has none; with the search; the page and the rows agree", async () => {
    await add("kati@example.test", true, 1);
    await add("kaie@example.test", false, 2);
    await add("mari@example.test", false, 3);
    await add("juta@example.test", true, 4);
    expect(await emails({ state: "confirmed" })).toEqual(["juta@example.test", "kati@example.test"]);
    expect(await emails({ state: "pending" })).toEqual(["mari@example.test", "kaie@example.test"]);
    expect(await emails({ search: "ka", state: "confirmed" })).toEqual(["kati@example.test"]);
    expect(await emails({ search: "ka", state: "pending" })).toEqual(["kaie@example.test"]);
    expect(await emails({ search: "ka" })).toEqual(["kaie@example.test", "kati@example.test"]);
    expect((await pageSubscribers(db, { search: "ka", state: "pending" }, 1)).rows.map((r) => r.email)).toEqual(["kaie@example.test"]);
    expect(await pageSubscribers(db, { state: "pending" }, 1, 1)).toMatchObject({ total: 2, pages: 2 });
  });

  test("the counts are the rows each pill shows: under the search, whatever state is chosen; sample addresses count like the rest (R-h)", async () => {
    await add("kati@example.test", true, 1);
    await add("kaie@example.test", false, 2);
    await add("mari@example.test", false, 3);
    await add("juta@sample.test", true, 4);
    await add("liis@sample.test", true, 5);
    expect(await subscriberCounts(db, {})).toEqual({ confirmed: 3, pending: 2 });
    expect(await subscriberCounts(db, { search: "ka" })).toEqual({ confirmed: 1, pending: 1 });
    expect(await subscriberCounts(db, { search: "sample" })).toEqual({ confirmed: 2, pending: 0 });
    expect(await subscriberCounts(db, { search: "nobody" })).toEqual({ confirmed: 0, pending: 0 });
    // (the state chosen now is no part of the counts: both pills keep their numbers)
    expect(await subscriberCounts(db, { search: "ka", state: "confirmed" })).toEqual({ confirmed: 1, pending: 1 });
    for (const search of [undefined, "ka", "sample", "example.test", "%", "nobody"]) {
      const counts = await subscriberCounts(db, { search });
      expect(counts.confirmed, `${search}: confirmed`).toBe((await listSubscribers(db, { search, state: "confirmed" })).length);
      expect(counts.pending, `${search}: pending`).toBe((await listSubscribers(db, { search, state: "pending" })).length);
      expect(counts.confirmed + counts.pending, `${search}: all`).toBe((await listSubscribers(db, { search })).length);
      expect(await countSubscribers(db, { search }), `${search}: count`).toBe(counts.confirmed + counts.pending);
      expect(await countSubscribers(db, { search, state: "confirmed" })).toBe(counts.confirmed);
      expect(await countSubscribers(db, { search, state: "pending" })).toBe(counts.pending);
    }
  });
});

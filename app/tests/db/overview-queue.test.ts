import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { adminCounts } from "@/db/queries/admin";
import { overviewQueue } from "@/db/queries/overview";
import { courseSessions, invoices, payments, protocols, registrations, requests, reviews } from "@/db/schema";
import { at as hour, attempt, ecourse, practical, student } from "./hindamine-fixtures";
import { makeTestDb } from "./helpers";
import { contactCourse, pendingPayment, registrationOn } from "./payments-fixtures";
import { protocolCourse, student as protocolStudent } from "./protocols-fixtures";

// „Sinu järjekord“ on the overview (admin UX pass piece 2, A1; README A1, P-1) on a real (PGlite) database: what waits for Maria, per source — the
// registrations awaiting their prepayment, the Hindamine items, the open requests (Muutmine too), the paid payments with no invoice, the reviews
// waiting for „Avalda“ and the payments that need a look — each with its count and, where the hint names one, its oldest row. Unbilled and
// „needs a look“ are counted apart, and every number is the one the menu badges show. And the page that shows them (A1), rendered to HTML: the
// „Täna“ cards, the queue in README order with its P-1 hints, the empty queue, and the next sessions.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test", adminName: () => "Maria" }));

import Overview from "@/app/admin/(panel)/page";

const NOW = new Date("2026-10-21T09:00:00Z");
const ME = "maria@example.test";
/** `day` October 2026 at 09:00 UTC. */
const oct = (day: number) => new Date(Date.UTC(2026, 9, day, 9));

let db: Db;
let fixture: Awaited<ReturnType<typeof contactCourse>>;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  fixture = await contactCourse(db, { capacity: 100 });
});

const queue = () => overviewQueue(db, NOW);

describe("nothing waits", () => {
  test("every count is 0, no oldest row, no reason", async () => {
    expect(await queue()).toEqual({
      awaiting: { count: 0, oldest: null },
      assessment: { count: 0, practical: 0, test: 0, triesUsed: 0 },
      requests: { count: 0, byKind: { contact: 0, individual: 0, practice: 0, waitlist: 0, change_request: 0 } },
      unbilled: { count: 0, oldest: null },
      reviews: { count: 0, oldest: null },
      check: { count: 0, oldest: null, reason: null },
    });
  });
});

describe("awaiting: registrations that wait for their prepayment", () => {
  test("counts them and names the oldest by when it was made; confirmed and cancelled ones are not waiting", async () => {
    await registrationOn(db, fixture, { name: "Mari Kask", email: "mari@example.test", createdAt: oct(15) });
    await registrationOn(db, fixture, { name: "Anu Aas", email: "anu@example.test", createdAt: oct(12) });
    await registrationOn(db, fixture, { name: "Kati Tamm", email: "kati@example.test", createdAt: oct(18) });
    await registrationOn(db, fixture, { name: "Old Confirmed", email: "c@example.test", createdAt: oct(1), status: "confirmed" });
    await registrationOn(db, fixture, { name: "Old Cancelled", email: "x@example.test", createdAt: oct(2), status: "cancelled" });
    expect((await queue()).awaiting).toEqual({ count: 3, oldest: { at: oct(12), name: "Anu Aas" } });
  });
});

describe("assessment: what waits in Hindamine", () => {
  test("a practical work, a test answer and a student out of tries, counted apart", async () => {
    const course = await ecourse(db);
    const anu = await student(db, course.id, "Anu");
    await practical(db, anu, 1, null, hour(8));
    const berit = await student(db, course.id, "Berit");
    await practical(db, berit, 1, null, hour(9));
    const eve = await student(db, course.id, "Eve");
    await attempt(db, eve, course.id, 1, "review", hour(7));
    const gea = await student(db, course.id, "Gea");
    for (const n of [1, 2]) await attempt(db, gea, course.id, n, "failed", hour(n), { correct: 0 });
    expect((await queue()).assessment).toEqual({ count: 4, practical: 2, test: 1, triesUsed: 1 });
  });
});

describe("requests: not marked done, every kind", () => {
  test("a Muutmine request counts with the rest; a done one does not", async () => {
    await db.insert(requests).values([
      { kind: "contact", payload: { name: "A", email: "a@example.test" } },
      { kind: "contact", payload: { name: "B", email: "b@example.test", intent: "purchase" } },
      { kind: "individual", payload: { name: "C", email: "c@example.test" } },
      { kind: "practice", payload: { name: "D", email: "d@example.test" } },
      { kind: "waitlist", payload: { name: "E", email: "e@example.test" } },
      { kind: "waitlist", payload: { name: "F", email: "f@example.test" } },
      { kind: "change_request", payload: { name: "G", email: "g@example.test" } },
      { kind: "change_request", payload: { name: "H", email: "h@example.test" }, handled: true },
    ]);
    expect((await queue()).requests).toEqual({ count: 7, byKind: { contact: 2, individual: 1, practice: 1, waitlist: 2, change_request: 1 } });
  });
});

describe("unbilled and check are counted apart", () => {
  const AT = oct(10);
  /** A payment of its own registration in `status` (a paid or voided one carries its pay day `paidAt`; `reason` a held one's check reason). */
  async function payment(email: string, status: "pending" | "paid" | "failed" | "held" | "refunded" | "replaced", over: { name?: string; paidAt?: Date | null; reason?: "double" | null } = {}) {
    const r = await registrationOn(db, fixture, { email, name: over.name ?? "Kati Tamm" });
    const p = await pendingPayment(db, r, {}, AT);
    await db.update(payments).set({ status, paidAt: over.paidAt ?? null, checkReason: over.reason ?? null, name: over.name ?? "Kati Tamm" }).where(eq(payments.id, p.id));
    return p;
  }
  async function invoiceFor(paymentId: number, n: number) {
    const [reg] = await db.select({ id: payments.registrationId }).from(payments).where(eq(payments.id, paymentId));
    await db.insert(invoices).values({
      number: `MSL2026-00${n}`, prefix: "MSL", year: 2026, seq: n, kind: "prepayment", registrationId: reg.id, paymentId, courseId: fixture.course.id, amountCents: 17500, vatRate: null,
      line: { course: "K", session: "14.11.2026 Tallinn", part: "Ettemaks 50%" },
      seller: { company: "MS LAB OÜ", registryCode: "12345678", address: "Pärnu mnt 1", vatNumber: "", receiver: "MS LAB OÜ", iban: "EE000000000000000000", bank: "Pank" },
      buyer: { name: "Kati Tamm", email: "kati@example.test", address: "", company: "", companyCode: "", companyAddress: "" },
      issuedAt: AT,
    });
  }

  test("a paid payment no invoice names is unbilled; the oldest by its pay day, with the payer's name", async () => {
    await payment("a@example.test", "paid", { name: "Mari Kask", paidAt: oct(14) });
    await payment("b@example.test", "paid", { name: "Anu Aas", paidAt: oct(11) });
    const billed = await payment("c@example.test", "paid", { name: "Billed", paidAt: oct(9) });
    await invoiceFor(billed.id, 1);
    expect(await queue()).toMatchObject({ unbilled: { count: 2, oldest: { at: oct(11), name: "Anu Aas" } }, check: { count: 0 } });
  });

  test("a held payment counts under check and not under unbilled", async () => {
    await payment("held@example.test", "held", { name: "Held One", paidAt: oct(13) });
    expect(await queue()).toMatchObject({ unbilled: { count: 0, oldest: null }, check: { count: 1, oldest: { at: oct(13), name: "Held One" }, reason: null } });
  });

  test("a held payment with no pay day is dated by when it was made", async () => {
    const p = await payment("held@example.test", "held", { name: "Held One" });
    const [row] = await db.select({ createdAt: payments.createdAt }).from(payments).where(eq(payments.id, p.id));
    expect((await queue()).check.oldest).toEqual({ at: row.createdAt, name: "Held One" });
  });

  test("a payment voided after it was paid counts under check, a failed one that was never paid counts nowhere", async () => {
    await payment("voided@example.test", "failed", { name: "Voided One", paidAt: oct(12) });
    await payment("failed@example.test", "failed", { name: "Failed One" });
    await payment("pending@example.test", "pending");
    await payment("refunded@example.test", "refunded", { paidAt: oct(8) });
    await payment("replaced@example.test", "replaced");
    expect(await queue()).toMatchObject({ unbilled: { count: 0 }, check: { count: 1, oldest: { name: "Voided One" } } });
  });

  test("the oldest check row says why: its check reason, or none", async () => {
    await payment("plain@example.test", "held", { name: "Plain", paidAt: oct(16) });
    await payment("double@example.test", "held", { name: "Double", paidAt: oct(12), reason: "double" });
    expect((await queue()).check).toEqual({ count: 2, oldest: { at: oct(12), name: "Double" }, reason: "double" });
    await db.update(payments).set({ checkReason: null }).where(eq(payments.status, "held"));
    await db.update(payments).set({ paidAt: oct(11) }).where(eq(payments.name, "Plain"));
    expect((await queue()).check).toMatchObject({ oldest: { name: "Plain" }, reason: null });
  });

  test("a check reason this code does not know is no reason (a newer version wrote it)", async () => {
    await payment("new@example.test", "held", { name: "New", paidAt: oct(12) });
    await db.update(payments).set({ checkReason: "from-the-future" as never });
    expect((await queue()).check).toMatchObject({ count: 1, reason: null });
  });
});

describe("reviews: waiting for „Avalda“", () => {
  const review = (status: "pending" | "published" | "hidden", name: string, writtenAt: Date) => ({
    courseId: fixture.course.id,
    kind: "manual" as const,
    text: `Arvustus ${name}`,
    name,
    locale: "et" as const,
    writtenAt,
    status,
  });

  test("counts the pending ones; the oldest by when it was written, not by when it was stored", async () => {
    await db.insert(reviews).values([
      review("pending", "Kristel M.", oct(14)),
      review("pending", "Liis T.", oct(3)),
      review("pending", "Mari K.", oct(9)),
      review("published", "Published", oct(1)),
      review("hidden", "Hidden", oct(2)),
    ]);
    expect((await queue()).reviews).toEqual({ count: 3, oldest: { at: oct(3), name: "Liis T." } });
  });
});

describe("the numbers are the menu badges'", () => {
  test("awaiting, requests, reviews, assessment and unbilled + check equal what adminCounts counts", async () => {
    const course = await ecourse(db);
    await registrationOn(db, fixture, { email: "a@example.test" });
    await registrationOn(db, fixture, { email: "b@example.test" });
    await db.insert(requests).values([
      { kind: "contact", payload: { name: "A", email: "a@example.test" } },
      { kind: "change_request", payload: { name: "B", email: "b@example.test" } },
      { kind: "waitlist", payload: { name: "C", email: "c@example.test" } },
    ]);
    await db.insert(reviews).values({ courseId: fixture.course.id, kind: "manual", text: "T", name: "N", locale: "et", writtenAt: oct(1), status: "pending" });
    await practical(db, await student(db, course.id, "Anu"), 1, null, hour(8));
    await attempt(db, await student(db, course.id, "Eve"), course.id, 1, "review", hour(7));
    for (const [email, status, paidAt] of [["p1@example.test", "paid", oct(5)], ["p2@example.test", "held", null], ["p3@example.test", "failed", oct(6)]] as const) {
      const r = await registrationOn(db, fixture, { email });
      const p = await pendingPayment(db, r, {}, oct(4));
      await db.update(payments).set({ status, paidAt }).where(eq(payments.id, p.id));
    }
    const [q, counts] = [await queue(), await adminCounts(db, ME, NOW)];
    expect(q.awaiting.count).toBe(counts.awaitingPrepayment);
    expect(q.requests.count).toBe(Object.values(counts.openRequests).reduce((a, b) => a + b, 0));
    expect(q.reviews.count).toBe(counts.waitingReviews);
    expect(q.assessment.count).toBe(counts.assessment);
    expect(q.unbilled.count + q.check.count).toBe(counts.paymentsAttention);
    expect([q.unbilled.count, q.check.count]).toEqual([1, 2]);
    expect(await db.select().from(registrations).where(eq(registrations.status, "awaiting_prepayment"))).toHaveLength(5); // (the three payments' registrations wait too)
    expect(q.awaiting.count).toBe(5);
  });
});

// ---------- the page (A1) ----------

describe("the overview page", () => {
  /** The tags dropped (each leaves a space), the entities of `&` undone, the white space made single. */
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  /** One queue row: where it goes and what it says. */
  function row(html: string, key: string) {
    const m = new RegExp(`<a [^>]*data-overview-row="${key}"[^>]*>(.*?)</a>`).exec(html);
    expect(m, `the row ${key}`).not.toBeNull();
    return { href: /href="([^"]*)"/.exec(m![0])![1].replace(/&amp;/g, "&"), text: text(m![1]) };
  }
  const rowKeys = (html: string) => [...html.matchAll(/data-overview-row="(\w+)"/g)].map((m) => m[1]);
  /** One session's card: where its button goes and what it says. */
  function card(html: string, id: number) {
    const m = new RegExp(`<section [^>]*data-today-session="${id}"[^>]*>(.*?)</section>`).exec(html);
    expect(m, `the Täna card of ${id}`).not.toBeNull();
    return { href: /href="([^"]*)"/.exec(m![1])![1], text: text(m![1]) };
  }
  const todayIds = (html: string) => [...html.matchAll(/data-today-session="(\d+)"/g)].map((m) => Number(m[1]));
  const render = async () => renderToStaticMarkup(await Overview());
  const sessionAt = async (startsAt: string, over: Partial<typeof courseSessions.$inferInsert> = {}) =>
    (await db.insert(courseSessions).values({ courseId: fixture.course.id, startsAt: new Date(startsAt), city: "Tallinn", venue: "", capacity: 4, ...over }).returning())[0];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW); // Wednesday 21.10.2026, 12:00 in Tallinn
    await db.update(courseSessions).set({ startsAt: new Date("2027-06-01T08:00:00Z") }); // (the fixture's own session, far off: the registrations below sit on it)
  });
  afterEach(() => vi.useRealTimers());

  test("the heading is the date and „Tere, Maria.“; the button, the tiles and the cards of old are gone", async () => {
    const html = await render();
    expect(text(html)).toContain("Kolmapäev, 21. oktoober Tere, Maria.");
    expect(html).toMatch(/<h1[^>]*>Tere, Maria\.<\/h1>/);
    for (const gone of ["Sinu koolituskeskuse järgmised sammud", "Vaata registreerimisi", "data-stat", "Kinnitatud uudiskirja tellijad", "Tegemata päringud", "Kiirlingid", "Lae alla kinnitatud tellijad", "data-inbox", "data-overview-assessment", "Ootab hindamist:"])
      expect(html, gone).not.toContain(gone);
  });

  describe("„Täna“", () => {
    test("one dark card per session today, earliest first: when and where, the course, the students and their protocols, and the way to the protocols", async () => {
      const { course } = await protocolCourse(db);
      const [morning, afternoon] = [await sessionAt("2026-10-21T07:00:00Z", { courseId: course.id, city: "Pärnu", venue: "MS LAB stuudio" }), await sessionAt("2026-10-21T12:00:00Z", { courseId: course.id, city: "Tartu" })];
      await sessionAt("2026-10-22T07:00:00Z", { courseId: course.id, city: "Narva" }); // tomorrow
      const [mari, anu, kati] = [
        await protocolStudent(db, course, morning, "Mari Maasikas"),
        await protocolStudent(db, course, morning, "Anu Aas"),
        await protocolStudent(db, course, morning, "Kati Kask"),
      ];
      await protocolStudent(db, course, morning, "Liis Lepp"); // no protocol yet
      await protocolStudent(db, course, morning, "Tiina Tamm", { status: "cancelled" }); // not listed
      await db.insert(protocols).values([
        { registrationId: mari.id, stages: [], version: 1, sent: { stages: [], generalNote: "" }, sentAt: new Date("2026-10-21T08:00:00Z"), sentVersion: 1 },
        { registrationId: anu.id, stages: [], version: 1 },
        { registrationId: kati.id, stages: [], version: 2, sent: { stages: [], generalNote: "" }, sentAt: new Date("2026-10-21T08:00:00Z"), sentVersion: 1 }, // sent, then edited: not sent
      ]);
      const html = await render();
      expect(todayIds(html)).toEqual([morning.id, afternoon.id]);
      expect(card(html, morning.id)).toEqual({
        href: `/admin/protokollid?sessioon=${morning.id}`,
        text: "Täna 10:00 · Pärnu, MS LAB stuudio Kulmude lamineerimine 4 õpilast · protokollid: 1 saadetud, 2 mustand, 1 alustamata Ava protokollid →",
      });
      expect(card(html, afternoon.id).text).toBe("Täna 15:00 · Tartu Kulmude lamineerimine 0 õpilast · protokollid: 0 saadetud, 0 mustand, 0 alustamata Ava protokollid →");
    });

    test("no card on a day with no session; a called-off session of today is not one", async () => {
      await sessionAt("2026-10-21T07:00:00Z", { status: "cancelled" });
      await sessionAt("2026-10-22T07:00:00Z");
      expect(todayIds(await render())).toEqual([]);
    });

    test("at 23:30 UTC the day before, a session at 00:30 Tallinn time counts as today (and one at 23:30 the evening before does not)", async () => {
      vi.setSystemTime(new Date("2026-11-30T23:30:00Z")); // 01:30 on 1.12 in Tallinn
      const { course } = await protocolCourse(db);
      const night = await sessionAt("2026-11-30T22:30:00Z", { courseId: course.id, city: "Pärnu" }); // 00:30 on 1.12
      await sessionAt("2026-11-30T21:30:00Z", { courseId: course.id, city: "Narva" }); // 23:30 on 30.11
      await sessionAt("2026-12-01T22:30:00Z", { courseId: course.id, city: "Viljandi" }); // 00:30 on 2.12
      const html = await render();
      expect(todayIds(html)).toEqual([night.id]);
      expect(card(html, night.id).text).toContain("Täna 00:30 · Pärnu");
      expect(text(html)).toContain("Teisipäev, 1. detsember");
    });
  });

  describe("„Sinu järjekord“", () => {
    test("an empty queue says so, and the next sessions stay below it", async () => {
      await sessionAt("2026-10-28T08:00:00Z");
      const html = await render();
      expect(rowKeys(html)).toEqual([]);
      expect(html).not.toContain("Sinu järjekord");
      expect(text(html)).toContain("Järjekord on tühi. Kõik on tehtud. Uued registreerimised ja päringud ilmuvad siia.");
      expect(html.indexOf("Järjekord on tühi.")).toBeLessThan(html.indexOf("Tulevased koolitused"));
    });

    test("every source in README order, each with its count, its P-1 hint and its target", async () => {
      await registrationOn(db, fixture, { name: "Mari Kask", email: "mari@example.test", createdAt: oct(15) });
      await registrationOn(db, fixture, { name: "Мария Кузнецова", email: "maria2@example.test", createdAt: oct(12) });
      const course = await ecourse(db);
      await practical(db, await student(db, course.id, "Anu"), 1, null, hour(8));
      await attempt(db, await student(db, course.id, "Eve"), course.id, 1, "review", hour(7));
      await db.insert(requests).values([
        { kind: "contact", payload: { name: "A", email: "a@example.test" } },
        { kind: "contact", payload: { name: "B", email: "b@example.test" } },
        { kind: "individual", payload: { name: "C", email: "c@example.test" } },
        { kind: "waitlist", payload: { name: "D", email: "d@example.test" } },
        { kind: "change_request", payload: { name: "E", email: "e@example.test" } },
      ]);
      const pay = async (email: string, name: string, status: "paid" | "held", paidAt: Date, reason: "double" | null = null) => {
        const r = await registrationOn(db, fixture, { email, name, status: "confirmed" });
        const p = await pendingPayment(db, r, {}, oct(4));
        await db.update(payments).set({ status, paidAt, name, checkReason: reason }).where(eq(payments.id, p.id));
      };
      await pay("p1@example.test", "Mari Tamm", "paid", oct(14));
      await pay("p2@example.test", "Kati Kuusk", "paid", oct(16));
      await pay("p3@example.test", "Анна Иванова", "held", oct(12), "double");
      await db.insert(reviews).values({ courseId: fixture.course.id, kind: "manual", text: "T", name: "Kristel M.", locale: "et", writtenAt: oct(3), status: "pending" });

      const html = await render();
      expect(rowKeys(html)).toEqual(["awaiting", "assessment", "requests", "unbilled", "reviews", "check"]);
      expect(text(html)).toContain("Sinu järjekord");
      expect(row(html, "awaiting")).toEqual({ href: "/admin/registreerimised?staatus=ootab", text: "2 Ootab ettemaksu Vanim 12.10 · Мария Кузнецова →" });
      expect(row(html, "assessment")).toEqual({ href: "/admin/hindamine", text: "2 Ootab hindamist 1 praktiline töö · 1 testi vastus →" });
      expect(row(html, "requests")).toEqual({ href: "/admin/paringud", text: "5 Päringut tegemata 2 kontakt · 1 individuaal · 1 ootenimekiri · 1 muutmine →" });
      expect(row(html, "unbilled")).toEqual({ href: "/admin/arved#arveta", text: "2 Arveta makset Vanim 14.10 · Mari Tamm →" });
      expect(row(html, "reviews")).toEqual({ href: "/admin/tagasiside?vaade=arvustused&olek=ootel", text: "1 Arvustus ootab avaldamist Vanim 03.10 · Kristel M. →" });
      expect(row(html, "check")).toEqual({ href: "/admin/maksed?staatus=kontroll", text: "1 Makse ootel kontrollil Vanim 12.10 · Анна Иванова · Topeltmakse — tagasta →" });
      expect(html).not.toContain("Järjekord on tühi.");
    });

    test("a row with 0 is not drawn: only what waits is there", async () => {
      await db.insert(requests).values({ kind: "practice", payload: { name: "P", email: "p@example.test" } });
      const html = await render();
      expect(rowKeys(html)).toEqual(["requests"]);
      expect(row(html, "requests").text).toBe("1 Päringut tegemata 1 praktika →");
    });

    test("the hint of a payment to check with no reason says what to do; a held payment is never in „Arveta makset“", async () => {
      const r = await registrationOn(db, fixture, { email: "h@example.test", name: "Held One", status: "confirmed" });
      const p = await pendingPayment(db, r, {}, oct(4));
      await db.update(payments).set({ status: "held", paidAt: oct(13), name: "Held One" }).where(eq(payments.id, p.id));
      const html = await render();
      expect(rowKeys(html)).toEqual(["check"]);
      expect(row(html, "check").text).toBe("1 Makse ootel kontrollil Vanim 13.10 · Held One · kontrolli Montonios →");
    });
  });

  describe("„Tulevased koolitused“", () => {
    test("the next five sessions, each a link to its Kalender drawer; the note counts the next 30 days, to the end of the Tallinn day; a called-off one is left out; the seats red at 0", async () => {
      const today = await sessionAt("2026-10-21T07:00:00Z", { city: "Pärnu" }); // earlier today: still listed
      const full = await sessionAt("2026-10-28T08:00:00Z", { city: "Tartu", capacity: 2 });
      for (const email of ["a@example.test", "b@example.test"])
        await db.insert(registrations).values({ courseId: fixture.course.id, courseSessionId: full.id, kind: "group", name: email, email, paymentChoice: "half", status: "confirmed" });
      await sessionAt("2026-10-30T08:00:00Z", { status: "cancelled", city: "Narva" });
      const last = await sessionAt("2026-11-20T21:30:00Z", { city: "Viljandi" }); // 23:30 on 20.11: the 30th day after today
      const after = await sessionAt("2026-11-20T22:30:00Z", { city: "Haapsalu" }); // 00:30 on 21.11: the 31st
      const edge = await sessionAt("2026-11-20T08:00:00Z", { city: "Rakvere" });
      await sessionAt("2026-12-15T08:00:00Z", { city: "Kuressaare" }); // the sixth: not a row
      const html = await render();
      expect([...html.matchAll(/data-upcoming-session="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([today.id, full.id, edge.id, last.id, after.id]);
      expect(text(html)).toContain("Tulevased koolitused järgmise 30 päeva jooksul: 4");
      expect(html).not.toContain("Narva");
      expect(html).not.toContain("Kuressaare");
      const link = (id: number) => new RegExp(`<a [^>]*data-upcoming-session="${id}"[^>]*>(.*?)</a>`).exec(html)!;
      expect(link(full.id)[0]).toContain(`href="/admin/kalender?id=${full.id}"`);
      expect(text(link(full.id)[1])).toBe("28.10 Kulmumeistri baaskoolitus Tartu Vabu kohti 0 / 2");
      expect(link(full.id)[0]).toContain('data-seats-left="0"');
      expect(text(link(today.id)[1])).toBe("21.10 Kulmumeistri baaskoolitus Pärnu Vabu kohti 4 / 4");
      expect(link(today.id)[0]).toContain('data-seats-left="4"');
      expect(text(html)).toContain("Kuupäev Koolitus ja linn Vabu kohti");
      expect(html).toMatch(/<a [^>]*href="\/admin\/kalender"[^>]*>Kalender →<\/a>/);
    });

    test("no session in the next 30 days: the note says 0, and the next one further off is still a row", async () => {
      const far = await sessionAt("2026-12-15T08:00:00Z", { city: "Tartu" });
      const html = await render();
      expect(text(html)).toContain("järgmise 30 päeva jooksul: 0");
      expect(html).toContain(`data-upcoming-session="${far.id}"`);
    });
  });
});

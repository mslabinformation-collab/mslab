import { desc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clientLoginTokens, clients, clientSessions, courseAccess, courses, payments, registrations, subscribers } from "@/db/schema";
import { formatDate } from "@/i18n/format";
import type { PublicChange } from "@/server/cache-targets";
import * as adminClients from "@/server/admin-clients";
import { issueClientLogin, lockAddress, redeemClientCode, redeemClientLink } from "@/server/client-auth";
import type { Env } from "@/server/notify";
import { settleToken } from "@/server/payments/settle";
import { ECOURSE_BUY_LOCK_CLASS, lockEcoursePurchase, startEcoursePayment } from "@/server/payments/start";
import { handleEcoursePurchase, type Deps } from "@/server/submit";
import { fakeKv } from "../fakes";
import { contactCourse, orderToken, registrationOn, settleDeps, SITE, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// The e-course purchase (phase 2b, spec 6.4, 6.2.3): the cart's action creates only a pending payment and Montonio's order; when it is paid,
// the client is found or created, the course opens for her (by "payment"), the newsletter follows when ticked, and she gets "E-koolitus on
// avatud" with a login code. Nothing happens before the payment.

const NOW = new Date("2026-10-09T10:00:00Z");
const MIN = 60_000;
let db: Db;
let ecourseId: number;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  const [c] = await db
    .insert(courses)
    .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
    .returning();
  ecourseId = c.id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function formDeps(montonio: Deps["montonio"], opts: { now?: Date; kv?: ReturnType<typeof fakeKv> } = {}) {
  const changes: PublicChange[] = [];
  const env: Env = { KV: opts.kv ?? fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE };
  const d: Deps = { db, env, ip: "203.0.113.9", siteUrl: SITE, now: opts.now ?? NOW, later: () => {}, changed: (c) => void changes.push(c), montonio };
  return d;
}
const form = (over: Record<string, string> = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ course: "kulmumeistri-e-koolitus", name: "Kati Tamm", email: "kati@example.com", terms: "on", locale: "et", ...over })) fd.set(k, v);
  return fd;
};

/**
 * Buys the e-course as `over.email` and settles its PAID token, both at `at` (NOW); the settlement's deps (flush, the mails). The same address
 * cannot buy the same course twice within 30 minutes (alreadyPaid), so a test that buys again passes a later `at`.
 */
async function buyAndPay(m: ReturnType<typeof stubMontonio>, over: Record<string, string> = {}, at: Date = NOW) {
  expect(await handleEcoursePurchase(formDeps(m.montonio, { now: at }), form(over))).toMatchObject({ ok: true });
  const [p] = await db.select().from(payments).orderBy(desc(payments.id)).limit(1);
  const s = settleDeps(db, m.montonio, at);
  await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)));
  await s.flush();
  return { p, ...s };
}

/** The rows of an `execute` (PGlite answers { rows }, postgres-js the array itself). */
const rowsOf = <T,>(result: unknown): T[] => (Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows);

/** The rows a purchase must not leave before (or without) a payment. */
const accountRows = async () => [await db.select().from(clients), await db.select().from(courseAccess), await db.select().from(subscribers), await db.select().from(clientLoginTokens), await db.select().from(clientSessions)];

describe("the purchase (before the payment)", () => {
  test("a pending ecourse row of 190 € with the payer as entered and her newsletter wish; Montonio's order; nothing else", async () => {
    const m = stubMontonio();
    const result = await handleEcoursePurchase(formDeps(m.montonio), form({ newsletter: "on", locale: "ru" }));
    const [p] = await db.select().from(payments);
    expect(result).toEqual({ ok: true, paymentUrl: `https://sandbox-stargate.montonio.com/${p.providerUuid}` });
    expect(p).toMatchObject({ kind: "ecourse", status: "pending", amountCents: 19000, courseId: ecourseId, registrationId: null, clientId: null, email: "kati@example.com", name: "Kati Tamm", locale: "ru", newsletter: true });
    expect(p.createdAt).toEqual(NOW); // the time of the terms box's acceptance
    expect(m.state.orders).toEqual([expect.objectContaining({ merchantReference: p.reference, grandTotal: 190, locale: "ru" })]);
    expect(await accountRows()).toEqual([[], [], [], [], []]);
    expect(m.mails()).toEqual([]);
  });

  test("the price is the course's, never the browser's: a price in the form is not read", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ price: "1", amount: "0.01", amountCents: "1", grandTotal: "1" }))).toMatchObject({ ok: true });
    expect((await db.select().from(payments))[0].amountCents).toBe(19000);
    expect(m.state.orders).toEqual([expect.objectContaining({ grandTotal: 190 })]);
  });

  test("not a published e-course with a price: form invalid; no payments or Montonio down: form unavailable", async () => {
    const m = stubMontonio();
    await db.insert(courses).values({ slug: "kontakt", type: "contact", level: "basic", title: { et: "K" }, summary: { et: "" }, body: { et: "" }, published: true, priceGroup: 100 });
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ course: "kontakt" }))).toEqual({ ok: false, errors: { form: "invalid" } });
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ course: "olematu" }))).toEqual({ ok: false, errors: { form: "invalid" } });
    expect(await handleEcoursePurchase(formDeps(null), form())).toEqual({ ok: false, errors: { form: "unavailable" } });
    m.state.down = true;
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toEqual({ ok: false, errors: { form: "unavailable" } });
    expect((await db.select().from(payments)).map((p) => p.status)).toEqual(["failed"]);
  });

  test("a draft, or an e-course with no price, cannot be bought", async () => {
    const m = stubMontonio();
    await db.update(courses).set({ published: false }).where(eq(courses.id, ecourseId));
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toEqual({ ok: false, errors: { form: "invalid" } });
    await db.update(courses).set({ published: true, price: null }).where(eq(courses.id, ecourseId));
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toEqual({ ok: false, errors: { form: "invalid" } });
    expect(await db.select().from(payments)).toEqual([]);
    expect(m.state.orders).toEqual([]);
  });

  test("the forms' pipeline: the honeypot looks like success and stores nothing; the terms box and a good address are required; the 6th press in 10 minutes is refused", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ website: "https://spam.example" }))).toEqual({ ok: true });
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ terms: "" }))).toEqual({ ok: false, errors: { terms: "required" } });
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ email: "vale" }))).toEqual({ ok: false, errors: { email: "invalid" } });
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ name: "" }))).toEqual({ ok: false, errors: { name: "required" } });
    expect(await db.select().from(payments)).toEqual([]);
    expect(m.state.orders).toEqual([]);
    const kv = fakeKv();
    for (let i = 1; i <= 5; i++) expect(await handleEcoursePurchase(formDeps(m.montonio, { kv }), form()), String(i)).toMatchObject({ ok: true });
    expect(await handleEcoursePurchase(formDeps(m.montonio, { kv }), form())).toEqual({ ok: false, errors: { form: "rate" } });
    expect(m.state.orders).toHaveLength(5); // the 6th did not reach Montonio
    expect(await db.select().from(payments)).toHaveLength(1); // (the five were one purchase pressed again)
  });

  test("'Maksa' again while the purchase's order is open re-sends it: one row, one reference, the latest name and box; another address is another purchase (the double-payment fix)", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toMatchObject({ ok: true });
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ name: "Kati Kask", newsletter: "on" }))).toMatchObject({ ok: true });
    const [p, ...none] = await db.select().from(payments);
    expect(none).toEqual([]);
    expect(p).toMatchObject({ status: "pending", name: "Kati Kask", newsletter: true, amountCents: 19000 });
    expect(m.state.orders.map((o) => o.merchantReference)).toEqual([p.reference, p.reference]);
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ email: "mari@example.com" }))).toMatchObject({ ok: true });
    expect(await db.select().from(payments)).toHaveLength(2);
  });

  test("two presses at the same moment are one purchase: one row, never a second order", async () => {
    const m = stubMontonio();
    const answers = await Promise.all([handleEcoursePurchase(formDeps(m.montonio), form()), handleEcoursePurchase(formDeps(m.montonio), form({ name: "Kati T." }))]);
    expect(answers).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    const rows = await db.select().from(payments);
    expect(rows).toHaveLength(1);
    expect(m.state.orders.map((o) => o.merchantReference)).toEqual([rows[0].reference, rows[0].reference]);
  });

  test("the open order is the same course, address, price and Montonio's 30 minutes: a changed price, an older order or a failed one is a new purchase", async () => {
    const m = stubMontonio();
    const start = (now: Date, email = "kati@example.com") => startEcoursePayment({ db, now, siteUrl: SITE, notifyBase: SITE, montonio: m.montonio }, { courseId: ecourseId, amountCents: 19000, email, name: "Kati Tamm", locale: "et", newsletter: false });
    expect(await start(NOW)).toMatchObject({ kind: "started" });
    expect(await start(new Date(NOW.getTime() + 29 * MIN))).toMatchObject({ kind: "started" }); // the window starts again at each re-send
    expect(await db.select().from(payments)).toHaveLength(1);
    expect(await start(new Date(NOW.getTime() + 29 * MIN + 31 * MIN))).toMatchObject({ kind: "started" }); // 31 minutes after the last one
    expect(await db.select().from(payments)).toHaveLength(2);
    const price = await startEcoursePayment({ db, now: NOW, siteUrl: SITE, notifyBase: SITE, montonio: m.montonio }, { courseId: ecourseId, amountCents: 20000, email: "kati@example.com", name: "Kati Tamm", locale: "et", newsletter: false });
    expect(price).toMatchObject({ kind: "started" });
    expect((await db.select().from(payments)).map((p) => p.amountCents)).toEqual([19000, 19000, 20000]);
    // a failed one: Montonio is down, the row fails, and the next press makes a new row with a new reference (a failed row is never re-sent)
    m.state.down = true;
    expect(await start(NOW, "mari@example.com")).toEqual({ kind: "failed" });
    m.state.down = false;
    expect(await start(NOW, "mari@example.com")).toMatchObject({ kind: "started" });
    const mari = (await db.select().from(payments)).filter((p) => p.email === "mari@example.com");
    expect(mari.map((p) => p.status)).toEqual(["failed", "pending"]);
    expect(new Set(mari.map((p) => p.reference)).size).toBe(2);
    expect(m.state.orders.at(-1)?.merchantReference).toBe(mari[1].reference);
    expect(await startEcoursePayment({ db, now: NOW, siteUrl: SITE, notifyBase: SITE, montonio: null }, { courseId: ecourseId, amountCents: 19000, email: "kati@example.com", name: "K", locale: "et", newsletter: false })).toEqual({ kind: "off" });
  });
});

// Dim's decision of 10.10: after paying, Back from the bank re-arms "Maksa", and the paid row no longer matches the open attempt (liveAttempt), so a
// second press would charge a second time. An address that has a paid (or held) payment for this course in the last 30 minutes starts nothing.
describe("an e-course paid a moment ago is not charged again", () => {
  const press = (m: ReturnType<typeof stubMontonio>, minutes: number, over: Record<string, string> = {}) =>
    handleEcoursePurchase(formDeps(m.montonio, { now: new Date(NOW.getTime() + minutes * MIN) }), form(over));
  const ALREADY = { ok: false, errors: { form: "alreadyPaid" } };

  test("paid 10 minutes ago: 'alreadyPaid', no new row and no Montonio order, and the answer reveals nothing but that; the last minute of the 30 still counts", async () => {
    const m = stubMontonio();
    await buyAndPay(m);
    const before = { rows: await db.select().from(payments), orders: m.state.orders.length };
    expect(await press(m, 10)).toEqual(ALREADY);
    expect(await press(m, 29)).toEqual(ALREADY);
    expect(await press(m, 10, { email: " KATI@Example.com ", name: "Someone Else" })).toEqual(ALREADY); // the same address, however it is written
    expect(await db.select().from(payments)).toEqual(before.rows);
    expect(m.state.orders).toHaveLength(before.orders);
  });

  test("30 minutes after the payment, or later: a deliberate second purchase is a new one, and its payment renews the access as before", async () => {
    const m = stubMontonio();
    await buyAndPay(m);
    expect(await press(m, 30)).toMatchObject({ ok: true, paymentUrl: expect.stringContaining("https://") });
    expect(await db.select().from(payments)).toHaveLength(2);
    expect(m.state.orders).toHaveLength(2);
    const [, second] = await db.select().from(payments).orderBy(payments.id);
    const later = new Date(NOW.getTime() + 31 * MIN);
    const s = settleDeps(db, m.montonio, later);
    await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(second)));
    await s.flush();
    const [access, ...none] = await db.select().from(courseAccess);
    expect(none).toEqual([]);
    expect([access.grantedBy, access.grantedAt, formatDate(access.expiresAt, "et")]).toEqual(["payment", later, "09.04.2027"]);
    // and that one, just paid, blocks the next press in its turn
    expect(await handleEcoursePurchase(formDeps(m.montonio, { now: new Date(later.getTime() + 5 * MIN) }), form())).toEqual(ALREADY);
  });

  test("another course, or another address: a new purchase", async () => {
    const m = stubMontonio();
    await buyAndPay(m);
    await db.insert(courses).values({ slug: "teine-e-koolitus", type: "e_learning", level: "basic", title: { et: "Teine" }, summary: { et: "" }, body: { et: "" }, published: true, price: 9000 });
    expect(await press(m, 10, { course: "teine-e-koolitus" })).toMatchObject({ ok: true });
    expect(await press(m, 10, { email: "mari@example.com" })).toMatchObject({ ok: true });
    expect((await db.select().from(payments).orderBy(payments.id)).map((p) => [p.email, p.courseId === ecourseId, p.status])).toEqual([
      ["kati@example.com", true, "paid"],
      ["kati@example.com", false, "pending"],
      ["mari@example.com", true, "pending"],
    ]);
  });

  test("a held payment (the money is at Montonio) counts from the moment it was held; a failed or refunded one does not", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toMatchObject({ ok: true });
    const [p] = await db.select().from(payments);
    const s = settleDeps(db, m.montonio, NOW);
    await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p, { grandTotal: 1 })));
    expect((await db.select().from(payments))[0].status).toBe("held");
    expect(await press(m, 10)).toEqual(ALREADY);
    expect(await press(m, 31)).toMatchObject({ ok: true });
    // not these: a failed one is a new purchase, and she may buy again what was refunded
    for (const [email, status] of [["failed@example.com", "ABANDONED"], ["refunded@example.com", "REFUNDED"]] as const) {
      expect(await handleEcoursePurchase(formDeps(m.montonio), form({ email }))).toMatchObject({ ok: true });
      const [row] = await db.select().from(payments).where(eq(payments.email, email));
      if (status === "REFUNDED") await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(row))); // paid first
      await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(row, { paymentStatus: status })));
      expect((await db.select().from(payments).where(eq(payments.email, email)))[0].status).toBe(status === "REFUNDED" ? "refunded" : "failed");
      expect(await press(m, 10, { email }), email).toMatchObject({ ok: true });
    }
  });

  test("the check comes before Montonio: with Montonio down the answer is still 'alreadyPaid', and no failed row is made", async () => {
    const m = stubMontonio();
    await buyAndPay(m);
    m.state.down = true;
    expect(await press(m, 10)).toEqual(ALREADY);
    expect((await db.select().from(payments)).map((p) => p.status)).toEqual(["paid"]);
  });

  test("startEcoursePayment answers it as a kind of its own; without payments it is still 'off'", async () => {
    const m = stubMontonio();
    await buyAndPay(m);
    const input = { courseId: ecourseId, amountCents: 19000, email: "kati@example.com", name: "Kati Tamm", locale: "et" as const, newsletter: false };
    const start = (minutes: number) => startEcoursePayment({ db, now: new Date(NOW.getTime() + minutes * MIN), siteUrl: SITE, notifyBase: SITE, montonio: m.montonio }, input);
    expect(await start(10)).toEqual({ kind: "alreadyPaid" });
    expect(await start(31)).toMatchObject({ kind: "started" });
    expect(await startEcoursePayment({ db, now: NOW, siteUrl: SITE, notifyBase: SITE, montonio: null }, input)).toEqual({ kind: "off" });
  });
});

describe("the purchase's lock", () => {
  test("a two-int advisory key in a class of its own: it never shares the single-key space of the logins' address lock (and the admin's login-token lock)", async () => {
    const held = await db.transaction(async (tx) => {
      await lockAddress(tx as unknown as Db, "kati@example.com");
      await lockEcoursePurchase(tx, ecourseId, "kati@example.com");
      await lockEcoursePurchase(tx, ecourseId, "kati@example.com"); // taken again in the same transaction: no wait, no second lock of another kind
      const rows = await tx.execute(sql`select classid::int as "classId", objsubid::int as "sub" from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() order by objsubid`);
      return rowsOf<{ classId: number; sub: number }>(rows);
    });
    // objsubid 1: a one-bigint key (the address lock); 2: a pair of ints, the class first (ours)
    expect(held.map((l) => l.sub)).toEqual([1, 2]);
    expect(held[1].classId).toBe(ECOURSE_BUY_LOCK_CLASS);
    expect(Number.isInteger(ECOURSE_BUY_LOCK_CLASS)).toBe(true);
  });

  test("the lock is released with the transaction: nothing is held across Montonio's call", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toMatchObject({ ok: true });
    const rows = await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory'`);
    expect(rowsOf<{ n: number }>(rows)[0].n).toBe(0);
  });
});

describe("paid", () => {
  test("a new client with her name and language, the course open until the end of today + 6 months (by payment), the row linked; the mail carries a login code", async () => {
    const m = stubMontonio();
    const { p } = await buyAndPay(m, { locale: "ru" });
    const [client] = await db.select().from(clients);
    expect([client.email, client.name, client.locale]).toEqual(["kati@example.com", "Kati Tamm", "ru"]);
    const [access] = await db.select().from(courseAccess);
    expect([access.clientId, access.courseId, access.grantedBy, access.revokedAt, formatDate(access.expiresAt, "et")]).toEqual([client.id, ecourseId, "payment", null, "09.04.2027"]);
    expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0]).toMatchObject({ status: "paid", clientId: client.id });
    const [mine, maria] = m.mails();
    expect([mine.to, mine.subject]).toEqual(["kati@example.com", "Онлайн-курс открыт — Онлайн-курс бровиста"]);
    expect(mine.text).toContain("Доступ до 09.04.2027.");
    expect(mine.text).toMatch(/\n\d{6}\n/); // the live login code
    expect(await db.select().from(clientLoginTokens)).toHaveLength(1);
    expect(maria.subject).toBe("Uus makse: Kati Tamm, Kulmumeistri e-koolitus (e-koolitus), 190 €");
    expect(maria.text).toContain("E-koolitus on avatud kuni 09.04.2027.");
  });

  test("an existing client keeps her name and language; her open access is renewed (the expiry moved, by payment)", async () => {
    const m = stubMontonio();
    const [client] = await db.insert(clients).values({ email: "kati@example.com", name: "Katrin", locale: "et" }).returning();
    await db.insert(courseAccess).values({ clientId: client.id, courseId: ecourseId, grantedBy: "admin@example.test", expiresAt: new Date("2026-12-01T21:59:59.999Z") });
    await buyAndPay(m, { name: "Kati Tamm", locale: "ru" });
    const [after] = await db.select().from(clients);
    expect([after.id, after.name, after.locale]).toEqual([client.id, "Katrin", "et"]);
    const [access] = await db.select().from(courseAccess);
    expect([access.grantedBy, formatDate(access.expiresAt, "et")]).toEqual(["payment", "09.04.2027"]);
    expect(await db.select().from(courseAccess)).toHaveLength(1);
  });

  test("an existing client who has no name gets the payer's", async () => {
    const m = stubMontonio();
    await db.insert(clients).values({ email: "kati@example.com", name: "", locale: "ru" });
    await buyAndPay(m, { name: "Kati Tamm", locale: "et" });
    const [after] = await db.select().from(clients);
    expect([after.name, after.locale]).toEqual(["Kati Tamm", "ru"]);
  });

  test("buying again never shortens access: an admin's grant that ends later keeps its end date (by payment now)", async () => {
    const m = stubMontonio();
    const [client] = await db.insert(clients).values({ email: "kati@example.com", name: "Katrin", locale: "et" }).returning();
    await db.insert(courseAccess).values({ clientId: client.id, courseId: ecourseId, grantedBy: "admin@example.test", expiresAt: new Date("2027-12-01T21:59:59.999Z") });
    await buyAndPay(m);
    const [access] = await db.select().from(courseAccess);
    expect([access.grantedBy, formatDate(access.expiresAt, "et"), access.expiresAt.toISOString(), access.revokedAt]).toEqual(["payment", "01.12.2027", "2027-12-01T21:59:59.999Z", null]);
    expect(m.mails()[0].text).toContain("Ligipääs kuni 01.12.2027.");
  });

  test("a revoked access counts as none (today + 6 months, the end cleared); an expired one is renewed from today", async () => {
    const m = stubMontonio();
    const [client] = await db.insert(clients).values({ email: "kati@example.com", name: "Katrin", locale: "et" }).returning();
    await db.insert(courseAccess).values({ clientId: client.id, courseId: ecourseId, grantedBy: "admin@example.test", expiresAt: new Date("2027-12-01T21:59:59.999Z"), revokedAt: new Date("2026-09-01T10:00:00Z") });
    await buyAndPay(m);
    const [access] = await db.select().from(courseAccess);
    expect([formatDate(access.expiresAt, "et"), access.revokedAt]).toEqual(["09.04.2027", null]);
    await db.update(courseAccess).set({ expiresAt: new Date("2026-01-01T21:59:59.999Z"), grantedBy: "admin@example.test" });
    await buyAndPay(m, {}, new Date(NOW.getTime() + 31 * MIN)); // (not within 30 minutes of the first: that press would be 'alreadyPaid')
    expect(formatDate((await db.select().from(courseAccess))[0].expiresAt, "et")).toBe("09.04.2027");
  });

  test("the course's access months: without them 12; the end of the day in Estonia", async () => {
    const m = stubMontonio();
    await db.update(courses).set({ accessMonths: null }).where(eq(courses.id, ecourseId));
    await buyAndPay(m);
    const [access] = await db.select().from(courseAccess);
    expect(access.expiresAt.toISOString()).toBe("2027-10-09T20:59:59.999Z"); // 09.10.2027 23:59:59.999 in Estonia (summer time)
  });

  test("a new client with earlier records: they are linked to her, and the payer's name is the one she is given", async () => {
    const m = stubMontonio();
    const earlier = await registrationOn(db, await contactCourse(db), { email: "kati@example.com", name: "Katrin T.", phone: "+372 5555 0101" });
    await buyAndPay(m, { name: "Kati Tamm" });
    const [client] = await db.select().from(clients);
    expect([client.name, client.phone]).toEqual(["Kati Tamm", "+372 5555 0101"]);
    expect((await db.select().from(registrations).where(eq(registrations.id, earlier.id)))[0].clientId).toBe(client.id);
  });

  test("no session and no login before her own login link: the mail's code and link are a normal client login", async () => {
    const m = stubMontonio();
    await buyAndPay(m);
    expect((await db.select().from(clientSessions))).toEqual([]);
    const [mine] = m.mails();
    expect(mine.text).toContain("Logi sisse");
    const token = /\/api\/konto\/verify\?t=([\w-]+)/.exec(mine.text)![1];
    const code = /\n(\d{6})\n/.exec(mine.text)![1];
    const [client] = await db.select().from(clients);
    // the code is as good as the link (one login, either way), and the session is hers
    expect(await redeemClientCode(db, "kati@example.com", code, NOW)).toMatchObject({ clientId: client.id, isNew: false });
    expect(await redeemClientLink(db, token, NOW)).toBeNull(); // the code spent the login: the link is the same login
    expect(await db.select().from(clientSessions)).toHaveLength(1);
  });

  test("the link alone signs her in as the client of the payment", async () => {
    const m = stubMontonio();
    await buyAndPay(m);
    const token = /\/api\/konto\/verify\?t=([\w-]+)/.exec(m.mails()[0].text)![1];
    const [client] = await db.select().from(clients);
    expect(await redeemClientLink(db, token, NOW)).toMatchObject({ clientId: client.id, isNew: false, locale: "et" });
  });

  test("the e-course mail does not tell her to delete it: no 'Kui sa ei palunud sisselogimist' line, in either language; the login mail keeps it", async () => {
    const m = stubMontonio();
    await buyAndPay(m);
    await buyAndPay(m, { email: "mari@example.com", locale: "ru" });
    const [et, , ru] = m.mails();
    expect([et.to, ru.to]).toEqual(["kati@example.com", "mari@example.com"]);
    for (const [mail, line] of [[et, "Kui sa ei palunud sisselogimist, võid selle kirja kustutada."], [ru, "Если вы не запрашивали вход, просто удалите это письмо."]] as const) {
      expect(mail.text).not.toContain(line);
      expect(mail.html).not.toContain(line);
      expect(mail.text).toMatch(/\n\d{6}\n/);
    }
    expect(et.text).toContain("Kood ja link kehtivad 30 minutit.");
  });

  test("an address with its 3 live logins already gets the mail without a code: 'Ava minu konto'", async () => {
    const m = stubMontonio();
    for (let i = 0; i < 3; i++) expect(await issueClientLogin(db, "kati@example.com", NOW)).not.toBeNull();
    await buyAndPay(m);
    const [mine] = m.mails();
    expect(mine.subject).toBe("E-koolitus on avatud — Kulmumeistri e-koolitus");
    expect(mine.text).not.toMatch(/\n\d{6}\n/);
    expect(mine.text).toContain("Ava minu konto:");
    expect(await db.select().from(clientLoginTokens)).toHaveLength(3);
  });

  test("the newsletter box: subscribed when paid (one step), not before; unticked: no subscriber", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ newsletter: "on" }))).toMatchObject({ ok: true });
    expect(await db.select().from(subscribers)).toEqual([]); // not before the payment
    const [p] = await db.select().from(payments);
    const s = settleDeps(db, m.montonio, NOW);
    await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)));
    expect(await db.select().from(subscribers)).toEqual([]); // nor in the settlement's own transaction: after the response
    await s.flush();
    expect((await db.select().from(subscribers)).map((x) => [x.email, x.confirmedAt !== null, x.locale])).toEqual([["kati@example.com", true, "et"]]);
    await buyAndPay(m, { email: "mari@example.com" });
    expect(await db.select().from(subscribers)).toHaveLength(1);
  });

  test("nothing is mailed or granted before the response is out; the payer's mail comes first, then Maria's notice", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toMatchObject({ ok: true });
    const [p] = await db.select().from(payments);
    const s = settleDeps(db, m.montonio, NOW);
    expect((await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)))).kind).toBe("done");
    expect(await db.select().from(courseAccess)).toHaveLength(1); // opened in the payment's own transaction
    expect(m.mails()).toEqual([]);
    await s.flush();
    expect(m.mails().map((x) => x.to)).toEqual(["kati@example.com", "maria@example.test"]);
  });

  test("a sample address: the course opens, no mail and no login code; Maria is told", async () => {
    const m = stubMontonio();
    await buyAndPay(m, { email: "kati@example.test", newsletter: "on" });
    expect(await db.select().from(courseAccess)).toHaveLength(1);
    expect(m.mails().map((x) => x.to)).toEqual(["maria@example.test"]);
    expect(await db.select().from(clientLoginTokens)).toEqual([]);
    expect(await db.select().from(subscribers)).toHaveLength(1); // subscribed all the same; its welcome mail is the newsletter's own guard
  });

  test("the same PAID token twice, or the webhook racing the return: opened once, one mail, one login", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ newsletter: "on" }))).toMatchObject({ ok: true });
    const [p] = await db.select().from(payments);
    const s = settleDeps(db, m.montonio, NOW);
    const token = m.montonio.verifyOrderToken(orderToken(p));
    await Promise.all([settleToken(s.deps, token), settleToken(s.deps, token), settleToken(s.deps, token)]);
    await settleToken(s.deps, token);
    await s.flush();
    expect(await db.select().from(courseAccess)).toHaveLength(1);
    expect(await db.select().from(clientLoginTokens)).toHaveLength(1);
    expect(m.mails().filter((x) => x.to === "kati@example.com" && x.subject.startsWith("E-koolitus on avatud"))).toHaveLength(1);
    expect(m.mails().filter((x) => x.to === "maria@example.test")).toHaveLength(1);
  });

  test("the grant is the winner's alone: replaying the PAID token (the webhook's retries, a reloaded return) leaves an access that was changed since exactly as it is", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toMatchObject({ ok: true });
    const [p] = await db.select().from(payments);
    const s = settleDeps(db, m.montonio, NOW);
    const token = m.montonio.verifyOrderToken(orderToken(p));
    await settleToken(s.deps, token); // the winner
    await s.flush();
    const [paid] = await db.select().from(payments);
    const replay = async () => {
      await Promise.all([settleToken(s.deps, token), settleToken(s.deps, token), settleToken(s.deps, token)]);
      await s.flush();
    };
    // an admin takes the access over: her own name on it and another end date; a grant by the replays would write "payment" and 09.04.2027 back
    await db.update(courseAccess).set({ grantedBy: "admin@example.test", expiresAt: new Date("2031-01-01T21:59:59.999Z") });
    const changed = await db.select().from(courseAccess);
    await replay();
    expect(await db.select().from(courseAccess)).toEqual(changed);
    // and an access she ended stays ended: a replayed payment does not open it again
    await db.update(courseAccess).set({ revokedAt: new Date("2026-10-09T11:00:00Z") });
    const revoked = await db.select().from(courseAccess);
    await replay();
    expect(await db.select().from(courseAccess)).toEqual(revoked);
    expect(await db.select().from(payments)).toEqual([paid]);
    expect(await db.select().from(clients)).toHaveLength(1);
    expect(await db.select().from(clientLoginTokens)).toHaveLength(1);
    expect(m.mails().map((x) => x.to)).toEqual(["kati@example.com", "maria@example.test"]); // nothing more went out
  });

  test("a failed payment opens nothing; one that is paid later (the bank was slow) opens it then", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ newsletter: "on" }))).toMatchObject({ ok: true });
    const [p] = await db.select().from(payments);
    const s = settleDeps(db, m.montonio, NOW);
    await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "ABANDONED" })));
    await s.flush();
    expect((await db.select().from(payments))[0].status).toBe("failed");
    expect(await accountRows()).toEqual([[], [], [], [], []]);
    expect(m.mails()).toEqual([]);
    await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)));
    await s.flush();
    expect((await db.select().from(payments))[0].status).toBe("paid");
    expect(await db.select().from(courseAccess)).toHaveLength(1);
  });

  test("a payment held for its amount opens nothing and subscribes no one; Maria is alerted in words that fit an e-course", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form({ newsletter: "on" }))).toMatchObject({ ok: true });
    const [p] = await db.select().from(payments);
    const s = settleDeps(db, m.montonio, NOW);
    await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p, { grandTotal: 1 })));
    await s.flush();
    expect((await db.select().from(payments))[0]).toMatchObject({ status: "held", clientId: null });
    expect(await accountRows()).toEqual([[], [], [], [], []]);
    const [maria, ...none] = m.mails();
    expect(none).toEqual([]);
    expect([maria.to, maria.subject]).toEqual(["maria@example.test", "Kontrolli Montonios: Kati Tamm, Kulmumeistri e-koolitus (e-koolitus), 190 €"]);
    expect(maria.text).toContain("Midagi ei avatud");
    expect(maria.text).not.toMatch(/registree|kinnita|Kinnitus|koolituspäev/i);
  });

  test("a refund of the e-course alerts Maria in e-course words: the money, the access stays as it is", async () => {
    const m = stubMontonio();
    const { p, flush, deps } = await buyAndPay(m);
    const before = m.mails().length;
    await settleToken(deps, m.montonio.verifyOrderToken(orderToken(p, { paymentStatus: "REFUNDED" })));
    await flush();
    const alert = m.mails()[before];
    expect(alert.subject).toBe("Kontrolli Montonios: Kati Tamm, Kulmumeistri e-koolitus (e-koolitus), 190 €");
    expect(alert.text).toContain("Laekunud summa ja ligipääs jäid muutmata");
    expect(alert.text).not.toMatch(/registree|Kinnitus/i);
    expect(await db.select().from(courseAccess)).toHaveLength(1);
  });

  test("the course was deleted before the payment came: paid, nothing opened, Maria told to open it by hand or refund", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toMatchObject({ ok: true });
    const [p] = await db.select().from(payments);
    await db.delete(courses).where(eq(courses.id, ecourseId));
    const s = settleDeps(db, m.montonio, NOW);
    expect(await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ payment: { status: "paid", clientId: null } });
    await s.flush();
    expect(await db.select().from(clients)).toEqual([]);
    expect(m.mails().map((x) => x.to)).toEqual(["maria@example.test"]);
    // the course is gone, so is its title: the subject says what it can, never a dash in brackets
    expect(m.mails()[0].subject).toBe("Uus makse: Kati Tamm, E-koolitus, 190 €");
    expect(m.mails()[0].text).toContain("E-koolitust ei avatud. Ava ligipääs käsitsi (Õpilased) või tagasta raha Montonios.");
    expect(m.mails()[0].text).not.toMatch(/registreeringule|ei leitud|—|\(e-koolitus\)/);
  });

  test("a grant that throws: the payment is still paid, nothing is opened (what the grant had written is rolled back with it), and Maria is told at once to open it by hand", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toMatchObject({ ok: true });
    const [p] = await db.select().from(payments);
    // the client is made first and the access second: a throw at the access leaves the client to be rolled back
    vi.spyOn(adminClients, "grantAccess").mockRejectedValue(Object.assign(new Error("boom for kati@example.com"), { code: "XX000" }));
    const s = settleDeps(db, m.montonio, NOW);
    const token = m.montonio.verifyOrderToken(orderToken(p));
    expect(await settleToken(s.deps, token)).toMatchObject({ kind: "done", payment: { status: "paid", clientId: null } });
    await s.flush();
    expect((await db.select().from(payments))[0]).toMatchObject({ status: "paid", clientId: null });
    expect(await accountRows()).toEqual([[], [], [], [], []]);
    const [maria, ...none] = m.mails();
    expect(none).toEqual([]);
    expect([maria.to, maria.subject]).toEqual(["maria@example.test", "Uus makse: Kati Tamm, Kulmumeistri e-koolitus (e-koolitus), 190 €"]);
    expect(maria.text).toContain("E-koolitust ei avatud. Ava ligipääs käsitsi (Õpilased) või tagasta raha Montonios.");
    // the log has the class and the code, never the message (it can hold an address)
    const logged = vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain("Error (code XX000)");
    expect(logged).not.toMatch(/boom|kati@example\.com/);
    // the payment is paid for good: the webhook's retry does not open anything or tell Maria again
    await settleToken(s.deps, token);
    await s.flush();
    expect(m.mails()).toHaveLength(1);
    expect(await accountRows()).toEqual([[], [], [], [], []]);
  });

  // A transient database error in the grant is not "the course could not be opened": the whole paid transaction rolls back, the payment stays
  // pending with nobody told, and Montonio's retry, the return or the daily check settles it again (settle.ts openCourse).
  describe("a grant that fails for a transient reason", () => {
    const transient = (code: string, wrapped = false) => {
      const inner = Object.assign(new Error("boom for kati@example.com"), { code });
      return wrapped ? Object.assign(new Error("Failed query: select … kati@example.com"), { cause: inner }) : inner;
    };

    test.each([
      ["serialization failure", "40001"],
      ["deadlock", "40P01"],
      ["lock not available", "55P03"],
      ["statement timeout", "57014"],
      ["a connection error", "08006"],
      ["another connection error", "08003"],
    ])("%s (%s): nothing is written, the payment stays pending, nobody is told; the retry pays and opens it", async (_name, code) => {
      const m = stubMontonio();
      for (const wrapped of [false, true]) {
        expect(await handleEcoursePurchase(formDeps(m.montonio), form({ email: wrapped ? "teine@example.com" : "kati@example.com" }))).toMatchObject({ ok: true });
        const [p] = await db.select().from(payments).where(eq(payments.email, wrapped ? "teine@example.com" : "kati@example.com"));
        const before = await accountRows();
        const mailed = m.mails().length;
        const grant = vi.spyOn(adminClients, "grantAccess").mockRejectedValueOnce(transient(code, wrapped)); // (drizzle wraps the driver's error: the code is on `cause`)
        const s = settleDeps(db, m.montonio, NOW);
        const token = m.montonio.verifyOrderToken(orderToken(p));
        await expect(settleToken(s.deps, token)).rejects.toThrow();
        await s.flush();
        expect(await db.select().from(payments).where(eq(payments.id, p.id))).toMatchObject([{ status: "pending", paidAt: null, clientId: null }]);
        expect(await accountRows()).toEqual(before); // the client the grant had made is rolled back with the payment
        expect(m.mails()).toHaveLength(mailed);
        // the retry (the webhook is retried, the return or the daily check comes): the grant works now, and the payment is settled for good
        expect(await settleToken(s.deps, token)).toMatchObject({ kind: "done", payment: { status: "paid" } });
        await s.flush();
        expect((await db.select().from(courseAccess)).length).toBe(wrapped ? 2 : 1);
        expect(grant).toHaveBeenCalledTimes(2);
        grant.mockRestore();
      }
    });

    test("any other code, or none, is still 'not opened': paid, and Maria is told at once", async () => {
      const m = stubMontonio();
      for (const code of ["23505", "42P01", "XX000", "40", "0A000", "P0001", undefined]) {
        const email = `ostja-${String(code).toLowerCase()}@example.com`;
        expect(await handleEcoursePurchase(formDeps(m.montonio), form({ email }))).toMatchObject({ ok: true });
        const [p] = await db.select().from(payments).where(eq(payments.email, email));
        vi.spyOn(adminClients, "grantAccess").mockRejectedValueOnce(code === undefined ? new Error("plain") : transient(code));
        const mailed = m.mails().length;
        const s = settleDeps(db, m.montonio, NOW);
        expect(await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)))).toMatchObject({ kind: "done", payment: { status: "paid", clientId: null } });
        await s.flush();
        expect(m.mails().slice(mailed).map((x) => x.to), String(code)).toEqual(["maria@example.test"]);
        expect(m.mails()[mailed].text, String(code)).toContain("E-koolitust ei avatud.");
      }
    });
  });

  test("a course that is no e-course any more: paid, nothing opened, no client made", async () => {
    const m = stubMontonio();
    expect(await handleEcoursePurchase(formDeps(m.montonio), form())).toMatchObject({ ok: true });
    const [p] = await db.select().from(payments);
    await db.update(courses).set({ type: "contact" }).where(eq(courses.id, ecourseId));
    const s = settleDeps(db, m.montonio, NOW);
    await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)));
    await s.flush();
    expect((await db.select().from(payments))[0]).toMatchObject({ status: "paid", clientId: null });
    expect(await db.select().from(courseAccess)).toEqual([]);
    expect(await db.select().from(clients)).toEqual([]);
    expect(m.mails()[0].subject).toBe("Uus makse: Kati Tamm, Kulmumeistri e-koolitus (e-koolitus), 190 €"); // the course is still there, with its title
    expect(m.mails()[0].text).toContain("E-koolitust ei avatud. Ava ligipääs käsitsi (Õpilased) või tagasta raha Montonios.");
  });
});

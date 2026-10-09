import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseSessions, payments, registrations, settings } from "@/db/schema";
import { handlePayPage, loadPayView, payPage, type PayPageDeps } from "@/server/pay-page";
import { STARTS_PER_HOUR } from "@/server/payments/start";
import { fakeKv } from "../fakes";
import { contactCourse, loggedDb, pendingPayment, registrationOn, SITE, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// /maksa/<pay_token> (phase 2b, spec 6.3): the mail's "Maksa" link. GET shows the course, the date, what is due, the button and the bank
// transfer, and changes nothing (mail scanners open links); a same-origin POST starts the payment and answers 303 to Montonio; a cross-site
// POST is 403. A full session, nothing due, too many starts or Montonio down: the page again, with its line.

const NOW = new Date("2026-10-09T10:00:00Z");
const PAY = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const deps = (montonio: PayPageDeps["montonio"], over: Partial<PayPageDeps> = {}): PayPageDeps => ({ db, kv: fakeKv(), now: NOW, siteUrl: SITE, montonio, ip: "203.0.113.9", ...over });
const get = (token: string) => new Request(`${SITE}/maksa/${token}`);
const post = (token: string, headers: Record<string, string> = { origin: SITE }) => new Request(`${SITE}/maksa/${token}`, { method: "POST", headers });
const text = async (res: Response) => res.text();

describe("GET: the page, and nothing else", () => {
  test("the course, its date and place, the amount, 'Maksa 175 €', and the transfer under 'või tasu pangaülekandega'; no row, no hold", async () => {
    const m = stubMontonio();
    await db.insert(settings).values({ key: "prepayment", value: PAY });
    const r = await registrationOn(db, await contactCourse(db));
    const res = await handlePayPage(get(r.payToken), r.payToken, deps(m.montonio));
    expect([res.status, res.headers.get("cache-control"), res.headers.get("content-type")]).toEqual([200, "no-store", "text/html; charset=utf-8"]);
    const html = await text(res);
    for (const part of ["<h1>Koolituse eest tasumine</h1>", "Kulmumeistri baaskoolitus", "14.11.2026 · 10:00, Pärnu, MS LAB stuudio", "Summa: 175 €", "Maksa 175 €", "või tasu pangaülekandega", "EE38 2200 2210 2014 5685", `MSLAB-${r.id}`, '<meta name="robots" content="noindex">'])
      expect(html).toContain(part);
    expect(html).toContain(`<form method="post" action="/maksa/${r.payToken}">`);
    expect(html).not.toMatch(/<script|<link|https?:\/\/(?!www\.w3\.org)/);
    expect(await db.select().from(payments)).toEqual([]);
    expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].seatHoldUntil).toBeNull();
    expect(m.state.orders).toEqual([]);
  });

  test("a confirmed registration with a rest: 'Maksa ülejäänud 175 €'; nothing due, cancelled or an unknown token: the one sentence, no button", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const rest = await registrationOn(db, c, { status: "confirmed", paidCents: 17500 });
    expect(await text(await handlePayPage(get(rest.payToken), rest.payToken, deps(m.montonio)))).toContain("Maksa ülejäänud 175 €");
    const paid = await registrationOn(db, c, { email: "a@example.com", status: "confirmed", paidCents: 35000 });
    const cancelled = await registrationOn(db, c, { email: "b@example.com", status: "cancelled" });
    for (const token of [paid.payToken, cancelled.payToken, "x".repeat(43), "short"]) {
      const html = await text(await handlePayPage(get(token), token, deps(m.montonio)));
      expect(html, token).toContain("Selle registreeringu eest pole praegu midagi tasuda.");
      expect(html, token).not.toContain("<form");
    }
  });

  test("Russian for a Russian registration; without payments the transfer alone (no button, no 'või')", async () => {
    const m = stubMontonio();
    await db.insert(settings).values({ key: "prepayment", value: PAY });
    const r = await registrationOn(db, await contactCourse(db), { locale: "ru" });
    const ru = await text(await handlePayPage(get(r.payToken), r.payToken, deps(m.montonio)));
    for (const part of ['<html lang="ru">', "Оплата обучения", "Базовый курс бровиста", "Оплатить 175 €", "или оплатите банковским переводом"]) expect(ru).toContain(part);
    const off = await text(await handlePayPage(get(r.payToken), r.payToken, deps(null)));
    expect(off).not.toContain("<form");
    expect(off).not.toContain("или оплатите");
    expect(off).toContain("EE38 2200 2210 2014 5685");
  });

  test("payPage escapes what it shows", () => {
    const html = payPage(
      { token: "tok", locale: "et", registrationId: 1, course: { et: '<b>"Kulmud"</b>' }, session: null, due: { kind: "prepayment", cents: 100 }, transfer: null },
      { online: true },
    );
    expect(html).toContain("&lt;b&gt;&quot;Kulmud&quot;&lt;/b&gt;");
    expect(html).not.toContain('<b>"Kulmud"</b>');
  });
});

describe("POST: the button", () => {
  test("same-origin: the payment starts — a pending row, the hold — and a 303 to Montonio's page (Origin: null with Sec-Fetch-Site: same-origin too)", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db);
    const r = await registrationOn(db, c);
    const res = await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio));
    const [p] = await db.select().from(payments);
    expect([res.status, res.headers.get("location"), res.headers.get("cache-control")]).toEqual([303, `https://sandbox-stargate.montonio.com/${p.providerUuid}`, "no-store"]);
    expect([p.kind, p.status, p.amountCents]).toEqual(["prepayment", "pending", 17500]);
    expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].seatHoldUntil).toEqual(new Date(NOW.getTime() + 30 * 60_000));
    const other = await registrationOn(db, c, { email: "teine@example.com" });
    expect((await handlePayPage(post(other.payToken, { origin: "null", "sec-fetch-site": "same-origin" }), other.payToken, deps(m.montonio))).status).toBe(303);
  });

  test("cross-site: 403, nothing started", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    // (typed: the literals' union has an optional "sec-fetch-site" that tsc will not pass as Record<string, string>)
    const crossSite: Record<string, string>[] = [{ origin: "https://elsewhere.example" }, { origin: "null" }, { origin: "https://elsewhere.example", "sec-fetch-site": "same-origin" }];
    for (const headers of crossSite)
      expect((await handlePayPage(post(r.payToken, headers), r.payToken, deps(m.montonio))).status, JSON.stringify(headers)).toBe(403);
    expect(await db.select().from(payments)).toEqual([]);
  });

  test("the session is full: 409 and the page says so, without the button", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 1 });
    await registrationOn(db, c, { email: "teine@example.com", status: "confirmed", paidCents: 35000 });
    const r = await registrationOn(db, c);
    const res = await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio));
    const html = await text(res);
    expect(res.status).toBe(409);
    expect(html).toContain("See koolitus on täis. Võta ühendust Mariaga.");
    expect(html).not.toContain("<form");
  });

  test("Montonio down: 503 and 'Midagi läks valesti'; the row is failed, no hold stays", async () => {
    const m = stubMontonio();
    m.state.down = true;
    const r = await registrationOn(db, await contactCourse(db));
    const res = await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio));
    expect(res.status).toBe(503);
    expect(await text(res)).toContain("Midagi läks valesti. Proovi uuesti.");
    expect((await db.select().from(payments)).map((p) => p.status)).toEqual(["failed"]);
    expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].seatHoldUntil).toBeNull();
  });

  test("5 starts per IP in 10 minutes, and 5 a registration an hour: then 429 'Liiga palju katseid'", async () => {
    const m = stubMontonio();
    const c = await contactCourse(db, { capacity: 20 });
    const kv = fakeKv();
    for (let i = 0; i < 5; i++) {
      const r = await registrationOn(db, c, { email: `k${i}@example.com` });
      expect((await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio, { kv }))).status).toBe(303);
    }
    const sixth = await registrationOn(db, c, { email: "k5@example.com" });
    const limited = await handlePayPage(post(sixth.payToken), sixth.payToken, deps(m.montonio, { kv }));
    expect(limited.status).toBe(429);
    expect(await text(limited)).toContain("Liiga palju katseid. Proovi mõne minuti pärast.");
    // five new attempts of one registration, each ended unpaid (Montonio's ABANDONED) before the next: an open one would only be re-sent (Task 4)
    for (let i = 0; i < STARTS_PER_HOUR; i++) {
      expect((await handlePayPage(post(sixth.payToken), sixth.payToken, deps(m.montonio, { ip: `198.51.100.${i}` }))).status).toBe(303);
      await db.update(payments).set({ status: "failed" }).where(eq(payments.registrationId, sixth.id));
    }
    expect((await handlePayPage(post(sixth.payToken), sixth.payToken, deps(m.montonio, { ip: "198.51.100.99" }))).status).toBe(429);
  });

  test("nothing due by now: the page with its sentence, no payment", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { paidCents: 17500 });
    const res = await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio));
    expect(res.status).toBe(200);
    expect(await text(res)).toContain("Selle registreeringu eest pole praegu midagi tasuda.");
    expect(await db.select().from(payments)).toEqual([]);
  });
});

test("loadPayView: what the page shows, read with the token only", async () => {
  const r = await registrationOn(db, await contactCourse(db));
  expect(await loadPayView(db, r.payToken, NOW)).toMatchObject({ token: r.payToken, locale: "et", registrationId: r.id, due: { kind: "prepayment", cents: 17500 }, transfer: null });
  expect(await loadPayView(db, "short", NOW)).toBeNull();
});

describe("what the page may and may not do (phase 2b, the review's list)", () => {
  test("a token that cannot be one: the neutral page and not one query, for GET and POST (the shape is checked before the database)", async () => {
    const { db: ldb, queries } = await loggedDb();
    const m = stubMontonio();
    queries.length = 0;
    for (const token of ["short", "x".repeat(101), "c".repeat(19), "a b".padEnd(30, "c"), "'; drop table registrations;--".padEnd(40, "x"), "é".repeat(30), "<b>".padEnd(30, "x")]) {
      for (const request of [get(token), post(token)]) {
        const res = await handlePayPage(request, token, deps(m.montonio, { db: ldb }));
        expect([res.status, await text(res)], token).toEqual([200, expect.stringContaining("Selle registreeringu eest pole praegu midagi tasuda.")]);
      }
    }
    expect(queries).toEqual([]);
    expect(m.state.orders).toEqual([]);
  });

  test("GET only reads: every statement is a plain select, none takes a lock", async () => {
    const { db: ldb, queries } = await loggedDb();
    const m = stubMontonio();
    const r = await registrationOn(ldb, await contactCourse(ldb));
    queries.length = 0;
    expect((await handlePayPage(get(r.payToken), r.payToken, deps(m.montonio, { db: ldb }))).status).toBe(200);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter((q) => !/^select /i.test(q) || /for update/i.test(q))).toEqual([]);
  });

  test("the answers carry exactly their own headers: the page and the refusal a type and no-store, the redirect a location and no-store; no cookie", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const names = (res: Response) => [...res.headers.keys()].sort();
    expect(names(await handlePayPage(get(r.payToken), r.payToken, deps(m.montonio)))).toEqual(["cache-control", "content-type"]);
    expect(names(await handlePayPage(post(r.payToken, { origin: "https://elsewhere.example" }), r.payToken, deps(m.montonio)))).toEqual(["cache-control", "content-type"]);
    const go = await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio));
    expect(names(go)).toEqual(["cache-control", "location"]);
    expect(go.body).toBeNull();
  });

  test("the rest of a confirmed registration: a balance payment of 175 € and no hold (a confirmed place needs none)", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db), { status: "confirmed", paidCents: 17500 });
    const res = await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio));
    expect(res.status).toBe(303);
    expect((await db.select().from(payments)).map((p) => [p.kind, p.status, p.amountCents])).toEqual([["balance", "pending", 17500]]);
    expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].seatHoldUntil).toBeNull();
  });

  test("a second press while the order is open re-sends it (one row, Montonio's new page) and does not count against the registration's 5 an hour; the IP counts every press", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const locations = new Set<string | null>();
    for (let i = 0; i < 4; i++) {
      const res = await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio, { ip: `198.51.100.${i}` }));
      expect(res.status).toBe(303);
      locations.add(res.headers.get("location"));
    }
    expect(await db.select().from(payments)).toHaveLength(1);
    expect(locations.size).toBe(4);
    expect(m.state.orders).toHaveLength(4);
    // one address pressing five times uses its 5, the sixth is refused before anything is sent to Montonio
    const kv = fakeKv();
    for (let i = 0; i < 5; i++) expect((await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio, { kv }))).status).toBe(303);
    expect((await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio, { kv }))).status).toBe(429);
    expect(m.state.orders).toHaveLength(9);
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  test("a refusal changes no hold: the session full, 5 starts in the hour, nothing due — the registration's hold is exactly as it was", async () => {
    const m = stubMontonio();
    const held = new Date(NOW.getTime() + 10 * 60_000);
    const hold = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0].seatHoldUntil;
    const c = await contactCourse(db, { capacity: 20 });
    const [tiny] = await db.insert(courseSessions).values({ courseId: c.course.id, startsAt: c.session.startsAt, city: "Pärnu", venue: "väike", capacity: 1 }).returning();
    // full: the one seat is a confirmed registration's
    await registrationOn(db, { course: c.course, session: tiny }, { email: "teine@example.com", status: "confirmed", paidCents: 35000 });
    const waiting = await registrationOn(db, { course: c.course, session: tiny }, { seatHoldUntil: held });
    expect((await handlePayPage(post(waiting.payToken), waiting.payToken, deps(m.montonio))).status).toBe(409);
    expect(await hold(waiting.id)).toEqual(held);
    // five attempts in the last hour, all ended
    const tooMany = await registrationOn(db, c, { email: "k@example.com", seatHoldUntil: held });
    for (let i = 0; i < STARTS_PER_HOUR; i++) {
      const p = await pendingPayment(db, tooMany, {}, new Date(NOW.getTime() - 5 * 60_000));
      await db.update(payments).set({ status: "failed" }).where(eq(payments.id, p.id));
    }
    expect((await handlePayPage(post(tooMany.payToken), tooMany.payToken, deps(m.montonio))).status).toBe(429);
    expect(await hold(tooMany.id)).toEqual(held);
    // nothing due
    const paid = await registrationOn(db, c, { email: "p@example.com", paidCents: 17500, seatHoldUntil: held });
    expect((await handlePayPage(post(paid.payToken), paid.payToken, deps(m.montonio))).status).toBe(200);
    expect(await hold(paid.id)).toEqual(held);
    expect(m.state.orders).toEqual([]);
  });

  test("the start throws (its database fails): the page's 'Midagi läks valesti' (503), nothing held or stored, and the log has the class only — no token, address or message", async () => {
    const m = stubMontonio();
    const r = await registrationOn(db, await contactCourse(db));
    const failing = new Proxy(db, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (prop === "transaction") return () => Promise.reject(new Error(`boom ${r.email} ${r.payToken}`));
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio, { db: failing }));
    expect(res.status).toBe(503);
    expect(await text(res)).toContain("Midagi läks valesti. Proovi uuesti.");
    expect(await db.select().from(payments)).toEqual([]);
    expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].seatHoldUntil).toBeNull();
    expect(vi.mocked(console.error).mock.calls.map((args) => args.map(String).join(" "))).toEqual(["[payments] pay page: the payment did not start: Error"]);
  });

  test("a whole payment that Montonio refuses logs no pay token, address or IBAN", async () => {
    const m = stubMontonio();
    m.state.down = true;
    await db.insert(settings).values({ key: "prepayment", value: PAY });
    const r = await registrationOn(db, await contactCourse(db));
    expect((await handlePayPage(post(r.payToken), r.payToken, deps(m.montonio))).status).toBe(503);
    const logged = [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls].map((args) => args.map(String).join(" ")).join("\n");
    expect(logged).not.toBe("");
    for (const secret of [r.payToken, r.email, PAY.iban, "EE38"]) expect(logged).not.toContain(secret);
  });

  test("payPage escapes every value it prints: the course, the place, the bank's rows and the token", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const html = payPage(
      {
        token: `t"><script>`,
        locale: "et",
        registrationId: 1,
        course: { et: evil },
        session: { startsAt: new Date("2026-11-14T08:00:00Z"), city: evil, venue: "'<>&" },
        due: { kind: "balance", cents: 17500 },
        transfer: { receiver: evil, iban: `EE38"><script>`, bank: evil, referencePrefix: evil },
      },
      { online: true },
    );
    expect(html).not.toMatch(/<img|<script|onerror="/);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&#39;&lt;&gt;&amp;");
  });
});

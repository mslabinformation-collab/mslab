import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi, type MockInstance } from "vitest";
import type { Db } from "@/db/client";
import * as paymentQueries from "@/db/queries/payments";
import { insertPayment, attachOrder } from "@/db/queries/payments";
import { courses, payments, registrations } from "@/db/schema";
import { handleNotify, handleReturn, returnTarget } from "@/server/payments/routes";
import { contactCourse, orderToken, pendingPayment, registrationOn, settleDeps, SITE, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// GET /api/payments/return?order-token=… (phase 2b, spec 6.5): the token verified, the payment settled through the one door, and a 303 to the
// static /makse page of the payment's language with the result in the fragment. A token that cannot be verified: katkestatud, no way on.

const NOW = new Date("2026-10-09T10:00:00Z");
let db: Db;
let log: MockInstance[];
beforeEach(async () => {
  db = await makeTestDb();
  log = (["info", "error"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const back = (token: string) => new Request(`${SITE}/api/payments/return?order-token=${encodeURIComponent(token)}`);
const target = (res: Response) => [res.status, res.headers.get("location"), res.headers.get("cache-control"), res.headers.get("referrer-policy")];
const where = (res: Response) => res.headers.get("location");

test("without payments: 404", async () => {
  const m = stubMontonio();
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect((await handleReturn(back("x"), { ...deps, montonio: null })).status).toBe(404);
});

test("PAID: settled (the webhook may come later or never) and 303 to /makse#tulemus=makstud; Russian to /ru/makse", async () => {
  const m = stubMontonio();
  const c = await contactCourse(db);
  const p = await pendingPayment(db, await registrationOn(db, c));
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(target(await handleReturn(back(orderToken(p)), deps))).toEqual([303, `/makse#tulemus=makstud&liik=registreering`, "no-store", "no-referrer"]);
  const ru = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com", locale: "ru" }));
  expect(where(await handleReturn(back(orderToken(ru)), deps))).toBe(`/ru/makse#tulemus=makstud&liik=registreering`);
});

test("ABANDONED: katkestatud with the registration's 'Maksa' token; PENDING (a cancel at the bank): pooleli with it too; held: pooleli without", async () => {
  const m = stubMontonio();
  const c = await contactCourse(db);
  const r = await registrationOn(db, c);
  const { deps } = settleDeps(db, m.montonio, NOW);
  const a = await pendingPayment(db, r);
  expect(where(await handleReturn(back(orderToken(a, { paymentStatus: "ABANDONED" })), deps))).toBe(`/makse#tulemus=katkestatud&liik=registreering&maksa=${r.payToken}`);
  const b = await pendingPayment(db, r);
  expect(where(await handleReturn(back(orderToken(b, { paymentStatus: "PENDING" })), deps))).toBe(`/makse#tulemus=pooleli&liik=registreering&maksa=${r.payToken}`);
  const held = await pendingPayment(db, await registrationOn(db, c, { email: "kolmas@example.com" }));
  expect(where(await handleReturn(back(orderToken(held, { grandTotal: 1 })), deps))).toBe(`/makse#tulemus=pooleli&liik=registreering`);
});

test("an e-course: makstud with its slug ('Ava e-koolitus'); katkestatud with its slug (the cart's retry)", async () => {
  const m = stubMontonio();
  const [course] = await db
    .insert(courses)
    .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000 })
    .returning();
  const { deps } = settleDeps(db, m.montonio, NOW);
  const buy = async (email: string) => {
    const p = await insertPayment(db, { kind: "ecourse", registrationId: null, courseId: course.id, clientId: null, email, name: "Kati Tamm", locale: "et", amountCents: 19000 }, NOW);
    await attachOrder(db, p.id, `uuid-${p.id}`, NOW);
    return { ...p, providerUuid: `uuid-${p.id}` };
  };
  expect(where(await handleReturn(back(orderToken(await buy("kati@example.test"))), deps))).toBe(`/makse#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus`);
  expect(where(await handleReturn(back(orderToken(await buy("mari@example.test"), { paymentStatus: "ABANDONED" })), deps))).toBe(`/makse#tulemus=katkestatud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus`);
  // a cancel at the bank (PENDING): the cart's retry as well; a held one (the money is at Montonio): no way on, so no retry
  expect(where(await handleReturn(back(orderToken(await buy("pooleli@example.test"), { paymentStatus: "PENDING" })), deps))).toBe(`/makse#tulemus=pooleli&liik=ekoolitus&kursus=kulmumeistri-e-koolitus`);
  expect(where(await handleReturn(back(orderToken(await buy("held@example.test"), { grandTotal: 1 })), deps))).toBe(`/makse#tulemus=pooleli&liik=ekoolitus`);
});

test("a refunded payment is 'jäi tegemata' with no way to pay again: 'Proovi uuesti' would charge her twice for what she can still open", async () => {
  const m = stubMontonio();
  const c = await contactCourse(db);
  const r = await registrationOn(db, c);
  const [course] = await db
    .insert(courses)
    .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000 })
    .returning();
  const { deps } = settleDeps(db, m.montonio, NOW);
  // paid first, refunded after (the usual order), and a refund that is the first word of Montonio about the row
  const paidThenRefunded = await pendingPayment(db, r);
  await handleReturn(back(orderToken(paidThenRefunded)), deps);
  expect(where(await handleReturn(back(orderToken(paidThenRefunded, { paymentStatus: "REFUNDED" })), deps))).toBe("/makse#tulemus=katkestatud&liik=registreering");
  const refundedFirst = await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" }));
  expect(where(await handleReturn(back(orderToken(refundedFirst, { paymentStatus: "PARTIALLY_REFUNDED" })), deps))).toBe("/makse#tulemus=katkestatud&liik=registreering");
  // an e-course: no slug for the cart's retry either
  const e = await insertPayment(db, { kind: "ecourse", registrationId: null, courseId: course.id, clientId: null, email: "kati@example.test", name: "Kati Tamm", locale: "et", amountCents: 19000 }, NOW);
  await attachOrder(db, e.id, `uuid-${e.id}`, NOW);
  const ecourse = { ...e, providerUuid: `uuid-${e.id}` };
  expect(where(await handleReturn(back(orderToken(ecourse, { paymentStatus: "REFUNDED" })), deps))).toBe("/makse#tulemus=katkestatud&liik=ekoolitus");
  expect((await db.select().from(payments).where(eq(payments.id, e.id)))[0].status).toBe("refunded");
});

test("what the payment was for is read after the settlement; when that read fails, a paid payment still lands on makstud", async () => {
  const m = stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  const p = await pendingPayment(db, r);
  const { deps } = settleDeps(db, m.montonio, NOW);
  vi.spyOn(paymentQueries, "paymentContext").mockRejectedValue(new Error("db down"));
  expect(where(await handleReturn(back(orderToken(p)), deps))).toBe("/makse#tulemus=makstud&liik=registreering");
  expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0].status).toBe("paid");
  // a failed one has no "Maksa" token to offer then, but is not turned into 'pooleli' either
  const q = await pendingPayment(db, r);
  expect(where(await handleReturn(back(orderToken(q, { paymentStatus: "ABANDONED" })), deps))).toBe("/makse#tulemus=katkestatud&liik=registreering");
});

test("a token that cannot be verified, none, or an unknown reference: /makse#tulemus=katkestatud, nothing else", async () => {
  const m = stubMontonio();
  const { deps } = settleDeps(db, m.montonio, NOW);
  for (const req of [back("not-a-token"), new Request(`${SITE}/api/payments/return`), back(orderToken({ reference: "MSLAB-M999", amountCents: 100, providerUuid: "u" }))])
    expect(target(await handleReturn(req, deps))).toEqual([303, `/makse#tulemus=katkestatud`, "no-store", "no-referrer"]);
});

test("a token in doubt that Montonio cannot confirm, or a database failure: pooleli (the webhook and the daily check settle it later)", async () => {
  const m = stubMontonio();
  const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(where(await handleReturn(back(orderToken(p, { accessKey: "someone-else" })), deps))).toBe(`/makse#tulemus=pooleli&liik=registreering`);
  const broken = { select: () => { throw new Error("db down"); } } as unknown as Db;
  expect(where(await handleReturn(back(orderToken(p)), { ...deps, db: broken }))).toBe(`/makse#tulemus=pooleli`);
});

test("a token of another secret, a cut-off token, an empty or a huge one: katkestatud, never an error and never a settlement", async () => {
  const m = stubMontonio();
  const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
  const { deps, flush } = settleDeps(db, m.montonio, NOW);
  const good = orderToken(p);
  for (const raw of [orderToken(p, {}, { secret: "another-secret-0123456789abcdef" }), good.slice(0, -4), good.split(".").slice(0, 2).join("."), "", " ", "a.b.c", "x".repeat(200_000)])
    expect(target(await handleReturn(back(raw), deps)), raw.slice(0, 20)).toEqual([303, `/makse#tulemus=katkestatud`, "no-store", "no-referrer"]);
  await flush();
  expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0].status).toBe("pending");
  expect(m.mails()).toEqual([]);
  expect(m.state.gets).toEqual([]); // nothing unverified is ever asked about at Montonio
});

test("the snake_case twin of the parameter is taken too; the documented one comes first", async () => {
  const m = stubMontonio();
  const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
  const { deps } = settleDeps(db, m.montonio, NOW);
  const twin = new Request(`${SITE}/api/payments/return?order_token=${encodeURIComponent(orderToken(p))}`);
  expect(where(await handleReturn(twin, deps))).toBe(`/makse#tulemus=makstud&liik=registreering`);
  const both = new Request(`${SITE}/api/payments/return?order-token=not-a-token&order_token=${encodeURIComponent(orderToken(p))}`);
  expect(where(await handleReturn(both, deps))).toBe(`/makse#tulemus=katkestatud`);
});

test("a reload of the same address, and the webhook racing the return: the payment is settled once, every answer is the same", async () => {
  const m = stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  const p = await pendingPayment(db, r);
  const { deps, flush } = settleDeps(db, m.montonio, NOW);
  const token = orderToken(p);
  const notify = new Request(`${SITE}/api/payments/notify`, { method: "POST", body: JSON.stringify({ orderToken: token }) });
  const answers = await Promise.all([handleReturn(back(token), deps), handleNotify(notify, deps), handleReturn(back(token), deps), handleReturn(back(token), deps)]);
  expect(answers[1].status).toBe(200);
  for (const i of [0, 2, 3]) expect(where(answers[i]), String(i)).toBe(`/makse#tulemus=makstud&liik=registreering`);
  expect(where(await handleReturn(back(token), deps))).toBe(`/makse#tulemus=makstud&liik=registreering`);
  await flush();
  expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0]).toMatchObject({ status: "confirmed", paidCents: 17500 });
  expect(m.mails().map((x) => x.subject.split(" — ")[0].split(":")[0])).toEqual(["Koht on kinnitatud", "Uus makse"]); // the payer's mail and Maria's notice, once
});

test("the fragment carries the outcome, the kind, the 'Maksa' token and the slug and nothing else; the target is our own page, a path with no host in it", async () => {
  const m = stubMontonio();
  const c = await contactCourse(db);
  const r = await registrationOn(db, c, { email: "kati@example.com", name: "Kati Tamm", phone: "+372 5555 0101" });
  const { deps } = settleDeps(db, m.montonio, NOW);
  const tokens = [
    orderToken(await pendingPayment(db, r), { paymentStatus: "ABANDONED" }),
    orderToken(await pendingPayment(db, r), { paymentStatus: "PENDING" }),
    orderToken(await pendingPayment(db, await registrationOn(db, c, { email: "teine@example.com" })), { grandTotal: 1 }),
    orderToken(await pendingPayment(db, await registrationOn(db, c, { email: "kolmas@example.com" }))),
    orderToken({ reference: "MSLAB-M999", amountCents: 100, providerUuid: "u" }),
    "garbage",
  ];
  for (const token of tokens) {
    const res = await handleReturn(back(token), deps);
    // a relative reference: the browser resolves it against the address it is already at, so no host value reaches the redirect
    expect(where(res)).toMatch(/^\/makse#/);
    const url = new URL(where(res)!, SITE);
    expect(url.pathname).toBe("/makse");
    expect(url.search).toBe("");
    const fragment = [...new URLSearchParams(url.hash.slice(1))];
    expect(fragment.every(([k]) => ["tulemus", "liik", "maksa", "kursus"].includes(k)), url.hash).toBe(true);
    // (the "Maksa" token is random: it is left out of the search for words)
    const words = fragment.filter(([k]) => k !== "maksa").map(([, v]) => v).join(" ");
    for (const secret of ["@", "example", "Kati", "5555", "uuid", "17500", "175", "MSLAB", "Swedbank"]) expect(words, secret).not.toContain(secret);
  }
  // the path is ours alone, whatever the address carries or whichever host the request came to
  const evil = new Request(`${SITE}/api/payments/return?order-token=x&next=https://evil.example&redirect=//evil.example/x&locale=ru`);
  expect(where(await handleReturn(evil, deps))).toBe(`/makse#tulemus=katkestatud`);
  expect(where(await handleReturn(new Request(`http://localhost:3000/api/payments/return?order-token=x`), deps))).toBe("/makse#tulemus=katkestatud");
});

test("returnTarget: /makse for Estonian, /ru/makse for Russian, the fragment as domain/payments.ts writes it", () => {
  expect(returnTarget("et", { outcome: "pooleli", kind: null, payToken: null, course: null })).toBe("/makse#tulemus=pooleli");
  expect(returnTarget("ru", { outcome: "katkestatud", kind: "ekoolitus", payToken: null, course: "kulmumeistri-e-koolitus" })).toBe("/ru/makse#tulemus=katkestatud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus");
});

test("the log has no order token, no 'Maksa' token and no address", async () => {
  const m = stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  const { deps, flush } = settleDeps(db, m.montonio, NOW);
  const good = orderToken(await pendingPayment(db, r), { paymentStatus: "ABANDONED" });
  await handleReturn(back(good), deps);
  await handleReturn(back("not-a-token"), deps);
  await handleReturn(back(orderToken(await pendingPayment(db, r), { accessKey: "someone-else" })), deps);
  await handleReturn(back(good), { ...deps, db: { select: () => { throw new Error(`down for ${r.email} ${good}`); } } as unknown as Db });
  await flush();
  const lines = log.flatMap((spy) => spy.mock.calls.map((c) => c.map(String).join(" "))).join("\n");
  for (const secret of [good, good.split(".")[1], r.payToken, r.email, "not-a-token"]) expect(lines).not.toContain(secret);
});

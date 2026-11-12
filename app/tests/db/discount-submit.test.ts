import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, isNotNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { contracts, courses, pages, discountCodes, discountRedemptions, payments, registrations, settings, subscribers, type Course, type CourseSession } from "@/db/schema";
import { euro } from "@/domain/invoice";
import type { Env } from "@/server/notify";
import { handleEcoursePurchase, handleRegistration, type Deps } from "@/server/submit";
import { fakeKv } from "../fakes";
import { contactCourse, registrationOn, stubMontonio } from "./payments-fixtures";
import { makeTestDb, shownContractVersion } from "./helpers";

// Discount codes (F1, Task 6): the group registration redeems a code in the seat transaction, on PGlite.

const NOW = new Date("2026-11-11T10:00:00Z");
let db: Db;
let course: Course;
let session: CourseSession;
let other: { course: Course; session: CourseSession };
let contractVersion = "";
let n = 0;

beforeAll(async () => {
  db = await makeTestDb();
  contractVersion = await shownContractVersion(db);
  ({ course, session } = await contactCourse(db));
  // a second contact course, for the person rules that look across courses
  const [c2] = await db
    .insert(courses)
    .values({ slug: "ripsmed", type: "contact", level: "basic", title: { et: "Ripsmed" }, summary: { et: "" }, body: { et: "" }, published: true, priceGroup: 30000 })
    .returning();
  const { courseSessions } = await import("@/db/schema");
  const [s2] = await db.insert(courseSessions).values({ courseId: c2.id, startsAt: new Date("2026-11-20T08:00:00Z"), city: "Tartu", venue: "Stuudio", capacity: 4 }).returning();
  other = { course: c2, session: s2 };
});

afterEach(async () => {
  await db.update(courses).set({ priceGroup: 35000 }).where(eq(courses.id, course.id));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const setup = (): Deps => {
  const env: Env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: "https://mslab.example" };
  return { db, env, ip: null, siteUrl: "https://mslab.example", now: NOW, later: () => {} };
};
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const email = () => `kasutaja${++n}@example.test`;
const submit = (extra: Record<string, string>, who = email(), target = { slug: course.slug, sessionId: session.id }) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return handleRegistration(
    setup(),
    form({ course: target.slug, session: String(target.sessionId), name: "Kati Tamm", email: who, phone: "+372 5555 0101", payment: "half", terms: "on", locale: "et", contractVersion, ...extra }),
  );
};
async function makeCode(over: Partial<typeof discountCodes.$inferInsert> = {}) {
  const [row] = await db
    .insert(discountCodes)
    .values({ code: `PROOV-${++n}`, percent: over.amountCents ? null : 10, audience: "all", ...over })
    .returning();
  return row;
}
const rowsOf = async (who: string) => db.select().from(registrations).where(eq(registrations.email, who));

describe("a registration with a code", () => {
  it("a registration with a code stores the discount, the use and the contract with the total in one transaction", async () => {
    const code = await makeCode({ code: "PROOV-16" });
    const who = email();
    expect(await submit({ discountCode: " proov-16 ", discountCents: "3500" }, who)).toEqual({ ok: true });
    const [r] = await rowsOf(who);
    expect(r).toMatchObject({ discountCents: 3500, discountCode: "PROOV-16" });
    const uses = await db.select().from(discountRedemptions).where(eq(discountRedemptions.codeId, code.id));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ via: "form", listCents: 35000, discountCents: 3500, registrationId: r.id, email: who, courseId: course.id });
    const [contract] = await db.select().from(contracts).where(eq(contracts.registrationId, r.id));
    expect(contract.fields.price).toBe(euro(31500));
  });

  it("no code: nothing is redeemed, and a shown discount without a code is ignored", async () => {
    const who = email();
    expect(await submit({ discountCents: "3500" }, who)).toEqual({ ok: true });
    expect((await rowsOf(who))[0]).toMatchObject({ discountCents: 0, discountCode: "" });
  });

  it("a refusal stores nothing", async () => {
    const code = await makeCode({ active: false });
    const who = email();
    const contractsBefore = (await db.select().from(contracts)).length;
    expect(await submit({ discountCode: code.code, discountCents: "3500" }, who)).toEqual({ ok: false, errors: { discountCode: "paused" } });
    expect(await rowsOf(who)).toHaveLength(0);
    expect(await db.select().from(discountRedemptions).where(eq(discountRedemptions.codeId, code.id))).toHaveLength(0);
    expect(await db.select().from(contracts)).toHaveLength(contractsBefore);
    expect(await submit({ discountCode: "EI-OLE-SEDA", discountCents: "3500" }, who)).toEqual({ ok: false, errors: { discountCode: "unknown" } });
  });

  it("every person reason answers person, and the answers are identical", async () => {
    const answers: unknown[] = [];
    // used: she has the code on another course's unpaid registration
    const used = await makeCode({ oncePerPerson: true });
    const a = email();
    const prior = await registrationOn(db, other, { email: a });
    await db.insert(discountRedemptions).values({ codeId: used.id, email: a, courseId: other.course.id, registrationId: prior.id, listCents: 30000, discountCents: 3000, via: "form", createdAt: NOW });
    answers.push(await submit({ discountCode: used.code, discountCents: "3500" }, a));
    // first: the code is for people with no earlier booking, and she has a confirmed one
    const first = await makeCode({ audience: "first" });
    const b = email();
    await registrationOn(db, other, { email: b, status: "confirmed", paidCents: 15000 });
    answers.push(await submit({ discountCode: first.code, discountCents: "3500" }, b));
    // returning: she has none
    const returning = await makeCode({ audience: "returning" });
    answers.push(await submit({ discountCode: returning.code, discountCents: "3500" }));
    // subscriber and expired: the welcome code (one row at a time)
    const welcome = await makeCode({ welcome: true, audience: "first", daysAfterSignup: 1 });
    answers.push(await submit({ discountCode: welcome.code, discountCents: "3500" }));
    const c = email();
    await db.insert(subscribers).values({ email: c, token: `t${n}`, consentAt: new Date("2026-10-01T10:00:00Z"), confirmedAt: new Date("2026-10-01T10:00:00Z") });
    answers.push(await submit({ discountCode: welcome.code, discountCents: "3500" }, c));
    await db.delete(discountRedemptions).where(eq(discountRedemptions.codeId, used.id));
    await db.delete(discountCodes).where(eq(discountCodes.id, welcome.id));
    expect(answers).toHaveLength(5);
    for (const answer of answers) expect(answer).toEqual({ ok: false, errors: { discountCode: "person" } });
  });

  it("changed when the shown discount is smaller, larger, or missing", async () => {
    const code = await makeCode();
    for (const shown of [{ discountCents: "3499" }, { discountCents: "3501" }, {}] as Record<string, string>[]) {
      const who = email();
      expect(await submit({ discountCode: code.code, ...shown }, who)).toEqual({ ok: false, errors: { discountCode: "changed" } });
      expect(await rowsOf(who)).toHaveLength(0);
    }
  });

  it("a malformed shown discount is changed, a too long code unknown", async () => {
    const code = await makeCode();
    expect(await submit({ discountCode: code.code, discountCents: "-5" })).toEqual({ ok: false, errors: { discountCode: "changed" } });
    expect(await submit({ discountCode: "X".repeat(61), discountCents: "100" })).toEqual({ ok: false, errors: { discountCode: "unknown" } });
  });

  it("a list price changed after the check answers changed for a percent code; a euro code passes", async () => {
    const percent = await makeCode();
    const euros = await makeCode({ amountCents: 3500, percent: null });
    await db.update(courses).set({ priceGroup: 40000 }).where(eq(courses.id, course.id));
    const who = email();
    expect(await submit({ discountCode: percent.code, discountCents: "3500" }, who)).toEqual({ ok: false, errors: { discountCode: "changed" } });
    expect(await rowsOf(who)).toHaveLength(0);
    expect(await submit({ discountCode: euros.code, discountCents: "3500" })).toEqual({ ok: true });
  });

  it("a code worth nothing here is refused scope and stores nothing", async () => {
    const code = await makeCode();
    await db.update(courses).set({ priceGroup: 100 }).where(eq(courses.id, course.id));
    const who = email();
    expect(await submit({ discountCode: code.code, discountCents: "0" }, who)).toEqual({ ok: false, errors: { discountCode: "scope" } });
    expect(await rowsOf(who)).toHaveLength(0);
    expect(await db.select().from(discountRedemptions).where(eq(discountRedemptions.codeId, code.id))).toHaveLength(0);
  });

  it("the newsletter box counts as subscribing for the welcome code", async () => {
    const welcome = await makeCode({ welcome: true, audience: "first" });
    const who = email();
    expect(await submit({ discountCode: welcome.code, discountCents: "3500" }, who)).toEqual({ ok: false, errors: { discountCode: "person" } });
    // (the refusal stored nothing)
    expect(await rowsOf(who)).toHaveLength(0);
    expect(await db.select().from(discountRedemptions).where(eq(discountRedemptions.codeId, welcome.id))).toHaveLength(0);
    expect(await submit({ discountCode: welcome.code, discountCents: "3500", newsletter: "on" }, who)).toEqual({ ok: true });
    // P10: the booking carries the code and its euros, and its one use is written for it
    const [r] = await rowsOf(who);
    expect(r).toMatchObject({ discountCents: 3500, discountCode: welcome.code });
    const uses = await db.select().from(discountRedemptions).where(eq(discountRedemptions.codeId, welcome.id));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ via: "form", listCents: 35000, discountCents: 3500, registrationId: r.id, email: who, courseId: course.id });
    await db.delete(discountRedemptions).where(eq(discountRedemptions.codeId, welcome.id));
    await db.delete(discountCodes).where(eq(discountCodes.id, welcome.id));
  });

  it("the welcome code twice for the same course before paying: both get it; for another course: person", async () => {
    const welcome = await makeCode({ welcome: true, audience: "first" });
    const who = email();
    const again = { discountCode: welcome.code, discountCents: "3500", newsletter: "on" };
    expect(await submit(again, who)).toEqual({ ok: true });
    expect(await submit(again, who)).toEqual({ ok: true });
    const both = await rowsOf(who);
    expect(both).toHaveLength(2);
    // P10: each booking has the discount and its own use
    for (const r of both) expect(r).toMatchObject({ courseId: course.id, discountCents: 3500, discountCode: welcome.code });
    const usesNow = async () => (await db.select().from(discountRedemptions).where(eq(discountRedemptions.codeId, welcome.id))).map((u) => u.registrationId).sort();
    expect(await usesNow()).toEqual(both.map((r) => r.id).sort());
    // the other course (30 000: 10% is 3 000)
    expect(await submit({ ...again, discountCents: "3000" }, who, { slug: other.course.slug, sessionId: other.session.id })).toEqual({ ok: false, errors: { discountCode: "person" } });
    // (that refusal stored neither a booking nor a use)
    expect(await rowsOf(who)).toHaveLength(2);
    expect(await usesNow()).toEqual(both.map((r) => r.id).sort());
    await db.delete(discountRedemptions).where(eq(discountRedemptions.codeId, welcome.id));
    await db.delete(discountCodes).where(eq(discountCodes.id, welcome.id));
  });

  it("an empty hidden discount field is no discount: no code and discountCents empty answers ok, never changed", async () => {
    expect(await submit({ discountCode: "", discountCents: "" })).toEqual({ ok: true });
    expect(await submit({ discountCents: "" })).toEqual({ ok: true });
  });
});

describe("an e-course start with a code (Task 7)", () => {
  let ecourse: Course;
  let ecourseVersion = "";
  beforeAll(async () => {
    // the e-course terms carry the price (the snapshot's text is the filled contract)
    await db.insert(pages).values({ key: "course_terms", title: { et: "Tingimused" }, body: { et: "Hind: {hind}." } });
    ecourseVersion = await shownContractVersion(db, "ecourse");
    [ecourse] = await db
      .insert(courses)
      .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
      .returning();
  });
  afterEach(async () => {
    await db.update(courses).set({ price: 19000 }).where(eq(courses.id, ecourse.id));
    await db.delete(settings).where(eq(settings.key, "financing"));
    // (each test's Montonio stub numbers its orders from 1: the uuids must not meet in the shared database)
    await db.delete(discountRedemptions).where(isNotNull(discountRedemptions.paymentId));
    await db.delete(payments);
  });

  const buy = (m: ReturnType<typeof stubMontonio>, extra: Record<string, string>, who: string, at: Date = NOW) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const env: Env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: "https://mslab.example" };
    const fd = form({ course: ecourse.slug, name: "Kati Tamm", email: who, terms: "on", locale: "et", contractVersion: ecourseVersion, ...extra });
    return handleEcoursePurchase({ db, env, ip: null, siteUrl: "https://mslab.example", now: at, later: () => {}, montonio: m.montonio }, fd);
  };
  const paymentsOf = (who: string) => db.select().from(payments).where(eq(payments.email, who));
  const usesOf = (codeId: number) => db.select().from(discountRedemptions).where(eq(discountRedemptions.codeId, codeId));

  it("an e-course start with a code stores the total, the code and the snapshot", async () => {
    const code = await makeCode({ code: "PROOV-E1" });
    const m = stubMontonio();
    const who = email();
    expect(await buy(m, { discountCode: " proov-e1 ", discountCents: "1900" }, who)).toMatchObject({ ok: true });
    const [p] = await paymentsOf(who);
    expect(p).toMatchObject({ amountCents: 17100, discountCents: 1900, discountCode: "PROOV-E1", kind: "ecourse" });
    expect(p.contractSnapshot?.body).toContain(euro(17100));
    expect(m.state.orders[0]).toMatchObject({ grandTotal: 171 });
    const uses = await usesOf(code.id);
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ via: "cart", paymentId: p.id, registrationId: null, listCents: 19000, discountCents: 1900, email: who, courseId: ecourse.id });
  });

  it("no code: the list price, no redemption, and an empty discountCents is no discount", async () => {
    const m = stubMontonio();
    const who = email();
    expect(await buy(m, { discountCode: "", discountCents: "" }, who)).toMatchObject({ ok: true });
    const [p] = await paymentsOf(who);
    expect(p).toMatchObject({ amountCents: 19000, discountCents: 0, discountCode: "" });
    expect(p.contractSnapshot?.body).toContain(euro(19000));
  });

  it("a re-send inside the window with the same code reuses the order and inserts no second use", async () => {
    const code = await makeCode();
    const m = stubMontonio();
    const who = email();
    expect(await buy(m, { discountCode: code.code, discountCents: "1900" }, who)).toMatchObject({ ok: true });
    expect(await buy(m, { discountCode: code.code, discountCents: "1900" }, who, new Date(NOW.getTime() + 60_000))).toMatchObject({ ok: true });
    expect(await paymentsOf(who)).toHaveLength(1);
    expect(await usesOf(code.id)).toHaveLength(1);
    expect(m.state.orders).toHaveLength(2);
  });

  it("a re-send of the last use under maxUses 1 reuses the order and is not usedUp", async () => {
    const code = await makeCode({ maxUses: 1 });
    const m = stubMontonio();
    const who = email();
    expect(await buy(m, { discountCode: code.code, discountCents: "1900" }, who)).toMatchObject({ ok: true });
    expect(await buy(m, { discountCode: code.code, discountCents: "1900" }, who, new Date(NOW.getTime() + 60_000))).toMatchObject({ ok: true });
    expect(await paymentsOf(who)).toHaveLength(1);
    expect(await usesOf(code.id)).toHaveLength(1);
    // another person meets the full code
    expect(await buy(m, { discountCode: code.code, discountCents: "1900" }, email())).toEqual({ ok: false, errors: { discountCode: "usedUp" } });
  });

  it("a re-send after the code was paused answers paused and reuses nothing", async () => {
    const code = await makeCode();
    const m = stubMontonio();
    const who = email();
    expect(await buy(m, { discountCode: code.code, discountCents: "1900" }, who)).toMatchObject({ ok: true });
    const [before] = await paymentsOf(who);
    await db.update(discountCodes).set({ active: false }).where(eq(discountCodes.id, code.id));
    expect(await buy(m, { discountCode: code.code, discountCents: "1900" }, who, new Date(NOW.getTime() + 60_000))).toEqual({ ok: false, errors: { discountCode: "paused" } });
    expect(await paymentsOf(who)).toEqual([before]);
    expect(await usesOf(code.id)).toHaveLength(1);
    expect(m.state.orders).toHaveLength(1);
  });

  it("switching method under maxUses 1 is not usedUp against her own open attempt", async () => {
    await db.insert(settings).values({ key: "financing", value: { enabled: true } });
    const code = await makeCode({ maxUses: 1 });
    const m = stubMontonio();
    const who = email();
    expect(await buy(m, { discountCode: code.code, discountCents: "1900" }, who)).toMatchObject({ ok: true });
    expect(await buy(m, { method: "hirePurchase", discountCode: code.code, discountCents: "1900" }, who, new Date(NOW.getTime() + 60_000))).toMatchObject({ ok: true });
    expect((await paymentsOf(who)).map((r) => r.method).sort()).toEqual(["hirePurchase", "paymentInitiation"]);
    // another person still meets the full code
    expect(await buy(m, { discountCode: code.code, discountCents: "1900" }, email())).toEqual({ ok: false, errors: { discountCode: "usedUp" } });
  });

  it("bank, then järelmaks, then a järelmaks re-send under maxUses 1 reuses the open attempt", async () => {
    await db.insert(settings).values({ key: "financing", value: { enabled: true } });
    const code = await makeCode({ maxUses: 1 });
    const m = stubMontonio();
    const who = email();
    const typed = { discountCode: code.code, discountCents: "1900" };
    expect(await buy(m, typed, who)).toMatchObject({ ok: true });
    expect(await buy(m, { method: "hirePurchase", ...typed }, who, new Date(NOW.getTime() + 60_000))).toMatchObject({ ok: true });
    const before = await paymentsOf(who);
    const loan = before.find((r) => r.method === "hirePurchase")!;
    expect(await buy(m, { method: "hirePurchase", ...typed }, who, new Date(NOW.getTime() + 120_000))).toMatchObject({ ok: true });
    const after = await paymentsOf(who);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    expect(after.find((r) => r.method === "hirePurchase")!.id).toBe(loan.id);
    expect(await usesOf(code.id)).toHaveLength(2);
  });

  it("a järelmaks re-send with its code is refused when järelmaks was switched off meanwhile, and the row is unchanged", async () => {
    await db.insert(settings).values({ key: "financing", value: { enabled: true } });
    const code = await makeCode();
    const m = stubMontonio();
    const who = email();
    expect(await buy(m, { method: "hirePurchase", discountCode: code.code, discountCents: "1900" }, who)).toMatchObject({ ok: true });
    const [before] = await paymentsOf(who);
    await db.delete(settings).where(eq(settings.key, "financing"));
    expect(await buy(m, { method: "hirePurchase", discountCode: code.code, discountCents: "1900" }, who, new Date(NOW.getTime() + 60_000))).toEqual({ ok: false, errors: { method: "financingOff" } });
    expect(await paymentsOf(who)).toEqual([before]);
    expect(await usesOf(code.id)).toHaveLength(1);
  });

  it("a re-send with another code is a new attempt", async () => {
    const a = await makeCode();
    const b = await makeCode({ amountCents: 1900, percent: null });
    const m = stubMontonio();
    const who = email();
    expect(await buy(m, { discountCode: a.code, discountCents: "1900" }, who)).toMatchObject({ ok: true });
    expect(await buy(m, { discountCode: b.code, discountCents: "1900" }, who, new Date(NOW.getTime() + 60_000))).toMatchObject({ ok: true });
    const rows = await paymentsOf(who);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.discountCode).sort()).toEqual([a.code, b.code].sort());
    expect(await usesOf(a.id)).toHaveLength(1);
    expect(await usesOf(b.id)).toHaveLength(1);
  });

  it("järelmaks is decided on the total", async () => {
    await db.insert(settings).values({ key: "financing", value: { enabled: true } });
    await db.update(courses).set({ price: 11000 }).where(eq(courses.id, ecourse.id));
    const code = await makeCode();
    const m = stubMontonio();
    const who = email();
    expect(await buy(m, { method: "hirePurchase", discountCode: code.code, discountCents: "1100" }, who)).toEqual({ ok: false, errors: { method: "financing" } });
    expect(await paymentsOf(who)).toHaveLength(0);
    expect(m.state.orders).toHaveLength(0);
  });

  it("a refused code starts nothing", async () => {
    const code = await makeCode({ maxUses: 1 });
    const m = stubMontonio();
    expect(await buy(m, { discountCode: code.code, discountCents: "1900" }, email())).toMatchObject({ ok: true });
    const who = email();
    expect(await buy(m, { discountCode: code.code, discountCents: "1900" }, who)).toEqual({ ok: false, errors: { discountCode: "usedUp" } });
    expect(await paymentsOf(who)).toHaveLength(0);
    expect(m.state.orders).toHaveLength(1);
  });

  it("a shown discount that is not the discount is changed, and starts nothing", async () => {
    const code = await makeCode();
    const m = stubMontonio();
    const who = email();
    expect(await buy(m, { discountCode: code.code, discountCents: "1800" }, who)).toEqual({ ok: false, errors: { discountCode: "changed" } });
    expect(await buy(m, { discountCode: code.code }, who)).toEqual({ ok: false, errors: { discountCode: "changed" } });
    expect(await paymentsOf(who)).toHaveLength(0);
  });
});

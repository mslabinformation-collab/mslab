import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { courseAccess, courses, courseSessions, discountCodeCourses, discountCodes, discountRedemptions, registrations, subscribers, type Course, type CourseSession, type DiscountCode, type Registration } from "@/db/schema";
import { useMark } from "@/domain/discount-codes";
import { findCode, insertRedemption, lockCode, personFacts, redeem, usesOf, welcomeCode, type RedeemInput } from "@/server/discount-codes";
import { clientWithAccess, contactCourse, ecourseCourse, ecoursePayment, registrationOn } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// Discount codes (F1, Task 3): the server's find, lock, count, person facts, redeem and welcome code, on PGlite.

const NOW = new Date("2026-11-11T10:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let db: Db;
let contact: { course: Course; session: CourseSession };
let other: { course: Course; session: CourseSession };
let ecourse: Course;
let n = 0;

beforeAll(async () => {
  db = await makeTestDb();
  contact = await contactCourse(db);
  ecourse = await ecourseCourse(db);
  const [course] = await db
    .insert(courses)
    .values({ slug: "teine-koolitus", type: "contact", level: "basic", title: { et: "Teine koolitus" }, summary: { et: "" }, body: { et: "" }, published: true, priceGroup: 35000 })
    .returning();
  const [session] = await db.insert(courseSessions).values({ courseId: course.id, startsAt: new Date("2026-12-14T08:00:00Z"), city: "Tallinn", venue: "MS LAB stuudio", capacity: 4 }).returning();
  other = { course, session };
});

/** A code with a fresh name; 10 %, everywhere, once per person, for anybody unless `over` says otherwise. */
async function makeCode(over: Partial<typeof discountCodes.$inferInsert> = {}, courseIds: number[] = []): Promise<DiscountCode> {
  const [row] = await db
    .insert(discountCodes)
    .values({ code: `TEST${++n}`, percent: over.amountCents ? null : 10, audience: "all", ...over })
    .returning();
  if (courseIds.length) await db.insert(discountCodeCourses).values(courseIds.map((courseId) => ({ codeId: row.id, courseId })));
  return row;
}

const email = () => `person${++n}@example.test`;

/** A registration on `on` (the contact course by default) by `who`, with a use of `code` written for it. */
async function bookedUse(code: DiscountCode, who: string, over: Partial<typeof registrations.$inferInsert> = {}, on = contact): Promise<Registration> {
  const r = await registrationOn(db, on, { email: who, ...over });
  await insertRedemption(db, { codeId: code.id, email: who, clientId: null, courseId: on.course.id, registrationId: r.id, listCents: 35000, discountCents: 3500, via: "form" }, NOW);
  return r;
}

/** An e-course payment by `who` in `status`, with a use of `code` written for it. */
async function paidUse(code: DiscountCode, who: string, over: Parameters<typeof ecoursePayment>[3] = {}) {
  const p = await ecoursePayment(db, ecourse, who, over);
  await insertRedemption(db, { codeId: code.id, email: who, clientId: p.clientId, courseId: ecourse.id, paymentId: p.id, listCents: 19000, discountCents: 1900, via: "cart" }, NOW);
  return p;
}

const factsOf = (code: DiscountCode, who: string, courseId = contact.course.id) => personFacts(db, who, { codeId: code.id, courseId });

describe("findCode and lockCode", () => {
  it("finds a typed code in any spelling, with its courses; unknown and non-code strings give null", async () => {
    const code = await makeCode({ code: "KEVAD-25", scope: "courses" }, [contact.course.id, ecourse.id]);
    expect(await findCode(db, " kevad‑25 ")).toMatchObject({ id: code.id, code: "KEVAD-25", courseIds: [contact.course.id, ecourse.id].sort((a, b) => a - b) });
    expect(await findCode(db, "NOSUCH")).toBeNull();
    expect(await findCode(db, "!!")).toBeNull();
    expect(await db.transaction((tx) => lockCode(tx, code.id))).toMatchObject({ id: code.id });
    expect(await db.transaction((tx) => lockCode(tx, 999_999))).toBeNull();
  });
});

describe("personFacts.uses (once per person)", () => {
  it("once per person: a cancelled booking gives the use back; a confirmed, part-paid or other-course booking keeps it", async () => {
    const code = await makeCode();
    const cancelled = email();
    await bookedUse(code, cancelled, { status: "cancelled" });
    expect((await factsOf(code, cancelled)).uses).toBe(0);
    const confirmed = email();
    await bookedUse(code, confirmed, { status: "confirmed", paidCents: 17500 });
    expect((await factsOf(code, confirmed)).uses).toBe(1);
    const partPaid = email();
    await bookedUse(code, partPaid, { status: "awaiting_prepayment", paidCents: 5000 });
    expect((await factsOf(code, partPaid)).uses).toBe(1);
    const elsewhere = email();
    await bookedUse(code, elsewhere, { status: "awaiting_prepayment", paidCents: 0 }, other);
    expect((await factsOf(code, elsewhere)).uses).toBe(1);
    // someone else's use is nobody's but their own
    expect((await factsOf(code, email())).uses).toBe(0);
  });

  it("once per person leaves out an unpaid, unconfirmed booking of the same course, whatever its age", async () => {
    const code = await makeCode();
    const fresh = email();
    await bookedUse(code, fresh, { createdAt: ago(HOUR) });
    expect((await factsOf(code, fresh)).uses).toBe(0);
    const old = email();
    await bookedUse(code, old, { createdAt: ago(72 * HOUR) });
    expect((await factsOf(code, old)).uses).toBe(0);
  });

  it("once per person: pending, failed and replaced e-course payments are left out; paid and held are not", async () => {
    const code = await makeCode();
    for (const status of ["pending", "failed", "replaced"] as const) {
      const who = email();
      await paidUse(code, who, { status });
      expect((await factsOf(code, who, ecourse.id)).uses, status).toBe(0);
    }
    for (const status of ["paid", "held"] as const) {
      const who = email();
      await paidUse(code, who, { status });
      expect((await factsOf(code, who, ecourse.id)).uses, status).toBe(1);
    }
  });

  it("once per person (R15): a refund that leaves the access keeps the use; a refund with the access revoked gives it back", async () => {
    const code = await makeCode();
    const kept = email();
    const keptClient = await clientWithAccess(db, kept, ecourse);
    await paidUse(code, kept, { status: "refunded", clientId: keptClient.id });
    expect((await factsOf(code, kept, ecourse.id)).uses).toBe(1);
    const gone = email();
    const goneClient = await clientWithAccess(db, gone, ecourse, { revoked: true });
    await paidUse(code, gone, { status: "refunded", clientId: goneClient.id });
    expect((await factsOf(code, gone, ecourse.id)).uses).toBe(0);
  });
});

describe("personFacts.trained and subscribedOn", () => {
  it("trained: paid, confirmed and an access count; unpaid, cancelled and a revoked access do not; a paid e-course counts", async () => {
    const trained = async (who: string) => (await factsOf(await makeCode(), who)).trained;
    const confirmed = email();
    await registrationOn(db, contact, { email: confirmed, status: "confirmed" });
    expect(await trained(confirmed)).toBe(true);
    const paid = email();
    await registrationOn(db, contact, { email: paid, paidCents: 5000 });
    expect(await trained(paid)).toBe(true);
    const paidCourse = email();
    await ecoursePayment(db, ecourse, paidCourse, { status: "paid" });
    expect(await trained(paidCourse)).toBe(true);
    const access = email();
    await clientWithAccess(db, access, ecourse);
    expect(await trained(access)).toBe(true);

    const unpaid = email();
    await registrationOn(db, contact, { email: unpaid });
    expect(await trained(unpaid)).toBe(false);
    const cancelled = email();
    await registrationOn(db, contact, { email: cancelled, status: "cancelled", paidCents: 5000 });
    expect(await trained(cancelled)).toBe(false);
    const revoked = email();
    await clientWithAccess(db, revoked, ecourse, { revoked: true });
    expect(await trained(revoked)).toBe(false);
    const pendingCourse = email();
    await ecoursePayment(db, ecourse, pendingCourse, { status: "pending" });
    expect(await trained(pendingCourse)).toBe(false);
  });

  it("subscribedOn is the Tallinn day of consent_at of a confirmed subscriber only", async () => {
    const code = await makeCode();
    const confirmed = email();
    await db.insert(subscribers).values({ email: confirmed, token: `t${++n}`, consentAt: new Date("2026-11-30T22:30:00Z"), confirmedAt: new Date("2026-11-30T22:31:00Z") });
    expect((await factsOf(code, confirmed)).subscribedOn).toBe("2026-12-01");
    const unconfirmed = email();
    await db.insert(subscribers).values({ email: unconfirmed, token: `t${++n}`, consentAt: new Date("2026-11-30T22:30:00Z"), confirmedAt: null });
    expect((await factsOf(code, unconfirmed)).subscribedOn).toBeNull();
    expect((await factsOf(code, email())).subscribedOn).toBeNull();
  });
});

describe("usesOf", () => {
  it("usesOf: an unpaid booking counts for 24 hours and then stops", async () => {
    const code = await makeCode();
    await bookedUse(code, email(), { createdAt: NOW });
    expect(await usesOf(db, code.id, new Date(NOW.getTime() + 23 * HOUR))).toBe(1);
    expect(await usesOf(db, code.id, new Date(NOW.getTime() + 25 * HOUR))).toBe(0);
  });

  it("usesOf: confirmed or part-paid keeps counting; a late payment on an old booking counts again, over the limit", async () => {
    const code = await makeCode({ maxUses: 1 });
    const old = ago(10 * 24 * HOUR);
    const first = await bookedUse(code, email(), { createdAt: old });
    expect(await usesOf(db, code.id, NOW)).toBe(0);
    await bookedUse(code, email(), { createdAt: old, status: "confirmed", paidCents: 35000 });
    expect(await usesOf(db, code.id, NOW)).toBe(1);
    // the first, old booking is paid late: both count now, the limit of 1 is passed
    await db.update(registrations).set({ paidCents: 17500 }).where(eq(registrations.id, first.id));
    expect(await usesOf(db, code.id, NOW)).toBe(2);
    await bookedUse(code, email(), { createdAt: old, paidCents: 100 });
    expect(await usesOf(db, code.id, NOW)).toBe(3);
  });

  it("usesOf: a cancellation and a failed payment give back; a pending payment counts inside its window and not after", async () => {
    const code = await makeCode();
    await bookedUse(code, email(), { status: "cancelled", createdAt: NOW });
    await paidUse(code, email(), { status: "failed" });
    expect(await usesOf(db, code.id, NOW)).toBe(0);

    const bank = await makeCode();
    await paidUse(bank, email(), { at: NOW, method: "paymentInitiation" });
    expect(await usesOf(db, bank.id, new Date(NOW.getTime() + 29 * MIN))).toBe(1);
    expect(await usesOf(db, bank.id, new Date(NOW.getTime() + 31 * MIN))).toBe(0);

    const loan = await makeCode();
    await paidUse(loan, email(), { at: NOW, method: "hirePurchase" });
    expect(await usesOf(db, loan.id, new Date(NOW.getTime() + 31 * MIN))).toBe(1);
    expect(await usesOf(db, loan.id, new Date(NOW.getTime() + 61 * MIN))).toBe(0);
  });

  it("usesOf (R15): a refund that leaves the access keeps counting; a refund with the access revoked gives back", async () => {
    const code = await makeCode();
    const kept = email();
    const keptClient = await clientWithAccess(db, kept, ecourse);
    await paidUse(code, kept, { status: "refunded", clientId: keptClient.id });
    expect(await usesOf(db, code.id, NOW)).toBe(1);
    const gone = email();
    await paidUse(code, gone, { status: "refunded", clientId: (await clientWithAccess(db, gone, ecourse, { revoked: true })).id });
    expect(await usesOf(db, code.id, NOW)).toBe(1);
    // the access of the first is ended later: its use gives back as well
    await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.clientId, keptClient.id));
    expect(await usesOf(db, code.id, NOW)).toBe(0);
  });

  it("usesOf equals the number of useMark 'counts' over the same rows", async () => {
    const code = await makeCode();
    const old = ago(5 * 24 * HOUR);
    await bookedUse(code, email(), { status: "cancelled", createdAt: NOW });
    await bookedUse(code, email(), { status: "confirmed", paidCents: 35000, createdAt: old });
    await bookedUse(code, email(), { paidCents: 5000, createdAt: old });
    await bookedUse(code, email(), { createdAt: ago(2 * HOUR) });
    await bookedUse(code, email(), { createdAt: old });
    await paidUse(code, email(), { status: "paid" });
    await paidUse(code, email(), { status: "held" });
    await paidUse(code, email(), { status: "pending", at: ago(10 * MIN), method: "paymentInitiation" });
    await paidUse(code, email(), { status: "pending", at: ago(40 * MIN), method: "paymentInitiation" });
    await paidUse(code, email(), { status: "pending", at: ago(40 * MIN), method: "hirePurchase" });
    await paidUse(code, email(), { status: "pending", at: ago(70 * MIN), method: "hirePurchase" });
    await paidUse(code, email(), { status: "failed" });
    await paidUse(code, email(), { status: "replaced" });
    const kept = email();
    await paidUse(code, kept, { status: "refunded", clientId: (await clientWithAccess(db, kept, ecourse)).id });
    const revoked = email();
    await paidUse(code, revoked, { status: "refunded", clientId: (await clientWithAccess(db, revoked, ecourse, { revoked: true })).id });

    const uses = await db.select().from(discountRedemptions).where(eq(discountRedemptions.codeId, code.id));
    const access = await db.select().from(courseAccess);
    const marks = await Promise.all(
      uses.map(async (u) => {
        const [r] = u.registrationId === null ? [] : await db.select().from(registrations).where(eq(registrations.id, u.registrationId));
        const p = u.paymentId === null ? null : await db.query.payments.findFirst({ where: (t, { eq: is }) => is(t.id, u.paymentId!) });
        return useMark(
          {
            registration: r ? { status: r.status, paidCents: r.paidCents, createdAt: r.createdAt } : null,
            payment: p
              ? {
                  status: p.status,
                  inWindow: p.updatedAt.getTime() + (p.method === "hirePurchase" ? 60 : 30) * MIN > NOW.getTime(),
                  accessKept: access.some((a) => a.clientId === p.clientId && a.courseId === p.courseId && a.revokedAt === null),
                }
              : null,
          },
          NOW,
        );
      }),
    );
    expect(uses).toHaveLength(15);
    expect(marks.filter((m) => m === "counts").length).toBeGreaterThan(5);
    expect(await usesOf(db, code.id, NOW)).toBe(marks.filter((m) => m === "counts").length);
  });

  it("usesOf: a use whose booking or payment is gone counts for nothing", async () => {
    const code = await makeCode();
    const r = await bookedUse(code, email(), { status: "confirmed" });
    expect(await usesOf(db, code.id, NOW)).toBe(1);
    await db.delete(registrations).where(eq(registrations.id, r.id));
    expect(await usesOf(db, code.id, NOW)).toBe(0);
  });
});

describe("redeem", () => {
  const input = (over: Partial<RedeemInput> = {}): RedeemInput => ({ typed: "", shownCents: 1000, email: "kati@example.test", courseId: contact.course.id, courseType: "contact", listCents: 10_000, subscribing: false, ...over });
  const run = (over: Partial<RedeemInput>) => db.transaction((tx) => redeem(tx, input(over), NOW));

  it("redeem: unknown, each code refusal, person for every person reason, changed for a smaller, a larger and a missing shownCents, ok", async () => {
    expect(await run({ typed: "NOSUCH" })).toEqual({ ok: false, error: "unknown" });
    expect(await run({ typed: "" })).toEqual({ ok: false, error: "unknown" });

    const paused = await makeCode({ active: false });
    expect(await run({ typed: paused.code })).toEqual({ ok: false, error: "paused" });
    const ended = await makeCode({ endsOn: "2026-11-10" });
    expect(await run({ typed: ended.code })).toEqual({ ok: false, error: "ended" });
    const notYet = await makeCode({ startsOn: "2026-11-12" });
    expect(await run({ typed: notYet.code })).toEqual({ ok: false, error: "notYet" });
    const ecourseOnly = await makeCode({ scope: "ecourse" });
    expect(await run({ typed: ecourseOnly.code })).toEqual({ ok: false, error: "scope" });
    const chosen = await makeCode({ scope: "courses" }, [other.course.id]);
    expect(await run({ typed: chosen.code })).toEqual({ ok: false, error: "scope" });
    const full = await makeCode({ maxUses: 1 });
    await bookedUse(full, email(), { status: "confirmed" });
    expect(await run({ typed: full.code })).toEqual({ ok: false, error: "usedUp" });

    // the person's reasons
    const once = await makeCode();
    await bookedUse(once, "kati@example.test", { status: "confirmed" });
    expect(await run({ typed: once.code })).toEqual({ ok: false, error: "person" });
    const first = await makeCode({ audience: "first" });
    expect(await run({ typed: first.code, email: "kati@example.test" })).toEqual({ ok: false, error: "person" });
    const returning = await makeCode({ audience: "returning" });
    expect(await run({ typed: returning.code, email: email() })).toEqual({ ok: false, error: "person" });
    const welcome = await makeCode({ welcome: true, audience: "first", oncePerPerson: true, daysAfterSignup: 5 });
    const fresh = email();
    expect(await run({ typed: welcome.code, email: fresh })).toEqual({ ok: false, error: "person" }); // not subscribed
    expect(await run({ typed: welcome.code, email: fresh, subscribing: true })).toMatchObject({ ok: true });
    const lapsed = email();
    await db.insert(subscribers).values({ email: lapsed, token: `t${++n}`, consentAt: new Date("2026-11-01T10:00:00Z"), confirmedAt: new Date("2026-11-01T10:01:00Z") });
    expect(await run({ typed: welcome.code, email: lapsed })).toEqual({ ok: false, error: "person" }); // 5 days have passed
    await db.delete(discountCodes).where(eq(discountCodes.id, welcome.id));

    // the price the form showed
    const ten = await makeCode();
    expect(await run({ typed: ten.code, shownCents: 900, email: email() })).toEqual({ ok: false, error: "changed" });
    expect(await run({ typed: ten.code, shownCents: 1100, email: email() })).toEqual({ ok: false, error: "changed" });
    expect(await run({ typed: ten.code, shownCents: null, email: email() })).toEqual({ ok: false, error: "changed" });
    expect(await run({ typed: ten.code, shownCents: 1000, email: email() })).toEqual({ ok: true, codeId: ten.id, code: ten.code, discountCents: 1000 });
  });

  it("redeem finds a code typed in lower case with spaces around it", async () => {
    await makeCode({ code: "TERE10" });
    expect(await run({ typed: "  tere10 ", email: email() })).toMatchObject({ ok: true, code: "TERE10", discountCents: 1000 });
  });

  it("redeem: a code bigger than the price leaves 1 €", async () => {
    const big = await makeCode({ code: "BIG", percent: null, amountCents: 20_000 });
    // 100 € list: the 200 € code is cut to leave 1 €
    expect(await run({ typed: big.code, shownCents: 9900, email: email() })).toMatchObject({ ok: true, discountCents: 9900 });
  });
});

describe("welcomeCode", () => {
  it("welcomeCode: the active welcome row valid today; null when paused, ended, not yet started or absent", async () => {
    const welcome = async (over: Partial<typeof discountCodes.$inferInsert>) => {
      await db.delete(discountCodes).where(eq(discountCodes.welcome, true));
      return makeCode({ code: "WELCOME10", welcome: true, audience: "first", oncePerPerson: true, daysAfterSignup: 7, ...over });
    };
    expect(await welcomeCode(db, NOW)).toBeNull();
    await welcome({});
    expect(await welcomeCode(db, NOW)).toEqual({ code: "WELCOME10", value: "10%", days: 7 });
    // the scope and the limit are not looked at (R10)
    await welcome({ scope: "courses", maxUses: 1 });
    expect(await welcomeCode(db, NOW)).toMatchObject({ code: "WELCOME10" });
    await welcome({ percent: null, amountCents: 1500, daysAfterSignup: null, startsOn: "2026-11-11", endsOn: "2026-11-11" });
    expect(await welcomeCode(db, NOW)).toEqual({ code: "WELCOME10", value: "15 €", days: null });
    await welcome({ active: false });
    expect(await welcomeCode(db, NOW)).toBeNull();
    await welcome({ endsOn: "2026-11-10" });
    expect(await welcomeCode(db, NOW)).toBeNull();
    await welcome({ startsOn: "2026-11-12" });
    expect(await welcomeCode(db, NOW)).toBeNull();
    await db.delete(discountCodes).where(eq(discountCodes.welcome, true));
  });
});

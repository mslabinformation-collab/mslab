import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "@/db/client";
import { attachOrder, failPayment, insertPayment, paymentByReference, paymentContext, releaseHold, releaseHoldLocked } from "@/db/queries/payments";
import { courses, payments, registrations } from "@/db/schema";
import { contactCourse, pendingPayment, registrationOn } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// The payments table's queries (phase 2b, spec 5.1): the reference is written with the row, a hold ends only when nothing else of the
// registration is still pending, and a failed payment is a conditional change.

const NOW = new Date("2026-10-09T10:00:00Z");
const MIN = 60_000;
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
});

const registration = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0];

describe("insertPayment", () => {
  test("a pending row whose reference is MSLAB-M<its id>, stamped with `now`; a new one for every attempt", async () => {
    const r = await registrationOn(db, await contactCourse(db));
    const input = { kind: "prepayment" as const, registrationId: r.id, courseId: r.courseId, clientId: null, email: r.email, name: r.name, locale: "et" as const, amountCents: 17500 };
    const a = await insertPayment(db, input, NOW);
    const b = await insertPayment(db, input, NOW);
    expect(a).toMatchObject({ reference: `MSLAB-M${a.id}`, status: "pending", providerUuid: null, paidAt: null, newsletter: false, method: "", bank: "", createdAt: NOW, updatedAt: NOW });
    expect(b.reference).toBe(`MSLAB-M${b.id}`);
    expect(b.reference).not.toBe(a.reference);
    expect((await db.select().from(payments)).map((x) => x.reference).sort()).toEqual([a.reference, b.reference].sort());
  });

  test("inside a caller's transaction it is a savepoint: it goes with the transaction, and no placeholder reference is left behind", async () => {
    const r = await registrationOn(db, await contactCourse(db));
    const input = { kind: "prepayment" as const, registrationId: r.id, courseId: r.courseId, clientId: null, email: r.email, name: r.name, locale: "et" as const, amountCents: 17500 };
    await expect(
      db.transaction(async (tx) => {
        const row = await insertPayment(tx, input, NOW);
        expect(row.reference).toBe(`MSLAB-M${row.id}`);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await db.select().from(payments)).toEqual([]);
  });

  test("the e-course's newsletter box is kept", async () => {
    const r = await registrationOn(db, await contactCourse(db));
    const row = await insertPayment(db, { kind: "ecourse", registrationId: null, courseId: r.courseId, clientId: null, email: "ostja@example.com", name: "Ostja", locale: "ru", amountCents: 19000, newsletter: true }, NOW);
    expect(row).toMatchObject({ kind: "ecourse", registrationId: null, locale: "ru", newsletter: true });
  });
});

describe("paymentByReference and attachOrder", () => {
  test("a payment by its reference, or null", async () => {
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    expect((await paymentByReference(db, p.reference))?.id).toBe(p.id);
    expect(await paymentByReference(db, "MSLAB-M99999")).toBeNull();
    expect(await paymentByReference(db, "")).toBeNull();
  });

  test("Montonio's uuid is attached once and never replaced here", async () => {
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)), { providerUuid: null });
    await attachOrder(db, p.id, "first", NOW);
    await attachOrder(db, p.id, "second", new Date(NOW.getTime() + MIN));
    expect((await paymentByReference(db, p.reference))?.providerUuid).toBe("first");
  });
});

describe("releaseHold", () => {
  const hold = (offsetMin: number) => new Date(NOW.getTime() + offsetMin * MIN);

  test("a live hold of an unpaid registration ends; true", async () => {
    const r = await registrationOn(db, await contactCourse(db), { seatHoldUntil: hold(10) });
    expect(await releaseHold(db, r.id, 0, NOW)).toBe(true);
    expect((await registration(r.id)).seatHoldUntil).toBeNull();
  });

  test("nothing to end: a hold that has ended (at the very moment too), no hold, a confirmed registration", async () => {
    const c = await contactCourse(db);
    for (const over of [{ seatHoldUntil: hold(-1) }, { seatHoldUntil: NOW }, { seatHoldUntil: null }, { status: "confirmed" as const, seatHoldUntil: hold(10) }]) {
      const r = await registrationOn(db, c, { email: `x${Math.random()}@example.com`, ...over });
      expect(await releaseHold(db, r.id, 0, NOW), JSON.stringify(over)).toBe(false);
      expect((await registration(r.id)).seatHoldUntil?.getTime() ?? null).toBe(over.seatHoldUntil?.getTime() ?? null);
    }
  });

  test("another pending payment of the registration keeps it; the payment itself does not count", async () => {
    const r = await registrationOn(db, await contactCourse(db), { seatHoldUntil: hold(10) });
    const first = await pendingPayment(db, r);
    const second = await pendingPayment(db, r);
    expect(await releaseHold(db, r.id, first.id, NOW)).toBe(false);
    await db.update(payments).set({ status: "failed" }).where(eq(payments.id, second.id));
    expect(await releaseHold(db, r.id, first.id, NOW)).toBe(true);
  });
});

describe("releaseHoldLocked (the release of a caller that holds no lock)", () => {
  const hold = (offsetMin: number) => new Date(NOW.getTime() + offsetMin * MIN);

  test("the same rule as releaseHold, in a transaction of its own: a live hold of an unpaid registration ends, another pending payment keeps it", async () => {
    const c = await contactCourse(db);
    const free = await registrationOn(db, c, { seatHoldUntil: hold(10) });
    expect(await releaseHoldLocked(db, free.id, NOW)).toBe(true);
    expect((await registration(free.id)).seatHoldUntil).toBeNull();
    const busy = await registrationOn(db, c, { email: "teine@example.com", seatHoldUntil: hold(10) });
    await pendingPayment(db, busy);
    expect(await releaseHoldLocked(db, busy.id, NOW)).toBe(false);
    expect((await registration(busy.id)).seatHoldUntil).toEqual(hold(10));
  });

  test("nothing to end: a hold that has ended, no hold, a confirmed registration, a registration that does not exist", async () => {
    const c = await contactCourse(db);
    for (const over of [{ seatHoldUntil: hold(-1) }, { seatHoldUntil: null }, { status: "confirmed" as const, seatHoldUntil: hold(10) }]) {
      const r = await registrationOn(db, c, { email: `x${Math.random()}@example.com`, ...over });
      expect(await releaseHoldLocked(db, r.id, NOW), JSON.stringify(over)).toBe(false);
    }
    expect(await releaseHoldLocked(db, 999_999, NOW)).toBe(false);
  });
});

describe("failPayment", () => {
  test("a pending prepayment fails and its hold ends, in one go", async () => {
    const r = await registrationOn(db, await contactCourse(db), { seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const p = await pendingPayment(db, r);
    const done = await failPayment(db, p.id, NOW);
    expect(done).toMatchObject({ released: true, payment: { id: p.id, status: "failed", updatedAt: NOW, paidAt: null } });
    expect((await registration(r.id)).seatHoldUntil).toBeNull();
  });

  test("a balance payment ends no hold; one that is not pending is null and changes nothing", async () => {
    const c = await contactCourse(db);
    const r = await registrationOn(db, c, { status: "confirmed", paidCents: 17500, seatHoldUntil: new Date(NOW.getTime() + 10 * MIN) });
    const balance = await pendingPayment(db, r, { kind: "balance" });
    expect(await failPayment(db, balance.id, NOW)).toMatchObject({ released: false, payment: { status: "failed" } });
    expect(await failPayment(db, balance.id, NOW)).toBeNull();
    for (const status of ["paid", "held", "refunded"] as const) {
      const p = await pendingPayment(db, await registrationOn(db, c, { email: `${status}@example.com` }));
      await db.update(payments).set({ status }).where(eq(payments.id, p.id));
      expect(await failPayment(db, p.id, NOW), status).toBeNull();
      expect((await paymentByReference(db, p.reference))?.status, status).toBe(status);
    }
  });
});

describe("paymentContext", () => {
  test("the course, the registration's session and its 'Maksa' token", async () => {
    const r = await registrationOn(db, await contactCourse(db));
    const p = await pendingPayment(db, r);
    const ctx = await paymentContext(db, p.id);
    expect(ctx.course).toEqual({ title: { et: "Kulmumeistri baaskoolitus", ru: "Базовый курс бровиста" }, slug: "kulmumeistri-baaskoolitus" });
    expect(ctx.session).toEqual({ startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio" });
    expect(ctx.payToken).toBe(r.payToken);
    expect(ctx.payToken).toHaveLength(43);
  });

  test("an e-course payment has a course and nothing else; a payment whose course is gone has nothing; an unknown payment too", async () => {
    const c = await contactCourse(db);
    const e = await insertPayment(db, { kind: "ecourse", registrationId: null, courseId: c.course.id, clientId: null, email: "ostja@example.com", name: "Ostja", locale: "et", amountCents: 19000 }, NOW);
    expect(await paymentContext(db, e.id)).toMatchObject({ course: { slug: "kulmumeistri-baaskoolitus" }, session: null, payToken: null });
    await db.update(payments).set({ courseId: null }).where(eq(payments.id, e.id));
    expect(await paymentContext(db, e.id)).toEqual({ course: null, session: null, payToken: null });
    expect(await paymentContext(db, 99999)).toEqual({ course: null, session: null, payToken: null });
    expect(await db.select().from(courses)).toHaveLength(1);
  });
});

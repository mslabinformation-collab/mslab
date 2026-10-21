import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "@/db/client";
import { adminCounts, setSetting } from "@/db/queries/admin";
import { eq } from "drizzle-orm";
import { courseSessions, invoices, payments, requests, reviews } from "@/db/schema";
import { testPlan } from "@/server/testplan";
import { makeTestDb } from "./helpers";
import { contactCourse, pendingPayment, registrationOn } from "./payments-fixtures";

// The numbers of the overview and the menu badges (admin UX pass, B6; README §1.1, spec S7) on a real (PGlite) database: what „Täna“ is in
// Tallinn, the reviews waiting for „Avalda“, what „Maksed ja arved“ asks Maria to look at, and the signed-in admin's own „Viga“ answers.

const ME = "maria@example.test";
const OTHER = "dim@example.test";
/** 23:30 UTC on 30.11 is already 01:30 on 1.12 in Tallinn (winter time, UTC+2). */
const MIDNIGHT = new Date("2026-11-30T23:30:00Z");

let db: Db;
let fixture: Awaited<ReturnType<typeof contactCourse>>;

beforeEach(async () => {
  db = await makeTestDb();
  // the fixture's own session (14.11.2026) is far from every `now` below
  fixture = await contactCourse(db, { capacity: 100 });
});

const counts = (email = ME, now = MIDNIGHT) => adminCounts(db, email, now);

describe("todaySessions", () => {
  test("uses the Tallinn date (23:30 UTC on 30.11 is 1.12 in Tallinn): a session at 1.12 10:00 counts, one at 30.11 counts not", async () => {
    const [tomorrowInUtc] = await db
      .insert(courseSessions)
      .values({ courseId: fixture.course.id, startsAt: new Date("2026-12-01T08:00:00Z"), city: "Tallinn" }) // 10:00 on 1.12 in Tallinn
      .returning();
    await db.insert(courseSessions).values({ courseId: fixture.course.id, startsAt: new Date("2026-11-30T08:00:00Z"), city: "Tallinn" }); // 10:00 on 30.11
    const { todaySessions } = await counts();
    expect(todaySessions).toEqual([{ id: tomorrowInUtc.id, startsAt: new Date("2026-12-01T08:00:00Z"), course: "Kulmumeistri baaskoolitus" }]);
  });

  test("scheduled sessions only, earliest first; nothing when no session is on today's date", async () => {
    expect((await counts()).todaySessions).toEqual([]);
    const late = await db.insert(courseSessions).values({ courseId: fixture.course.id, startsAt: new Date("2026-12-01T15:00:00Z"), city: "Pärnu" }).returning();
    const early = await db.insert(courseSessions).values({ courseId: fixture.course.id, startsAt: new Date("2026-12-01T07:00:00Z"), city: "Pärnu" }).returning();
    await db.insert(courseSessions).values({ courseId: fixture.course.id, startsAt: new Date("2026-12-01T09:00:00Z"), city: "Pärnu", status: "cancelled" });
    expect((await counts()).todaySessions.map((s) => s.id)).toEqual([early[0].id, late[0].id]);
  });
});

describe("waitingReviews", () => {
  test("counts reviews waiting for „Avalda“", async () => {
    const review = (status: "pending" | "published" | "hidden", n: number) => ({
      courseId: fixture.course.id,
      kind: "manual" as const,
      text: `Arvustus ${n}`,
      name: "Kati",
      locale: "et" as const,
      writtenAt: new Date("2026-10-01T09:00:00Z"),
      status,
    });
    expect((await counts()).waitingReviews).toBe(0);
    await db.insert(reviews).values([review("pending", 1), review("pending", 2), review("published", 3), review("hidden", 4)]);
    expect((await counts()).waitingReviews).toBe(2);
  });
});

describe("paymentsAttention", () => {
  const AT = new Date("2026-10-20T09:00:00Z");
  /** A payment of its own registration in `status` (paid ones carry their pay day; a voided one is `failed` with it). */
  async function payment(email: string, status: "pending" | "paid" | "failed" | "held" | "refunded", paid: boolean) {
    const r = await registrationOn(db, fixture, { email, name: "Kati Tamm" });
    const p = await pendingPayment(db, r, {}, AT);
    await db.update(payments).set({ status, paidAt: paid ? AT : null }).where(eq(payments.id, p.id));
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

  test("= unbilled paid + held + paid-then-voided", async () => {
    expect((await counts()).paymentsAttention).toBe(0);
    await payment("unbilled@example.test", "paid", true); // paid, no invoice names it
    await payment("held@example.test", "held", false); // „Ootel kontrollil“
    await payment("voided@example.test", "failed", true); // the bank took a paid payment back
    const billed = await payment("billed@example.test", "paid", true);
    await invoiceFor(billed.id, 1); // paid and invoiced: nothing to do
    expect((await counts()).paymentsAttention).toBe(3);
  });

  test("what needs no look does not count: pending, refunded, failed before it was paid, and a paid one once its invoice is made", async () => {
    await payment("pending@example.test", "pending", false);
    await payment("refunded@example.test", "refunded", true);
    await payment("failed@example.test", "failed", false);
    const catchUp = await payment("catchup@example.test", "paid", true);
    expect((await counts()).paymentsAttention).toBe(1);
    await invoiceFor(catchUp.id, 2);
    expect((await counts()).paymentsAttention).toBe(0);
  });
});

describe("ownFaults", () => {
  const [first, second, third] = testPlan.items.map((i) => i.id);
  const answer = (status: "ok" | "bad" | "skip", by: string) => ({ status, note: "", at: "2026-10-21T08:00:00.000Z", by });
  const save = (answers: Record<string, ReturnType<typeof answer>>) => setSetting(db, "testplan_answers", { v: 1, answers });

  test("counts only the signed-in admin's „Viga“ answers", async () => {
    expect((await counts()).ownFaults).toBe(0); // no answers saved yet
    await save({ [first]: answer("bad", ME), [second]: answer("bad", OTHER), [third]: answer("ok", ME) });
    expect((await counts(ME)).ownFaults).toBe(1);
    expect((await counts(OTHER)).ownFaults).toBe(1);
    expect((await counts("nobody@example.test")).ownFaults).toBe(0);
  });

  test("the address is compared without regard to case; answers to checks the plan no longer has are ignored", async () => {
    await save({ [first]: answer("bad", "Maria@Example.test"), "a-check-that-was-removed": answer("bad", ME) });
    expect((await counts(ME)).ownFaults).toBe(1);
  });
});

describe("the numbers it had before", () => {
  test("openRequests still counts every kind, „Muutmine“ included", async () => {
    await db.insert(requests).values([
      { kind: "contact", payload: { name: "A", email: "a@example.test", message: "Tere" } },
      { kind: "change_request", payload: { name: "B", email: "b@example.test" } },
      { kind: "change_request", payload: { name: "C", email: "c@example.test" }, handled: true },
      { kind: "waitlist", payload: { name: "W", email: "w@example.test" } },
    ]);
    const c = await counts();
    expect(c.openRequests).toEqual({ contact: 1, individual: 0, practice: 0, waitlist: 1, change_request: 1 });
    expect(Object.values(c.openRequests).reduce((a, b) => a + b, 0)).toBe(3);
  });
});

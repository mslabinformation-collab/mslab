import { beforeEach, describe, expect, test } from "vitest";
import { count, eq } from "drizzle-orm";
import { makeTestDb } from "./helpers";
import type { Db } from "@/db/client";
import { courseSessions, courses, registrations, requests, subscribers } from "@/db/schema";
import { applySeed } from "@/db/seed-apply";
import { SEEDED_AT } from "@/db/seed-data";
import { seedBaseDate } from "@/db/seed-dates";
import { applyDemo, DEMO_PLAN, demoPlan, isSampleEmail, planDemo, removeDemo, SAMPLE_REGISTRATIONS } from "@/db/demo-data";
import { describeReport } from "@/db/demo";
import { listUpcomingSessions } from "@/db/queries/public";
import { registrationPrice, registrationStatusAfterPayment } from "@/domain/registration";
import { seatState } from "@/domain/sessions";

// The removable sample data for the admin (src/db/demo-data.ts): a dry run writes nothing, apply inserts what is
// missing (twice = once), remove deletes exactly the sample rows.

const NOW = new Date();
const PLAN = demoPlan(seedBaseDate(SEEDED_AT)); // the seeded sessions, as the live database has them on its own dates

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  await applySeed(db);
});

const total = async (table: typeof registrations | typeof requests | typeof subscribers) => (await db.select({ n: count() }).from(table))[0].n;
const totals = async () => ({ registrations: await total(registrations), requests: await total(requests), subscribers: await total(subscribers) });

async function seatStates() {
  const rows = await listUpcomingSessions(db, NOW);
  return new Map(rows.map((s) => [`${s.course.slug} ${s.id}`, seatState(s, s.taken)]));
}

describe("sample data", () => {
  test("the live plan names the live database's first three sessions (seeded 1.10.2026)", () => {
    expect(DEMO_PLAN).toEqual({
      full: { course: "kulmumeistri-baaskoolitus", date: "2026-11-14" },
      few: { course: "lash-lift-botox", date: "2026-11-21" },
      other: { course: "kulmude-lami", date: "2026-11-28" },
      individual: ["kulmumeistri-baaskoolitus", "lash-lift-botox"],
      interest: "kulmumeistri-e-koolitus",
    });
  });

  test("a dry run counts and writes nothing", async () => {
    const before = await totals();
    const report = await planDemo(db, PLAN, NOW);
    expect(report.problems).toEqual([]);
    expect(report.inserted).toEqual({ registrations: 11, waitlist: 2, requests: 7, subscribers: 15 });
    expect(report.present).toEqual({ registrations: 0, requests: 0, subscribers: 0 });
    expect(report.sessions.full).toMatchObject({ course: "kulmumeistri-baaskoolitus", capacity: 4, before: "open", after: "full" });
    expect(report.sessions.few).toMatchObject({ course: "lash-lift-botox", capacity: 4, before: "open", after: "few" });
    expect(report.sessions.other).toMatchObject({ course: "kulmude-lami", before: "open", after: "open" });
    expect(await totals()).toEqual(before);
    // what the CLI prints: counts, slugs, dates and states, never a name or an address
    const printed = describeReport(report, "Dry run").join("\n");
    expect(printed).toContain("registrations 11, waitlist 2, requests 7, subscribers 15");
    expect(printed).not.toMatch(/@|näidis|Kask|Иванова/);
  });

  test("apply: the registrations, the waitlist, the requests and the subscribers, with the seat states", async () => {
    const statesBefore = await seatStates();
    const report = await applyDemo(db, PLAN, NOW);
    expect(report.inserted).toEqual({ registrations: 11, waitlist: 2, requests: 7, subscribers: 15 });

    // registrations: status and payment as the admin's payment form would set them, on the planned sessions
    const regs = await db.select({ r: registrations, c: courses, s: courseSessions }).from(registrations).innerJoin(courses, eq(registrations.courseId, courses.id)).innerJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id));
    expect(regs).toHaveLength(11);
    const byStatus = (status: string) => regs.filter((x) => x.r.status === status);
    expect(byStatus("awaiting_prepayment")).toHaveLength(4);
    expect(byStatus("cancelled")).toHaveLength(1);
    expect(byStatus("cancelled")[0].r.note).toMatch(/näidis/);
    const confirmed = byStatus("confirmed");
    expect(confirmed.filter((x) => x.r.paidCents === x.c.priceGroup)).toHaveLength(3);
    expect(confirmed.filter((x) => x.r.paidCents === Math.ceil(x.c.priceGroup! / 2))).toHaveLength(3);
    for (const { r, c } of regs) {
      if (r.status !== "cancelled") expect(r.status, r.email).toBe(registrationStatusAfterPayment(r, registrationPrice(c, "group")!));
      expect(r.kind).toBe("group");
      expect(isSampleEmail(r.email), r.email).toBe(true);
      expect(r.name).toMatch(/ \(näidis\)$/);
      expect(r.phone).toMatch(/^\+372 5000 00\d{2}$/);
      expect(NOW.getTime() - r.createdAt.getTime()).toBeLessThan(21 * 86_400_000);
      expect(r.createdAt.getTime()).toBeLessThan(NOW.getTime());
    }
    expect(regs.some((x) => x.r.locale === "ru")).toBe(true);

    // seat states: the first session full, the second with two places, every other session as it was
    const states = await seatStates();
    const [full, few, other] = [regs.find((x) => x.c.slug === "kulmumeistri-baaskoolitus")!.s, regs.find((x) => x.c.slug === "lash-lift-botox")!.s, regs.find((x) => x.c.slug === "kulmude-lami")!.s];
    expect(states.get(`kulmumeistri-baaskoolitus ${full.id}`)).toBe("full");
    expect(states.get(`lash-lift-botox ${few.id}`)).toBe("few");
    for (const [key, state] of statesBefore) if (!key.endsWith(` ${full.id}`) && !key.endsWith(` ${few.id}`)) expect(states.get(key), key).toBe(state);
    expect(other.id).not.toBe(full.id);

    // requests: 2 waitlist entries for the full session, 2 individual, 2 practice, 2 messages and 1 purchase interest
    const reqs = await db.select().from(requests);
    const kinds = (kind: string) => reqs.filter((r) => r.kind === kind);
    expect(kinds("waitlist").map((r) => r.payload.session)).toEqual([full.id, full.id]);
    expect(kinds("individual").map((r) => r.payload.course)).toEqual(["kulmumeistri-baaskoolitus", "lash-lift-botox"]);
    expect(kinds("individual").every((r) => typeof r.payload.preferredPeriod === "string" && typeof r.payload.message === "string")).toBe(true);
    expect(kinds("practice").map((r) => r.payload.package).sort()).toEqual(["MAXI", "MINI"]);
    expect(kinds("contact").filter((r) => r.payload.intent === "purchase").map((r) => r.payload.course)).toEqual(["kulmumeistri-e-koolitus"]);
    expect(kinds("contact")).toHaveLength(3);
    expect(reqs.filter((r) => r.handled)).toHaveLength(2);
    expect(reqs.every((r) => isSampleEmail(String(r.payload.email)))).toBe(true);

    // subscribers: 10 confirmed, 5 waiting, consents over the last three weeks
    const subs = await db.select().from(subscribers);
    expect(subs).toHaveLength(15);
    expect(subs.filter((s) => s.confirmedAt)).toHaveLength(10);
    for (const s of subs) {
      expect(NOW.getTime() - s.consentAt.getTime()).toBeLessThan(21 * 86_400_000);
      if (s.confirmedAt) expect(s.confirmedAt.getTime()).toBeGreaterThan(s.consentAt.getTime());
    }
  });

  test("apply twice adds nothing the second time", async () => {
    await applyDemo(db, PLAN, NOW);
    const once = await totals();
    const again = await applyDemo(db, PLAN, NOW);
    expect(again.inserted).toEqual({ registrations: 0, waitlist: 0, requests: 0, subscribers: 0 });
    expect(again.present).toEqual({ registrations: 11, requests: 9, subscribers: 15 });
    expect(await totals()).toEqual(once);
    expect(again.sessions.full).toMatchObject({ before: "full", after: "full" });
  });

  test("remove deletes exactly the sample rows; other rows, also at example.test, stay", async () => {
    const [session] = await db.select().from(courseSessions).limit(1);
    // a real-looking registration, request and subscriber (also at example.test, but without the sample marker)
    await db.insert(registrations).values({ courseId: session.courseId, courseSessionId: session.id, kind: "group", name: "Päris Inimene", email: "paris@example.test", paymentChoice: "full" });
    await db.insert(requests).values({ kind: "contact", payload: { name: "Päris", email: "paris@example.test", message: "x", locale: "et" } });
    await db.insert(subscribers).values({ email: "paris@example.test", token: "t".repeat(43) });
    const statesBefore = await seatStates();
    await applyDemo(db, PLAN, NOW);
    expect(await removeDemo(db)).toEqual({ registrations: 11, waitlist: 2, requests: 7, subscribers: 15 });
    expect(await totals()).toEqual({ registrations: 1, requests: 1, subscribers: 1 });
    expect(await seatStates()).toEqual(statesBefore);
    expect(await removeDemo(db)).toEqual({ registrations: 0, waitlist: 0, requests: 0, subscribers: 0 });
  });

  test("a plan that does not fit is refused and nothing is written", async () => {
    const before = await totals();
    // another date
    const report = await planDemo(db, { ...PLAN, full: { ...PLAN.full, date: "2020-01-04" } }, NOW);
    expect(report.problems).toEqual([expect.stringContaining("0 sessions on that date")]);
    await expect(applyDemo(db, { ...PLAN, full: { ...PLAN.full, date: "2020-01-04" } }, NOW)).rejects.toThrow(/does not fit/);
    // a real confirmed registration on the session to be made full: the samples would overfill it
    const [{ s }] = await db.select({ s: courseSessions }).from(courseSessions).innerJoin(courses, eq(courseSessions.courseId, courses.id)).where(eq(courses.slug, PLAN.full.course)).orderBy(courseSessions.startsAt).limit(1);
    await db.insert(registrations).values({ courseId: s.courseId, courseSessionId: s.id, kind: "group", name: "Päris", email: "paris@example.test", paymentChoice: "full", status: "confirmed" });
    await expect(applyDemo(db, PLAN, NOW)).rejects.toThrow(/would have 5 seats taken of 4 places/);
    expect(await totals()).toEqual({ ...before, registrations: before.registrations + 1 });
  });

  test("a live seat hold counts as a taken seat in the plan (phase 2b), an ended one does not", async () => {
    const [{ s }] = await db.select({ s: courseSessions }).from(courseSessions).innerJoin(courses, eq(courseSessions.courseId, courses.id)).where(eq(courses.slug, PLAN.full.course)).orderBy(courseSessions.startsAt).limit(1);
    const hold = (n: string, until: Date) => ({ courseId: s.courseId, courseSessionId: s.id, kind: "group" as const, name: n, email: `${n}@example.test`, paymentChoice: "half" as const, status: "awaiting_prepayment" as const, seatHoldUntil: until });
    // two holds that ended: nobody's seat
    await db.insert(registrations).values([hold("a", new Date(NOW.getTime() - 60_000)), hold("b", new Date(NOW.getTime() - 60_000))]);
    expect(await planDemo(db, PLAN, NOW)).toMatchObject({ problems: [], sessions: { full: { before: "open", after: "full" } } });
    // two holds that are live: two of the four places are taken, so the four sample confirmations would overfill it
    await db.insert(registrations).values([hold("c", new Date(NOW.getTime() + 600_000)), hold("d", new Date(NOW.getTime() + 600_000))]);
    const report = await planDemo(db, PLAN, NOW);
    expect(report.sessions.full).toMatchObject({ before: "few", after: "full" });
    expect(report.problems).toEqual([expect.stringMatching(/would have 6 seats taken of 4 places/)]);
    await expect(applyDemo(db, PLAN, NOW)).rejects.toThrow(/would have 6 seats taken of 4 places/);
  });

  test("the samples are all made up: example.test addresses with the marker, names marked (näidis)", () => {
    for (const r of SAMPLE_REGISTRATIONS) {
      expect(r.email).toMatch(/^[a-z.]+\.naidis@example\.test$/);
      expect(r.name).toMatch(/\(näidis\)$/);
    }
  });
});

import { expect, test } from "vitest";
import type { Db } from "@/db/client";
import { listAdminSessions } from "@/db/queries/admin";
import { getCourseBySlug, listUpcomingSessions } from "@/db/queries/public";
import { hasFreeSeat, seatsTaken } from "@/db/queries/seats";
import { courses, courseSessions, registrations } from "@/db/schema";
import { holdsSeat } from "@/domain/sessions";
import type { Env } from "@/server/notify";
import { handleRegistration, type Deps } from "@/server/submit";
import { fakeKv } from "../fakes";
import { makeTestDb } from "./helpers";

// One seat count (phase 2b, spec 5.3, D2): a registration takes a seat when it is confirmed, or awaiting its prepayment with a hold that has
// not ended. The registration form's full check, the public calendar and course page, and the admin's calendar count with it.

const MIN = 60_000;
const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };

/** A published contact course with one session of `capacity`, starting in 30 days from the real clock (the public queries read it). */
async function course(db: Db, capacity: number) {
  const [c] = await db.insert(courses).values({ ...base, slug: "kulmud", type: "contact", title: { et: "Kulmud" }, published: true, priceGroup: 35000 }).returning();
  const [s] = await db.insert(courseSessions).values({ courseId: c.id, startsAt: new Date(Date.now() + 30 * 86_400_000), city: "Pärnu", capacity }).returning();
  return { c, s };
}

const reg = (courseId: number, sessionId: number, n: string, status: "confirmed" | "awaiting_prepayment" | "cancelled", seatHoldUntil: Date | null = null) => ({
  courseId,
  courseSessionId: sessionId,
  kind: "group" as const,
  name: n,
  email: `${n}@example.test`,
  paymentChoice: "half" as const,
  status,
  seatHoldUntil,
});

test("seatsTaken counts confirmed and live holds; an ended hold, no hold and cancelled do not; `except` leaves one row out", async () => {
  const db = await makeTestDb();
  const { c, s } = await course(db, 4);
  const now = new Date("2026-10-09T10:00:00Z");
  const rows = await db
    .insert(registrations)
    .values([
      reg(c.id, s.id, "a", "confirmed"),
      reg(c.id, s.id, "b", "awaiting_prepayment", new Date(now.getTime() + 10 * MIN)),
      reg(c.id, s.id, "c", "awaiting_prepayment", new Date(now.getTime() - MIN)),
      reg(c.id, s.id, "d", "awaiting_prepayment"),
      reg(c.id, s.id, "e", "cancelled", new Date(now.getTime() + 10 * MIN)),
    ])
    .returning();
  expect((await seatsTaken(db, [s.id], now)).get(s.id)).toBe(2);
  // the SQL and the pure rule agree, row by row
  expect(rows.filter((r) => holdsSeat(r, now)).map((r) => r.name)).toEqual(["a", "b"]);
  // 11 minutes later b's hold has ended too
  expect((await seatsTaken(db, [s.id], new Date(now.getTime() + 11 * MIN))).get(s.id)).toBe(1);
  expect((await seatsTaken(db, [s.id], now, { except: rows[1].id })).get(s.id)).toBe(1);
  expect(await seatsTaken(db, [], now)).toEqual(new Map());
  expect(await hasFreeSeat(db, s, now)).toBe(true);
  expect(await hasFreeSeat(db, { id: s.id, capacity: 2 }, now)).toBe(false);
  expect(await hasFreeSeat(db, { id: s.id, capacity: 2 }, now, rows[1].id)).toBe(true); // her own hold is not in her way
});

test("the public calendar and course page, and the admin's calendar, count a live hold as taken", async () => {
  const db = await makeTestDb();
  const { c, s } = await course(db, 4);
  await db.insert(registrations).values([reg(c.id, s.id, "a", "confirmed"), reg(c.id, s.id, "b", "awaiting_prepayment", new Date(Date.now() + 10 * MIN)), reg(c.id, s.id, "c", "awaiting_prepayment")]);
  expect((await getCourseBySlug(db, "kulmud"))!.sessions[0].taken).toBe(2);
  expect((await listUpcomingSessions(db, new Date()))[0].taken).toBe(2);
  const [admin] = await listAdminSessions(db, { ids: [s.id] });
  expect([admin.confirmed, admin.awaiting, admin.taken]).toEqual([1, 2, 2]);
  // an hour later the hold has ended
  const [later] = await listAdminSessions(db, { ids: [s.id] }, new Date(Date.now() + 60 * MIN));
  expect(later.taken).toBe(1);
});

test("the registration form's full check counts a live hold: the last seat is taken until the hold ends", async () => {
  const db = await makeTestDb();
  const { c, s } = await course(db, 1);
  const now = new Date();
  await db.insert(registrations).values(reg(c.id, s.id, "a", "awaiting_prepayment", new Date(now.getTime() + 10 * MIN)));
  const env: Env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: "https://mslab.example" };
  const deps = (at: Date): Deps => ({ db, env, ip: "203.0.113.5", siteUrl: "https://mslab.example", now: at, later: () => {} });
  const form = () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ course: "kulmud", session: String(s.id), name: "Kati", email: "kati@example.test", phone: "+372 5555 5555", payment: "half", terms: "on", locale: "et" })) fd.set(k, v);
    return fd;
  };
  expect(await handleRegistration(deps(now), form())).toEqual({ ok: false, errors: { session: "full" } });
  expect(await handleRegistration(deps(new Date(now.getTime() + 11 * MIN)), form())).toEqual({ ok: true });
});

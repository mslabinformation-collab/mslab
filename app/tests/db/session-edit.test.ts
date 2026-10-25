import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { countSessionRegistrations } from "@/db/queries/admin";
import * as schema from "@/db/schema";
import { courses, courseSessions, registrations } from "@/db/schema";
import { createSession as signInSession } from "@/server/auth";
import type { Env } from "@/server/notify";
import { handleRegistration, type Deps } from "@/server/submit";
import { fakeKv } from "../fakes";
import { makeTestDb, shownContractVersion } from "./helpers";

// A calendar session's server side (admin UX pass piece 3b, Task 2; README B3; rulings R-a, R-b, R-c): the drawer's fields autosave on
// POST /api/admin/toimumine/<id> (server/autosave-route.ts' contract around server/session-edit.ts writeSession), „Lisa toimumine“ stays an explicit
// create (createSession) and the status changes with its own instant action (setSessionStatus, a ConfirmPanel in the drawer). The version is R-a's:
// "s:" and the hash of the stored {courseId, startsAt, city, venue, language, capacity, status}. Every write takes the session's lock first, as the
// public registration does (db/queries/seats.ts lockSession), so „Kohti“ below the confirmed (R-c) and „Koolitus“ once anyone is booked (R-b) are
// refused on the server against the registrations as they are. On PGlite; the public pages' revalidation is a spy; the admin's cookie is faked for
// the route.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);

import { POST as saveRoute } from "@/app/api/admin/toimumine/[id]/route";
import { createSession, readSession, setSessionStatus, writeSession } from "@/server/session-edit";
import { deleteSessionForm } from "@/server/admin-content";
import { readCoursePart, writeCoursePart } from "@/server/course-parts";

const MARIA = { email: "maria@example.test" };
const NOW = new Date("2026-10-24T09:00:00Z");
const ORIGIN = "https://mslab.example";
const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };

let db: Db;
/** Two published contact courses (the session's and another) and an e-course. */
let lami: { id: number; slug: string };
let lift: { id: number };
let online: { id: number };
/** The session: Kulmude LAMI, Saturday 14.11.2026 10:00 in Pärnu, 6 seats. */
let session: { id: number };

async function fixtures(d: Db) {
  [lami] = await d
    .insert(courses)
    .values({ ...base, slug: "kulmude-lami", type: "contact", title: { et: "Kulmude LAMI" }, priceGroup: 22000, published: true, sort: 1 })
    .returning();
  [lift] = await d.insert(courses).values({ ...base, slug: "ripsmete-lift", type: "contact", title: { et: "Ripsmete lift" }, priceGroup: 19000, published: true, sort: 2 }).returning();
  [online] = await d.insert(courses).values({ ...base, slug: "e-kulm", type: "e_learning", title: { et: "E-kulm" }, price: 9500, published: true, sort: 3 }).returning();
  [session] = await d
    .insert(courseSessions)
    .values({ courseId: lami.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio", language: "ET", capacity: 6 })
    .returning();
}

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.cookie = undefined;
  await fixtures(db);
  pub.revalidatePublic.mockReset();
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Status = "confirmed" | "awaiting_prepayment" | "cancelled";
/** Registrations of the session, `n` of each status asked for. */
async function book(counts: Partial<Record<Status, number>>, sessionId = session.id, courseId = lami.id) {
  let i = 0;
  for (const [status, n] of Object.entries(counts) as [Status, number][])
    for (let k = 0; k < n; k++) {
      i++;
      await db
        .insert(registrations)
        .values({ courseId, courseSessionId: sessionId, kind: "group", name: `Õpilane ${status} ${k}`, email: `opilane-${status}-${k}-${i}@example.test`, paymentChoice: "half", status });
    }
}

const row = async (id = session.id) => (await db.select().from(courseSessions).where(eq(courseSessions.id, id)))[0];
const versionNow = async (id = session.id) => (await readSession(db, id))!.version;
const write = async (patch: Record<string, unknown>, version?: string) => writeSession(db, session.id, patch, version ?? (await versionNow()), MARIA, NOW);

describe("readSession and the version (R-a)", () => {
  test("the drawer's fields as typed (Estonian date and time, the seats as text) with the status; null for no such session", async () => {
    const read = (await readSession(db, session.id))!;
    expect(read.version).toMatch(/^s:[0-9a-f]{32}$/);
    expect(read.value).toEqual({ courseId: lami.id, date: "2026-11-14", time: "10:00", city: "Pärnu", venue: "MS LAB stuudio", language: "ET", capacity: "6", status: "scheduled" });
    expect(await readSession(db, 999_999)).toBeNull();
  });

  test("the version moves with each of the course, the start, the city, the venue, the language, the seats and the status, and with nothing else", async () => {
    const seen = new Set([await versionNow()]);
    const changes: Partial<typeof courseSessions.$inferInsert>[] = [
      { courseId: lift.id },
      { startsAt: new Date("2026-11-14T08:30:00Z") },
      { city: "Tartu" },
      { venue: "Uus stuudio" },
      { language: "RU" },
      { capacity: 5 },
      { status: "cancelled" },
    ];
    for (const change of changes) {
      await db.update(courseSessions).set(change).where(eq(courseSessions.id, session.id));
      const v = await versionNow();
      expect(seen.has(v), JSON.stringify(change)).toBe(false);
      seen.add(v);
    }
    // a registration is not the session's content
    const before = await versionNow();
    await book({ confirmed: 1, awaiting_prepayment: 1 });
    expect(await versionNow()).toBe(before);
  });
});

describe("writeSession: the drawer's autosave", () => {
  test("a date change writes and revalidates the public pages once", async () => {
    const answer = await write({ date: "2026-11-21" });
    expect(answer).toEqual({ ok: true, version: await versionNow(), savedAt: NOW.toISOString() });
    expect((await row()).startsAt.toISOString()).toBe("2026-11-21T08:00:00.000Z");
    expect(pub.revalidatePublic.mock.calls).toEqual([[{ kind: "sessions" }]]);
    // and the other fields, trimmed as the old form stored them; the summer time is the right instant
    const next = await write({ time: "09:30", city: " Tartu ", venue: " Kesklinn ", language: "ET / RU", capacity: "8", date: "2027-06-05" });
    expect(next).toMatchObject({ ok: true });
    expect(await row()).toMatchObject({ city: "Tartu", venue: "Kesklinn", language: "ET / RU", capacity: 8, status: "scheduled", courseId: lami.id });
    expect((await row()).startsAt.toISOString()).toBe("2027-06-05T06:30:00.000Z");
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(2);
  });

  test("capacity 3 with 4 confirmed is refused capacityBelow and nothing is written (R-c: the confirmed only)", async () => {
    await book({ confirmed: 4, awaiting_prepayment: 1, cancelled: 2 });
    const before = await row();
    const version = await versionNow();
    expect(await write({ capacity: "3" }, version)).toEqual({ ok: false, error: "invalid", fields: { capacity: "capacityBelow" } });
    expect(await row()).toEqual(before);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    // as many seats as confirmed is fine (the awaiting one and the cancelled ones do not count, R-c)
    expect(await write({ capacity: "4" }, version)).toMatchObject({ ok: true });
    expect((await row()).capacity).toBe(4);
  });

  test("a session over its capacity (a confirmation by hand, db/queries/seats.ts) still saves its other fields: the rule looks at a changed „Kohti“ only", async () => {
    await db.update(courseSessions).set({ capacity: 3 }).where(eq(courseSessions.id, session.id));
    await book({ confirmed: 4 });
    expect(await write({ venue: "Teine saal" })).toMatchObject({ ok: true });
    expect(await write({ capacity: "2" })).toEqual({ ok: false, error: "invalid", fields: { capacity: "capacityBelow" } });
    expect(await write({ capacity: "4" })).toMatchObject({ ok: true });
  });

  test("a course change with one awaiting registration is refused courseLocked; with cancelled ones only it is made (R-b)", async () => {
    await book({ awaiting_prepayment: 1 });
    const before = await row();
    expect(await write({ courseId: lift.id })).toEqual({ ok: false, error: "invalid", fields: { courseId: "courseLocked" } });
    expect(await row()).toEqual(before);
    // the other fields still save, and naming the same course is no change
    expect(await write({ city: "Tallinn", courseId: lami.id })).toMatchObject({ ok: true });
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    // a confirmed one locks it too
    await db.update(registrations).set({ status: "confirmed" });
    expect(await write({ courseId: lift.id })).toEqual({ ok: false, error: "invalid", fields: { courseId: "courseLocked" } });
    // cancelled only: the rows stay as history, the course may change
    await db.update(registrations).set({ status: "cancelled" });
    expect(await write({ courseId: lift.id })).toMatchObject({ ok: true });
    expect((await row()).courseId).toBe(lift.id);
  });

  test("a stale version is a conflict with what is stored; nothing is written. A session deleted meanwhile: version \"\", value null", async () => {
    const first = await versionNow();
    const saved = await write({ city: "Tartu" }, first);
    expect(saved).toMatchObject({ ok: true });
    const stored = (await readSession(db, session.id))!;
    expect(await write({ city: "Viljandi" }, first)).toEqual({ ok: false, error: "conflict", version: stored.version, value: stored.value });
    expect((await row()).city).toBe("Tartu");
    // a status changed in another tab moves the version too (R-a)
    expect(await setSessionStatus(db, session.id, "cancelled", stored.version)).toMatchObject({ ok: true });
    expect(await write({ city: "Viljandi" }, stored.version)).toMatchObject({ ok: false, error: "conflict", value: { status: "cancelled", city: "Tartu" } });
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(2);
    await db.delete(courseSessions).where(eq(courseSessions.id, session.id));
    expect(await writeSession(db, session.id, { city: "X" }, stored.version, MARIA, NOW)).toEqual({ ok: false, error: "conflict", version: "", value: null });
  });

  test("each field's own check, by field code; several at once are each named; nothing is written", async () => {
    const before = await row();
    const cases: [Record<string, unknown>, Record<string, string>][] = [
      [{ city: "" }, { city: "required" }],
      [{ city: "   " }, { city: "required" }],
      [{ city: "P".repeat(61) }, { city: "tooLong" }],
      [{ venue: "V".repeat(121) }, { venue: "tooLong" }],
      [{ date: "" }, { date: "required" }],
      [{ date: "2026-02-30" }, { date: "date" }],
      [{ time: "" }, { time: "required" }],
      [{ time: "25:00" }, { time: "time" }],
      [{ capacity: "0" }, { capacity: "capacity" }],
      [{ capacity: "100" }, { capacity: "capacity" }],
      [{ capacity: "4,5" }, { capacity: "capacity" }],
      [{ capacity: "" }, { capacity: "capacity" }],
      [{ language: "DE" }, { language: "required" }],
      [{ courseId: online.id }, { courseId: "course" }], // an e-course has no dates
      [{ courseId: 999_999 }, { courseId: "course" }],
      [{ city: "", capacity: "0", date: "x" }, { city: "required", capacity: "capacity", date: "date" }],
    ];
    for (const [patch, fields] of cases) expect(await write(patch), JSON.stringify(patch)).toEqual({ ok: false, error: "invalid", fields });
    expect(await row()).toEqual(before);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("a session row under an e-course (one an older editor let in) saves nothing until it is under a contact course; the fields sent are named with it", async () => {
    await db.update(courseSessions).set({ courseId: online.id }).where(eq(courseSessions.id, session.id));
    const before = await row();
    expect(await write({ capacity: "3", city: "Tartu" })).toEqual({ ok: false, error: "invalid", fields: { courseId: "course", capacity: "course", city: "course" } });
    expect(await row()).toEqual(before);
    expect(await write({ courseId: lift.id, capacity: "3" })).toMatchObject({ ok: true });
    expect(await row()).toMatchObject({ courseId: lift.id, capacity: 3 });
  });

  test("a save that changes nothing answers the version it came from and writes nothing; a field that is not the drawer's is not read", async () => {
    const version = await versionNow();
    expect(await write({ city: "Pärnu", capacity: "6", date: "2026-11-14" }, version)).toEqual({ ok: true, version, savedAt: NOW.toISOString() });
    expect(await write({ city: " Pärnu " }, version)).toEqual({ ok: true, version, savedAt: NOW.toISOString() });
    // the status has its own action (the route's schema refuses it; the write does not read it)
    expect(await write({ status: "cancelled" } as Record<string, unknown>, version)).toEqual({ ok: true, version, savedAt: NOW.toISOString() });
    expect((await row()).status).toBe("scheduled");
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });
});

describe("createSession: „Lisa toimumine“ stays an explicit create", () => {
  const input = (over: Record<string, unknown> = {}) => ({ courseId: lift.id, date: "2026-12-05", time: "10:00", city: "Tallinn", venue: "", language: "ET", capacity: "4", ...over });

  test("creates a scheduled session and answers its id and version (the drawer goes on at ?id=<n> and autosaves); revalidated once", async () => {
    const answer = await createSession(db, input({ city: " Tallinn ", venue: " Kesklinn " }), NOW);
    expect(answer).toMatchObject({ ok: true, id: expect.any(Number) });
    const id = (answer as { id: number }).id;
    expect(answer).toEqual({ ok: true, id, version: (await readSession(db, id))!.version, savedAt: NOW.toISOString() });
    expect(await row(id)).toMatchObject({ courseId: lift.id, city: "Tallinn", venue: "Kesklinn", language: "ET", capacity: 4, status: "scheduled" });
    expect((await row(id)).startsAt.toISOString()).toBe("2026-12-05T08:00:00.000Z");
    expect(pub.revalidatePublic.mock.calls).toEqual([[{ kind: "sessions" }]]);
  });

  test("the required fields (S3-P3-g: Koolitus, Kuupäev, Linn) and every field's check; nothing is created", async () => {
    const count = async () => (await db.select().from(courseSessions)).length;
    const before = await count();
    expect(await createSession(db, input({ courseId: null, date: "", city: "" }), NOW)).toEqual({ ok: false, error: "invalid", fields: { courseId: "course", date: "required", city: "required" } });
    expect(await createSession(db, input({ courseId: online.id, time: "7", capacity: "0", language: "DE" }), NOW)).toEqual({
      ok: false,
      error: "invalid",
      fields: { courseId: "course", time: "time", capacity: "capacity", language: "required" },
    });
    expect(await createSession(db, input({ status: "cancelled" }), NOW)).toMatchObject({ ok: false, error: "invalid" });
    expect(await createSession(db, "x", NOW)).toMatchObject({ ok: false, error: "invalid" });
    expect(await count()).toBe(before);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });
});

describe("setSessionStatus: „Tühistatud“ / „Toimub“, instant", () => {
  test("cancels from the version it was shown, the registrations stay; back to „Toimub“ the same way; revalidated once each", async () => {
    await book({ confirmed: 2, awaiting_prepayment: 1 });
    const cancelled = await setSessionStatus(db, session.id, "cancelled", await versionNow());
    expect(cancelled).toEqual({ ok: true, version: await versionNow() });
    expect((await row()).status).toBe("cancelled");
    expect(await countSessionRegistrations(db, session.id)).toEqual({ confirmed: 2, booked: 3, all: 3 });
    expect(await setSessionStatus(db, session.id, "scheduled", (cancelled as { version: string }).version)).toMatchObject({ ok: true });
    expect((await row()).status).toBe("scheduled");
    expect(pub.revalidatePublic.mock.calls).toEqual([[{ kind: "sessions" }], [{ kind: "sessions" }]]);
  });

  test("a stale version is a conflict with what is stored; the same status writes nothing; no such session: notFound", async () => {
    const shown = await versionNow();
    await write({ city: "Tartu" }, shown);
    pub.revalidatePublic.mockReset();
    const stored = (await readSession(db, session.id))!;
    expect(await setSessionStatus(db, session.id, "cancelled", shown)).toEqual({ ok: false, error: "conflict", version: stored.version, value: stored.value });
    expect((await row()).status).toBe("scheduled");
    expect(await setSessionStatus(db, session.id, "scheduled", stored.version)).toEqual({ ok: true, version: stored.version });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(await setSessionStatus(db, 999_999, "cancelled", stored.version)).toEqual({ ok: false, error: "notFound" });
  });
});

describe("the counts the drawer and the rules use (R-b), and „Kustuta toimumine“", () => {
  test("countSessionRegistrations: the confirmed, the booked (not cancelled: confirmed and awaiting) and all of them", async () => {
    expect(await countSessionRegistrations(db, session.id)).toEqual({ confirmed: 0, booked: 0, all: 0 });
    await book({ confirmed: 2, awaiting_prepayment: 1, cancelled: 3 });
    expect(await countSessionRegistrations(db, session.id)).toEqual({ confirmed: 2, booked: 3, all: 6 });
    expect(await countSessionRegistrations(db, 999_999)).toEqual({ confirmed: 0, booked: 0, all: 0 });
  });

  test("a cancelled-only session still refuses delete: its registrations stay as history", async () => {
    await book({ cancelled: 1 });
    expect(await countSessionRegistrations(db, session.id)).toEqual({ confirmed: 0, booked: 0, all: 1 });
    const fd = new FormData();
    fd.set("id", String(session.id));
    expect(await deleteSessionForm(db, fd)).toEqual({ ok: false, error: "inUse" });
    expect(await row()).toBeDefined();
  });
});

describe("the session's lock (R-a, R-c): the same lock as the public registration, first", () => {
  /** A fresh migrated database that records every query it runs (drizzle's logger), with the fixtures; it replaces `db`. */
  async function useLoggedDb(): Promise<string[]> {
    const log: string[] = [];
    const logged: Db = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string) => void log.push(query) } });
    await migrate(logged, { migrationsFolder: "./drizzle" });
    db = logged;
    await fixtures(db);
    log.length = 0;
    return log;
  }
  const LOCK = /^select 1 from course_sessions where id = \$1 for update$/;
  const env: Env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: ORIGIN };
  const deps = (): Deps => ({ db, env, ip: "203.0.113.5", siteUrl: ORIGIN, now: NOW, later: () => {} });
  const registration = async (email: string) => {
    const fd = new FormData();
    const fields = { course: lami.slug, session: String(session.id), name: "Kati", email, phone: "+372 5555 5555", payment: "half", terms: "on", locale: "et", contractVersion: await shownContractVersion(db) };
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };

  test("writeSession and setSessionStatus take the session's lock as their first statement, before the counts and the write; the registration takes the same one before its insert", async () => {
    const log = await useLoggedDb();
    await book({ confirmed: 1 });
    let version = await versionNow();
    log.length = 0;
    expect(await write({ capacity: "2" }, version)).toMatchObject({ ok: true });
    expect(log[0]).toMatch(LOCK);
    const counted = log.findIndex((q) => /from "registrations"/.test(q));
    const updated = log.findIndex((q) => /^update "course_sessions"/.test(q));
    expect([counted > 0, updated > counted]).toEqual([true, true]);

    version = await versionNow();
    log.length = 0;
    expect(await setSessionStatus(db, session.id, "cancelled", version)).toMatchObject({ ok: true });
    expect(log[0]).toMatch(LOCK);
    expect(log.findIndex((q) => /^update "course_sessions"/.test(q))).toBeGreaterThan(0);
    await db.update(courseSessions).set({ status: "scheduled" }).where(eq(courseSessions.id, session.id));

    const form = await registration("kati@example.test");
    log.length = 0;
    expect(await handleRegistration(deps(), form)).toEqual({ ok: true });
    const lock = log.findIndex((q) => LOCK.test(q));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(log.findIndex((q) => /^insert into "registrations"/.test(q))).toBeGreaterThan(lock);
  });

  test("a public registration and a capacity save at the same moment serialise on the lock: never one inside the other, and either order leaves a consistent session", async () => {
    const log = await useLoggedDb();
    await db.update(courseSessions).set({ capacity: 2 }).where(eq(courseSessions.id, session.id));
    await book({ confirmed: 1 });
    const version = await versionNow();
    const form = await registration("teine@example.test");
    log.length = 0;
    const [registered, saved] = await Promise.all([handleRegistration(deps(), form), writeSession(db, session.id, { capacity: "1" }, version, MARIA, NOW)]);
    // the save is allowed either way (R-c counts the confirmed only); the registration finds the last seat free, or none once the capacity is 1
    expect(saved).toMatchObject({ ok: true });
    expect((await row()).capacity).toBe(1);
    const stored = (await db.select().from(registrations).where(eq(registrations.email, "teine@example.test"))).length;
    expect(registered).toEqual(stored === 1 ? { ok: true } : { ok: false, errors: { session: "full" } });
    // the save's statements run between its lock and its write with nothing of the registration's in between
    const updated = log.findIndex((q) => /^update "course_sessions"/.test(q));
    const ownLock = log.slice(0, updated).findLastIndex((q) => LOCK.test(q));
    expect(ownLock).toBeGreaterThanOrEqual(0);
    expect(log.slice(ownLock + 1, updated).filter((q) => LOCK.test(q) || /^insert into "registrations"/.test(q))).toEqual([]);
    expect(log.filter((q) => LOCK.test(q))).toHaveLength(2);
  });

  // piece 3b Task 3 (carry): a course's type changes under its own row lock (server/course-parts.ts writeCoursePart → lockCourse, FOR UPDATE, then
  // typeLocked counts its sessions). The session's new course is read FOR SHARE under the session's lock — the registration's order, the session and
  // then the course — so a type change waits for the move to commit (and then counts the moved session), or the move waits for the type change (and
  // then reads the new type): never a session under an e-course.
  const COURSE_SHARE = /^select "type" from "courses" where "courses"\."id" = \$1 for share$/;

  test("writeSession: a course change reads the new course's type FOR SHARE after the session's lock and before the write", async () => {
    const log = await useLoggedDb();
    const version = await versionNow();
    log.length = 0;
    expect(await write({ courseId: lift.id }, version)).toMatchObject({ ok: true });
    expect(log[0]).toMatch(LOCK);
    const share = log.findIndex((q) => COURSE_SHARE.test(q));
    const updated = log.findIndex((q) => /^update "course_sessions"/.test(q));
    expect(share, log.join("\n")).toBeGreaterThan(0);
    expect(updated).toBeGreaterThan(share);
  });

  test("createSession: the course is read FOR SHARE in the same transaction as the insert", async () => {
    const log = await useLoggedDb();
    log.length = 0;
    // (PGlite opens its transactions itself: drizzle's log has no BEGIN, so the transaction is the one db.transaction call)
    const transaction = vi.spyOn(db, "transaction");
    const input = { courseId: lift.id, date: "2027-06-05", time: "10:00", city: "Tartu", venue: "", language: "ET", capacity: "4" };
    const created = await createSession(db, input, NOW);
    expect(created).toMatchObject({ ok: true });
    expect(transaction).toHaveBeenCalledOnce();
    // the summer time is the right instant
    expect((await row((created as { id: number }).id)).startsAt.toISOString()).toBe("2027-06-05T07:00:00.000Z");
    const share = log.findIndex((q) => COURSE_SHARE.test(q));
    const inserted = log.findIndex((q) => /^insert into "course_sessions"/.test(q));
    expect(share, log.join("\n")).toBeGreaterThanOrEqual(0);
    expect(inserted).toBeGreaterThan(share);
  });

  test("a course's type change and a session moved onto that course at the same moment: either one wins, never a session under an e-course", async () => {
    const [spare] = await db.insert(courses).values({ ...base, slug: "varu", type: "contact", title: { et: "Varu" }, published: false, sort: 4 }).returning();
    const version = await versionNow();
    const basics = (await readCoursePart(db, spare.id, "basics"))!;
    const [moved, typed] = await Promise.all([
      writeSession(db, session.id, { courseId: spare.id }, version, MARIA, NOW),
      writeCoursePart(db, spare.id, "basics", { type: "e_learning" }, basics.version, MARIA, NOW),
    ]);
    const [course] = await db.select().from(courses).where(eq(courses.id, spare.id));
    if (moved.ok) {
      expect((await row()).courseId).toBe(spare.id);
      expect(typed).toEqual({ ok: false, error: "invalid", fields: { type: "typeLocked" } });
      expect(course.type).toBe("contact");
    } else {
      expect(moved).toEqual({ ok: false, error: "invalid", fields: { courseId: "course" } });
      expect(course.type).toBe("e_learning");
      expect((await row()).courseId).toBe(lami.id);
    }
    // and each way round, one after the other
    await db.update(courses).set({ type: "contact" }).where(eq(courses.id, spare.id));
    await db.update(courseSessions).set({ courseId: lami.id }).where(eq(courseSessions.id, session.id));
    const first = (await readCoursePart(db, spare.id, "basics"))!;
    expect(await writeCoursePart(db, spare.id, "basics", { type: "e_learning" }, first.version, MARIA, NOW)).toMatchObject({ ok: true });
    expect(await write({ courseId: spare.id })).toEqual({ ok: false, error: "invalid", fields: { courseId: "course" } });
    await db.update(courses).set({ type: "contact" }).where(eq(courses.id, spare.id));
    expect(await write({ courseId: spare.id })).toMatchObject({ ok: true });
    const again = (await readCoursePart(db, spare.id, "basics"))!;
    expect(await writeCoursePart(db, spare.id, "basics", { type: "e_learning" }, again.version, MARIA, NOW)).toEqual({ ok: false, error: "invalid", fields: { type: "typeLocked" } });
  });
});

describe("POST /api/admin/toimumine/<id>", () => {
  const post = (id: string | number, body: unknown, headers: Record<string, string> = {}) =>
    saveRoute(new Request(`${ORIGIN}/api/admin/toimumine/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ id: String(id) }),
    });
  const answerOf = async (res: Response) => ({ status: res.status, cache: res.headers.get("cache-control"), body: await res.json() });
  const signIn = async () => {
    state.cookie = await signInSession(db, "admin@example.test");
  };

  test("without an admin's session: 401; from another site: 403; nothing stored", async () => {
    const version = await versionNow();
    expect((await post(session.id, { version, patch: { city: "Tartu" } })).status).toBe(401);
    await signIn();
    expect((await post(session.id, { version, patch: { city: "Tartu" } }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await row()).city).toBe("Pärnu");
  });

  test("the contract: 200 with the new version, 409 with the stored fields, 400 per field (the rules' codes too), 404 for no such session", async () => {
    await signIn();
    const version = await versionNow();
    const saved = await answerOf(await post(session.id, { version, patch: { venue: "Uus saal" } }));
    expect(saved).toEqual({ status: 200, cache: "no-store", body: { ok: true, version: await versionNow(), savedAt: expect.any(String) } });
    const stored = (await readSession(db, session.id))!;
    expect(await answerOf(await post(session.id, { version, patch: { venue: "Teine" } }))).toEqual({
      status: 409,
      cache: "no-store",
      body: { ok: false, error: "conflict", version: stored.version, value: stored.value },
    });
    await book({ confirmed: 3, awaiting_prepayment: 1 });
    expect(await answerOf(await post(session.id, { version: stored.version, patch: { capacity: "2", courseId: lift.id } }))).toMatchObject({
      status: 400,
      body: { ok: false, error: "invalid", fields: { capacity: "capacityBelow", courseId: "courseLocked" } },
    });
    // the patch's shape: the status is not one of the drawer's autosaved fields (its own action), a course id is a number
    expect(await answerOf(await post(session.id, { version: stored.version, patch: { status: "cancelled" } }))).toMatchObject({ status: 400, body: { error: "invalid", fields: { status: "invalid" } } });
    expect(await answerOf(await post(session.id, { version: stored.version, patch: { courseId: String(lift.id) } }))).toMatchObject({ status: 400, body: { error: "invalid", fields: { courseId: "course" } } });
    expect(await answerOf(await post(session.id, { version: stored.version, patch: { city: "P".repeat(3000) } }))).toMatchObject({ status: 400, body: { error: "invalid", fields: { city: "tooLong" } } });
    expect(await row()).toMatchObject({ venue: "Uus saal", capacity: 6, courseId: lami.id, status: "scheduled" });
    for (const id of ["999999", "x", "0"]) expect((await post(id, { version, patch: {} })).status, id).toBe(404);
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
  });
});

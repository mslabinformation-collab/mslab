import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseAccess, courses, discountCodeCourses, discountCodes, discountRedemptions, type Course, type CourseSession, type DiscountCode } from "@/db/schema";
import { tallinnToday } from "@/domain/client-access";
import { discountGiven, emptyCodeFields, type CodeFields } from "@/domain/discount-code-fields";
import { personRefusal } from "@/domain/discount-codes";
import { createSession as signInSession } from "@/server/auth";
import { findCode, insertRedemption, personFacts, ruleOf } from "@/server/discount-codes";
import { clientWithAccess, contactCourse, ecourseCourse, ecoursePayment, registrationOn } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// The Sooduskoodid page's server side (F1 Task 13; spec §4.10; R9, R16–R20): the list, the autosaved drawer (POST /api/admin/sooduskood/<id>,
// server/autosave-route.ts' contract around writeCode), „Lisa sooduskood“ (createCode), the instant switch (setCodeActive), the delete (deleteCode) and
// the code's uses (codeUses). On PGlite; the public pages' revalidation is a spy; the admin's cookie is faked for the route.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined) }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);

import { POST as saveRoute } from "@/app/api/admin/sooduskood/[id]/route";
import { createCode, deleteCode, listCodes, readCode, setCodeActive, writeCode, codeUses, activeCodeTexts, CODE_PATCH } from "@/server/discount-code-admin";

const NOW = new Date("2026-11-11T10:00:00Z");
const ORIGIN = "https://mslab.example";
const HOUR = 60 * 60_000;

let db: Db;
let contact: { course: Course; session: CourseSession };
let ecourse: Course;
let n = 0;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.cookie = undefined;
  pub.revalidatePublic.mockReset();
  contact = await contactCourse(db); // 350 €
  ecourse = await ecourseCourse(db); // 190 €
});
afterEach(() => vi.restoreAllMocks());

/** A code's fields as the drawer sends them for a new one (10 %, everywhere, anyone, once per person), `over` replacing some. */
const fields = (over: Partial<CodeFields> = {}): CodeFields => ({ ...emptyCodeFields(false), code: `KOOD${++n}`, percent: "10", ...over });
async function make(over: Partial<CodeFields> = {}, at = { welcome: false }): Promise<{ id: number; version: string }> {
  const r = await createCode(db, fields(over), at, NOW);
  if (!r.ok) throw new Error(`createCode refused: ${JSON.stringify(r.fields)}`);
  return r;
}
const row = async (id: number): Promise<DiscountCode> => (await db.select().from(discountCodes).where(eq(discountCodes.id, id)))[0];
const versionNow = async (id: number) => (await readCode(db, id))!.version;
const write = async (id: number, patch: Record<string, unknown>, version?: string) => writeCode(db, id, patch, version ?? (await versionNow(id)), NOW);
/** A use of `codeId` written for a registration of the contact course (350 €, 10 % = 35 €). */
async function bookedUse(codeId: number, over: Parameters<typeof registrationOn>[2] = {}, via: "form" | "cart" | "admin" = "form") {
  const email = `p${++n}@example.test`;
  const r = await registrationOn(db, contact, { email, name: `Õpilane ${n}`, ...over });
  await insertRedemption(db, { codeId, email, clientId: null, courseId: contact.course.id, registrationId: r.id, listCents: 35_000, discountCents: 3_500, via }, NOW);
  return r;
}

describe("create, edit, pause and delete", () => {
  test("create, edit, pause and delete a code", async () => {
    const created = await createCode(db, fields({ code: "tere 10", percent: "15", maxUses: "20", note: " Instagram " }), { welcome: false }, NOW);
    expect(created).toEqual({ ok: true, id: expect.any(Number), version: expect.stringMatching(/^k:[0-9a-f]{32}$/) });
    if (!created.ok) return;
    expect(await row(created.id)).toMatchObject({ code: "TERE10", percent: 15, amountCents: null, scope: "all", maxUses: 20, audience: "all", oncePerPerson: true, welcome: false, active: true, note: "Instagram" });
    expect((await readCode(db, created.id))!.value).toMatchObject({ code: "TERE10", kind: "percent", percent: "15", maxUses: "20", active: true, used: false, welcome: false });

    // an edit: a euro value, chosen courses, the days
    const saved = await write(created.id, { kind: "euro", amount: "25,50", scope: "courses", courseIds: [contact.course.id], startsOn: "2026-12-01", endsOn: "2026-12-07" });
    expect(saved).toEqual({ ok: true, version: await versionNow(created.id), savedAt: NOW.toISOString() });
    expect(await row(created.id)).toMatchObject({ percent: null, amountCents: 2550, scope: "courses", startsOn: "2026-12-01", endsOn: "2026-12-07" });
    expect((await db.select().from(discountCodeCourses).where(eq(discountCodeCourses.codeId, created.id))).map((c) => c.courseId)).toEqual([contact.course.id]);
    expect((await readCode(db, created.id))!.value).toMatchObject({ kind: "euro", amount: "25,50", courseIds: [contact.course.id] });

    // pause and on again
    const paused = await setCodeActive(db, created.id, false, await versionNow(created.id), NOW);
    expect(paused).toEqual({ ok: true, version: await versionNow(created.id) });
    expect((await row(created.id)).active).toBe(false);
    const back = await setCodeActive(db, created.id, true, await versionNow(created.id), NOW);
    expect(back.ok).toBe(true);
    expect((await row(created.id)).active).toBe(true);

    // narrowing the scope away from the courses drops their joins
    expect((await write(created.id, { scope: "all" })).ok).toBe(true);
    expect(await db.select().from(discountCodeCourses).where(eq(discountCodeCourses.codeId, created.id))).toEqual([]);

    // delete
    expect(await deleteCode(db, created.id)).toEqual({ ok: true });
    expect(await readCode(db, created.id)).toBeNull();
    expect(await deleteCode(db, created.id)).toEqual({ ok: false, error: "notFound" });
  });

  test("a save that changes nothing answers the same version and writes nothing; „tere10“ over „TERE10“ is no change", async () => {
    const { id, version } = await make({ code: "TERE10" });
    const same = await write(id, { code: "tere10", percent: "10 " }, version);
    expect(same).toEqual({ ok: true, version, savedAt: NOW.toISOString() });
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("a code that is not a code, or with no value, is refused by field when created", async () => {
    expect(await createCode(db, fields({ code: "---" }), { welcome: false }, NOW)).toEqual({ ok: false, error: "invalid", fields: { code: "codeFormat" } });
    expect(await createCode(db, fields({ code: "" }), { welcome: false }, NOW)).toEqual({ ok: false, error: "invalid", fields: { code: "codeRequired" } });
    expect(await createCode(db, fields({ percent: "100" }), { welcome: false }, NOW)).toMatchObject({ ok: false, fields: { percent: "discountRange" } });
    expect(await createCode(db, { code: "X" }, { welcome: false }, NOW)).toMatchObject({ ok: false, error: "invalid" }); // (not every field)
    expect(await db.select().from(discountCodes)).toEqual([]);
  });
});

describe("codeTaken (R20) and the unique text", () => {
  test("a second code of the same text is codeTaken", async () => {
    const first = await make({ code: "SUVI10" });
    const again = await createCode(db, fields({ code: "suvi-10".replace("-", "") }), { welcome: false }, NOW);
    expect(again).toEqual({ ok: false, error: "invalid", fields: { code: expect.stringMatching(/^codeTaken:\d+$/) } });
    const second = await make({ code: "SUVI11" });
    const renamed = await write(second.id, { code: "suvi10" });
    expect(renamed).toEqual({ ok: false, error: "invalid", fields: { code: `codeTaken:${first.id}` } });
    expect((await row(second.id)).code).toBe("SUVI11");
  });

  test("codeTaken carries the existing code's id", async () => {
    const first = await make({ code: "SUVI10" });
    const second = await make({ code: "SUVI11" });
    const refused = await write(second.id, { code: "SUVI10" });
    expect(refused).toMatchObject({ ok: false, error: "invalid" });
    if (!refused.ok && refused.error === "invalid") expect(refused.fields.code).toBe(`codeTaken:${first.id}`);
    const created = await createCode(db, fields({ code: "suvi10" }), { welcome: false }, NOW);
    expect(created).toEqual({ ok: false, error: "invalid", fields: { code: `codeTaken:${first.id}` } });
  });
});

describe("a used code", () => {
  test("a used code's text is refused codeUsed; its other values change for new bookings", async () => {
    const { id } = await make({ code: "SUVI10" });
    await bookedUse(id);
    expect(await write(id, { code: "SUVI20" })).toEqual({ ok: false, error: "invalid", fields: { code: "codeUsed" } });
    expect((await row(id)).code).toBe("SUVI10");
    // the same text (another spelling) is no change at all, and the other values save
    expect((await write(id, { code: "suvi10", percent: "20", note: "Muudetud" })).ok).toBe(true);
    expect(await row(id)).toMatchObject({ code: "SUVI10", percent: 20, note: "Muudetud" });
    // what was frozen on the use stays
    expect((await db.select().from(discountRedemptions).where(eq(discountRedemptions.codeId, id)))[0]).toMatchObject({ discountCents: 3_500, listCents: 35_000 });
    expect((await readCode(db, id))!.value.used).toBe(true);
  });

  test("a used code cannot be deleted", async () => {
    const { id } = await make();
    await bookedUse(id);
    expect(await deleteCode(db, id)).toEqual({ ok: false, error: "used" });
    expect(await row(id)).toBeDefined();
  });

  test("a code whose only uses are cancelled or abandoned refuses delete with its own line: every use is listed and none counts", async () => {
    const { id } = await make();
    await bookedUse(id, { status: "cancelled" });
    await bookedUse(id, { createdAt: new Date(NOW.getTime() - 72 * HOUR) });
    expect(await deleteCode(db, id)).toEqual({ ok: false, error: "used" });
    const uses = await codeUses(db, id, NOW);
    expect(uses).toHaveLength(2);
    expect(uses.some((u) => u.mark === "counts")).toBe(false);
    expect((await readCode(db, id))!.value.used).toBe(true);
  });

  test("deleteCode answers used when a booking committed first (23503)", async () => {
    const { id } = await make();
    await bookedUse(id);
    // the use-check sees nothing (the booking committed after it), then the delete meets the foreign key
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
          (target.transaction as (f: (tx: Db) => unknown, ...r: unknown[]) => unknown)(async (tx) => {
            const blind = new Proxy(tx, {
              get(t, p, r) {
                if (p === "execute") return async () => [];
                return Reflect.get(t, p, r);
              },
            });
            return fn(blind);
          }, ...rest);
      },
    }) as Db;
    expect(await deleteCode(racing, id)).toEqual({ ok: false, error: "used" });
    expect(await row(id)).toBeDefined();
  });
});

describe("T13-3: the welcome row's text stays changeable", () => {
  test("the welcome row's text changes after it was used; its uses stay", async () => {
    const welcome = await make({ code: "TERE10" }, { welcome: true });
    await bookedUse(welcome.id);
    expect((await readCode(db, welcome.id))!.value.used).toBe(true);
    expect((await write(welcome.id, { code: "uus 15" })).ok).toBe(true);
    expect(await row(welcome.id)).toMatchObject({ code: "UUS15", welcome: true });
    expect(await db.select().from(discountRedemptions).where(eq(discountRedemptions.codeId, welcome.id))).toHaveLength(1);
    // a text another code has is still refused
    const other = await make({ code: "MUU10" });
    expect(await write(welcome.id, { code: "muu10" })).toEqual({ ok: false, error: "invalid", fields: { code: `codeTaken:${other.id}` } });
  });

  test("P27: a renamed used welcome code still counts her use: the new text is the same code, once per person", async () => {
    const welcome = await make({ code: "TERE10" }, { welcome: true });
    const booked = await bookedUse(welcome.id);
    expect((await write(welcome.id, { code: "uus 15" })).ok).toBe(true);
    const found = (await findCode(db, "uus15"))!;
    expect(found.id).toBe(welcome.id);
    expect(found.oncePerPerson).toBe(true);
    const at = { subscribing: false, today: tallinnToday(NOW) };
    // her use of the old text is a use of the renamed one (the uses hang on the row, not the text)
    const hers = await personFacts(db, booked.email, { codeId: found.id, courseId: ecourse.id }, NOW);
    expect(hers.uses).toBe(1);
    expect(personRefusal(ruleOf(found), hers, at)).toBe("used");
    // someone else's facts have none
    expect((await personFacts(db, "muu@example.test", { codeId: found.id, courseId: ecourse.id }, NOW)).uses).toBe(0);
  });
});

describe("the unique index (23505) answers codeTaken:<id>", () => {
  /** A db whose „who has this text“ lookups (select({ id })) inside a transaction see nothing: the duplicate committed after the check. */
  const blind = (real: Db): Db =>
    new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
          (target.transaction as (f: (tx: Db) => unknown, ...r: unknown[]) => unknown)(async (tx) => {
            const seen = new Proxy(tx, {
              get(t, p, r) {
                if (p !== "select") return Reflect.get(t, p, r);
                return (shape?: Record<string, unknown>) => {
                  if (shape && Object.keys(shape).length === 1 && "id" in shape) return { from: () => ({ where: () => ({ limit: async () => [] }) }) };
                  return (t.select as (s?: unknown) => unknown).call(t, shape);
                };
              },
            });
            return fn(seen);
          }, ...rest);
      },
    }) as Db;

  test("on create", async () => {
    const first = await make({ code: "SUVI10" });
    expect(await createCode(blind(db), fields({ code: "suvi10" }), { welcome: false }, NOW)).toEqual({ ok: false, error: "invalid", fields: { code: `codeTaken:${first.id}` } });
  });

  test("on write", async () => {
    const first = await make({ code: "SUVI10" });
    const second = await make({ code: "SUVI11" });
    const refused = await writeCode(blind(db), second.id, { code: "suvi10" }, await versionNow(second.id), NOW);
    expect(refused).toEqual({ ok: false, error: "invalid", fields: { code: `codeTaken:${first.id}` } });
    expect((await row(second.id)).code).toBe("SUVI11");
  });
});

describe("the version and the stale write", () => {
  test("a stale version is 409 with what is stored", async () => {
    const { id, version } = await make({ code: "SUVI10" });
    expect((await write(id, { note: "A" }, version)).ok).toBe(true);
    const stored = (await readCode(db, id))!;
    const stale = await write(id, { note: "B" }, version);
    expect(stale).toEqual({ ok: false, error: "conflict", version: stored.version, value: stored.value });
    expect((await row(id)).note).toBe("A");
    expect(await setCodeActive(db, id, false, version, NOW)).toEqual({ ok: false, error: "stale" });
    expect((await row(id)).active).toBe(true);
    expect(await writeCode(db, 999_999, { note: "x" }, "k:x", NOW)).toEqual({ ok: false, error: "conflict", version: "", value: null });
    expect(await setCodeActive(db, 999_999, false, "k:x", NOW)).toEqual({ ok: false, error: "notFound" });
  });

  test("the version moves with the switch and with the chosen courses", async () => {
    const { id } = await make({ scope: "courses", courseIds: [contact.course.id] });
    const seen = new Set([await versionNow(id)]);
    await setCodeActive(db, id, false, await versionNow(id), NOW);
    seen.add(await versionNow(id));
    await write(id, { courseIds: [contact.course.id, ecourse.id] });
    seen.add(await versionNow(id));
    expect(seen.size).toBe(3);
  });

  test("the route: 401 without a session, 403 from another site, 200 / 409 / 400 / 404 by the contract", async () => {
    const { id, version } = await make({ code: "SUVI10" });
    const post = (target: string | number, body: unknown, headers: Record<string, string> = {}) =>
      saveRoute(new Request(`${ORIGIN}/api/admin/sooduskood/${target}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(target) }) });
    expect((await post(id, { version, patch: { note: "A" } })).status).toBe(401);
    vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
    state.cookie = await signInSession(db, "admin@example.test");
    expect((await post(id, { version, patch: { note: "A" } }, { origin: "https://evil.example" })).status).toBe(403);
    const ok = await post(id, { version, patch: { note: "A" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, version: await versionNow(id), savedAt: expect.any(String) });
    const stale = await post(id, { version, patch: { note: "B" } });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe("conflict");
    const bad = await post(id, { version: await versionNow(id), patch: { percent: "100" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: "invalid", fields: { percent: "discountRange" } });
    expect((await post(id, { version, patch: { welcome: true } })).status).toBe(400); // (not a field of the patch)
    expect((await post(999_999, { version, patch: { note: "A" } })).status).toBe(404);
    vi.unstubAllEnvs();
  });
});

describe("R16: one validator over the stored row merged with the patch", () => {
  test("a one-field patch is checked over the stored row: scope courses with none chosen and euro with no amount are field errors", async () => {
    const { id } = await make();
    expect(await write(id, { scope: "courses" })).toEqual({ ok: false, error: "invalid", fields: { courseIds: "coursesRequired", scope: "coursesRequired" } });
    expect(await write(id, { kind: "euro" })).toEqual({ ok: false, error: "invalid", fields: { amount: "amountEuro", kind: "amountEuro" } });
    expect(await write(id, { endsOn: "2026-12-01" })).toEqual({ ok: true, version: expect.any(String), savedAt: expect.any(String) });
    expect(await write(id, { startsOn: "2026-12-02" })).toMatchObject({ ok: false, fields: { endsOn: "endBeforeStart", startsOn: "endBeforeStart" } });
    expect(await row(id)).toMatchObject({ scope: "all", percent: 10, amountCents: null, startsOn: null, endsOn: "2026-12-01" });
  });

  test("a one-field patch leaves the dates, scope and chosen courses alone", async () => {
    const { id } = await make({ scope: "courses", courseIds: [contact.course.id, ecourse.id], startsOn: "2026-12-01", endsOn: "2026-12-07" });
    expect((await write(id, { note: "Vaid märkus" })).ok).toBe(true);
    expect((await write(id, { maxUses: "5" })).ok).toBe(true);
    expect(await row(id)).toMatchObject({ scope: "courses", startsOn: "2026-12-01", endsOn: "2026-12-07", note: "Vaid märkus", maxUses: 5 });
    expect((await db.select().from(discountCodeCourses).where(eq(discountCodeCourses.codeId, id))).map((c) => c.courseId).sort()).toEqual([contact.course.id, ecourse.id].sort());
  });

  test("the patch's own shape: no other key, no wrong type", async () => {
    expect(CODE_PATCH.safeParse({ welcome: true }).success).toBe(false);
    expect(CODE_PATCH.safeParse({ active: false }).success).toBe(false);
    expect(CODE_PATCH.safeParse({ courseIds: ["1"] }).success).toBe(false);
    expect(CODE_PATCH.safeParse({ note: "ok", courseIds: [1] }).success).toBe(true);
  });
});

describe("R18: the euro ceiling", () => {
  test("a euro amount above the highest list price in scope is amountTooHigh, re-checked when the scope narrows", async () => {
    // all courses: the highest is the contact course's 350 €
    expect(await createCode(db, fields({ kind: "euro", amount: "351" }), { welcome: false }, NOW)).toMatchObject({ ok: false, fields: { amount: "amountTooHigh" } });
    const { id } = await make({ kind: "euro", amount: "350" });
    // narrowing to the e-courses (190 €) puts the stored 350 € above the ceiling
    expect(await write(id, { scope: "ecourse" })).toMatchObject({ ok: false, error: "invalid", fields: { amount: "amountTooHigh" } });
    expect((await row(id)).scope).toBe("all");
    // a lower amount with it passes
    expect((await write(id, { scope: "ecourse", amount: "190" })).ok).toBe(true);
    expect(await write(id, { amount: "190,01" })).toMatchObject({ ok: false, fields: { amount: "amountTooHigh" } });
    // chosen courses read their own prices
    const chosen = await make({ kind: "euro", amount: "100", scope: "courses", courseIds: [ecourse.id] });
    expect(await write(chosen.id, { amount: "191" })).toMatchObject({ ok: false, fields: { amount: "amountTooHigh" } });
    expect((await write(chosen.id, { courseIds: [ecourse.id, contact.course.id], amount: "191" })).ok).toBe(true);
  });

  test("a price drop after the code was made does not stop its other fields from saving", async () => {
    const { id } = await make({ kind: "euro", amount: "300" });
    await db.update(courses).set({ priceGroup: 20_000 }).where(eq(courses.id, contact.course.id));
    expect((await write(id, { note: "Hind langes" })).ok).toBe(true);
  });
});

describe("the welcome row (R9, R11)", () => {
  test("the welcome row's audience and once per person cannot be patched; its fixed rules hold", async () => {
    const { id } = await make({ code: "TERE10", daysAfterSignup: "30" }, { welcome: true });
    expect(await row(id)).toMatchObject({ welcome: true, audience: "first", oncePerPerson: true, daysAfterSignup: 30 });
    expect(await write(id, { audience: "all" })).toEqual({ ok: false, error: "invalid", fields: { audience: "invalid" } });
    expect(await write(id, { oncePerPerson: false })).toEqual({ ok: false, error: "invalid", fields: { oncePerPerson: "invalid" } });
    expect(await row(id)).toMatchObject({ audience: "first", oncePerPerson: true });
    expect((await write(id, { daysAfterSignup: "366" }))).toEqual({ ok: false, error: "invalid", fields: { daysAfterSignup: "codeDaysRange" } });
    expect((await write(id, { daysAfterSignup: "" })).ok).toBe(true);
    expect((await row(id)).daysAfterSignup).toBeNull();
    // only the welcome row has the days
    const other = await make({ code: "MUU10", daysAfterSignup: "30" });
    expect((await row(other.id)).daysAfterSignup).toBeNull();
  });

  test("only one welcome row: another is codeTaken with the existing one's id", async () => {
    const first = await make({ code: "TERE10" }, { welcome: true });
    expect(await createCode(db, fields({ code: "TERE20" }), { welcome: true }, NOW)).toEqual({ ok: false, error: "invalid", fields: { code: `codeTaken:${first.id}` } });
  });

  test("saving the welcome row revalidates every page; another code does not", async () => {
    const welcome = await make({ code: "TERE10" }, { welcome: true });
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "welcomeCode" }); // (the create)
    pub.revalidatePublic.mockReset();
    await write(welcome.id, { percent: "15" });
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "welcomeCode" });
    pub.revalidatePublic.mockReset();
    await setCodeActive(db, welcome.id, false, await versionNow(welcome.id), NOW);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "welcomeCode" });
    pub.revalidatePublic.mockReset();
    await write(welcome.id, { percent: "15" }); // (no change: nothing written, nothing revalidated)
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    await deleteCode(db, welcome.id);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "welcomeCode" });

    pub.revalidatePublic.mockReset();
    const other = await make({ code: "MUU10" });
    await write(other.id, { percent: "15" });
    await setCodeActive(db, other.id, false, await versionNow(other.id), NOW);
    await deleteCode(db, other.id);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });
});

describe("listCodes", () => {
  test("listCodes puts the welcome code first, then the newest, with uses and state", async () => {
    const old = await make({ code: "VANA10", maxUses: "1" });
    const welcome = await make({ code: "TERE10" }, { welcome: true });
    await make({ code: "UUS-25", kind: "euro", amount: "25", scope: "courses", courseIds: [contact.course.id, ecourse.id], startsOn: "2026-12-01", endsOn: "2026-12-24" });
    const paused = await make({ code: "PAUS10", scope: "ecourse" });
    await setCodeActive(db, paused.id, false, paused.version, NOW);
    await bookedUse(old.id); // (the limit is 1: full)
    await bookedUse(old.id, { status: "cancelled" }); // (gives the use back: not counted)
    await bookedUse(welcome.id);
    const rows = await listCodes(db, NOW);
    expect(rows.map((r) => r.code)).toEqual(["TERE10", "PAUS10", "UUS-25", "VANA10"]);
    const by = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(by.TERE10).toMatchObject({ id: welcome.id, welcome: true, value: "10%", scope: "all", courses: 0, startsOn: null, endsOn: null, uses: 1, maxUses: null, state: "active" });
    expect(by["UUS-25"]).toMatchObject({ welcome: false, value: "25 €", scope: "courses", courses: 2, startsOn: "2026-12-01", endsOn: "2026-12-24", uses: 0, state: "upcoming" });
    expect(by.PAUS10).toMatchObject({ scope: "ecourse", state: "paused" });
    expect(by.VANA10).toMatchObject({ uses: 1, maxUses: 1, state: "full" });
    expect(await listCodes(await makeTestDb(), NOW)).toEqual([]);
  });
});

describe("codeUses", () => {
  test("codeUses marks tühistatud, maksmata, makse pooleli, makse ebaõnnestus, tagastatud and lisas haldus", async () => {
    const { id } = await make();
    const live = await bookedUse(id, { name: "Elus Õpilane" });
    const cancelled = await bookedUse(id, { status: "cancelled", name: "Tühistaja" });
    const unpaid = await bookedUse(id, { createdAt: new Date(NOW.getTime() - 72 * HOUR), name: "Maksmata" });
    const byAdmin = await bookedUse(id, { name: "Haldus lisas" }, "admin");
    const ecourseUse = async (status: "pending" | "failed" | "refunded" | "paid", who: string, over: { at?: Date; clientId?: number | null } = {}) => {
      const email = `${who}@example.test`;
      const p = await ecoursePayment(db, ecourse, email, { status, ...over });
      await insertRedemption(db, { codeId: id, email, clientId: p.clientId, courseId: ecourse.id, paymentId: p.id, listCents: 19_000, discountCents: 1_900, via: "cart" }, NOW);
      return p;
    };
    const paid = await ecourseUse("paid", "paid1");
    const pending = await ecourseUse("pending", "pending1", { at: new Date(NOW.getTime() - 3 * HOUR) });
    const failed = await ecourseUse("failed", "failed1");
    const refunded = await ecourseUse("refunded", "refunded1");
    // a refund that left the access (R15) keeps counting
    const kept = await clientWithAccess(db, "kept1@example.test", ecourse);
    const keptRefund = await ecourseUse("refunded", "kept1", { clientId: kept.id });
    const uses = await codeUses(db, id, NOW);
    const markOf = (name: string) => uses.find((u) => u.name === name)!;
    expect(markOf("Elus Õpilane")).toMatchObject({ mark: "counts", via: "form", cents: 3_500, course: "Kulmumeistri baaskoolitus", href: `/admin/registreerimised?id=${live.id}` });
    expect(markOf("Tühistaja").mark).toBe("cancelled");
    expect(markOf("Maksmata").mark).toBe("unpaid");
    expect(markOf("Haldus lisas")).toMatchObject({ mark: "counts", via: "admin", href: `/admin/registreerimised?id=${byAdmin.id}` });
    expect(uses.find((u) => u.href === `/admin/maksed?otsi=${paid.reference}`)).toMatchObject({ mark: "counts", via: "cart", cents: 1_900, course: "Kulmumeistri e-koolitus", name: "Kati Kask" });
    expect(uses.find((u) => u.href === `/admin/maksed?otsi=${pending.reference}`)!.mark).toBe("pending");
    expect(uses.find((u) => u.href === `/admin/maksed?otsi=${failed.reference}`)!.mark).toBe("failed");
    expect(uses.find((u) => u.href === `/admin/maksed?otsi=${refunded.reference}`)!.mark).toBe("refunded");
    expect(uses.find((u) => u.href === `/admin/maksed?otsi=${keptRefund.reference}`)!.mark).toBe("counts");
    expect(uses).toHaveLength(9);
    // newest first (by the time the use was written, then its id)
    const ids = uses.map((u) => u.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(cancelled.id).toBeGreaterThan(0);
    expect(unpaid.id).toBeGreaterThan(0);
  });

  test("a use whose registration is gone is marked gone and counts for nothing", async () => {
    const { id } = await make();
    const r = await bookedUse(id);
    const { registrations } = await import("@/db/schema");
    await db.delete(registrations).where(eq(registrations.id, r.id));
    const uses = await codeUses(db, id, NOW);
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ mark: "gone", href: null });
  });

  test("Soodustust kokku sums the counting uses only", async () => {
    const { id } = await make();
    await bookedUse(id); // 35 €, counts
    await bookedUse(id); // 35 €, counts
    await bookedUse(id, { status: "cancelled" });
    await bookedUse(id, { createdAt: new Date(NOW.getTime() - 72 * HOUR) });
    const uses = await codeUses(db, id, NOW);
    expect(uses).toHaveLength(4);
    expect(discountGiven(uses)).toBe(7_000);
    expect(discountGiven([])).toBe(0);
  });

  test("an unknown code has no uses", async () => {
    expect(await codeUses(db, 999_999, NOW)).toEqual([]);
    expect(courseAccess).toBeDefined();
  });
});

describe("activeCodeTexts", () => {
  test("activeCodeTexts lists active codes valid today only", async () => {
    await make({ code: "LIVE1" });
    await make({ code: "WINDOW1", startsOn: "2026-11-01", endsOn: "2026-11-30" });
    await make({ code: "ENDED1", endsOn: "2026-11-10" });
    await make({ code: "SOON1", startsOn: "2026-11-12" });
    const paused = await make({ code: "PAUSED1" });
    await setCodeActive(db, paused.id, false, paused.version, NOW);
    expect((await activeCodeTexts(db, NOW)).sort()).toEqual(["LIVE1", "WINDOW1"]);
  });
});

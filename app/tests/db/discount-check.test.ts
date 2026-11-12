import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { discountCodes, type Course, type CourseSession } from "@/db/schema";
import { checkDiscount, DISCOUNT_CHECK_LIMIT } from "@/server/discount-check";
import { fakeKv } from "../fakes";
import { insertRedemption } from "@/server/discount-codes";
import { contactCourse, ecourseCourse, registrationOn } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// Discount codes (F1, Task 5): the live check of a typed code, on PGlite with the KV fake behind the rate limit.

const NOW = new Date("2026-11-11T10:00:00Z");
let db: Db;
let contact: Course;
let session: CourseSession;
let ecourse: Course;
let n = 0;

beforeAll(async () => {
  db = await makeTestDb();
  ({ course: contact, session } = await contactCourse(db));
  ecourse = await ecourseCourse(db);
});

const deps = (ip: string | null = "203.0.113.5", kv = fakeKv()) => ({ db, env: { KV: kv } as never, ip, now: NOW });
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
async function makeCode(over: Partial<typeof discountCodes.$inferInsert> = {}) {
  const [row] = await db
    .insert(discountCodes)
    .values({ code: `CHECK${++n}`, percent: over.amountCents ? null : 10, audience: "all", ...over })
    .returning();
  return row;
}

describe("checkDiscount", () => {
  it("an applied code answers the discount, the total, the value, the audience and welcome", async () => {
    const code = await makeCode();
    expect(await checkDiscount(deps(), form({ course: contact.slug, code: code.code }))).toEqual({
      ok: true, code: code.code, discountCents: 3500, totalCents: 31500, value: "10%", audience: "all", welcome: false,
    });
    const e = await makeCode({ amountCents: 2000, percent: null, audience: "first" });
    const answer = await checkDiscount(deps(), form({ course: ecourse.slug, code: e.code }));
    expect(answer).toMatchObject({ ok: true, discountCents: 2000, totalCents: 17000, audience: "first" });
  });

  it("lower case and spaces are applied", async () => {
    const code = await makeCode();
    const answer = await checkDiscount(deps(), form({ course: contact.slug, code: ` ${code.code.toLowerCase()} ` }));
    expect(answer).toMatchObject({ ok: true, code: code.code });
  });

  it("each refusal answers its own error, notYet with startsOn", async () => {
    const ask = async (over: Parameters<typeof makeCode>[0]) => checkDiscount(deps(), form({ course: contact.slug, code: (await makeCode(over)).code }));
    expect(await ask({ active: false })).toEqual({ ok: false, error: "paused" });
    expect(await ask({ endsOn: "2026-11-10" })).toEqual({ ok: false, error: "ended" });
    expect(await ask({ startsOn: "2026-12-01" })).toEqual({ ok: false, error: "notYet", startsOn: "2026-12-01" });
    expect(await ask({ scope: "ecourse" })).toEqual({ ok: false, error: "scope" });
    const full = await makeCode({ maxUses: 1 });
    const r = await registrationOn(db, { course: contact, session }, { email: "kati@example.test" });
    await insertRedemption(db, { codeId: full.id, email: "kati@example.test", clientId: null, courseId: contact.id, registrationId: r.id, listCents: 35000, discountCents: 3500, via: "form" }, NOW);
    expect(await checkDiscount(deps(), form({ course: contact.slug, code: full.code }))).toEqual({ ok: false, error: "usedUp" });
  });

  it("an unknown course or code answers unknown", async () => {
    const code = await makeCode();
    expect(await checkDiscount(deps(), form({ course: "ei-ole", code: code.code }))).toEqual({ ok: false, error: "unknown" });
    expect(await checkDiscount(deps(), form({ course: contact.slug, code: "NOSUCHCODE" }))).toEqual({ ok: false, error: "unknown" });
    expect(await checkDiscount(deps(), form({ course: contact.slug, code: "bad code!" }))).toEqual({ ok: false, error: "unknown" });
  });

  it("an empty code answers empty, before the rate check: also with the visitor's checks used up, and it uses none of them (P9)", async () => {
    expect(await checkDiscount(deps(), form({ course: contact.slug, code: "  " }))).toEqual({ ok: false, error: "empty" });
    expect(await checkDiscount(deps(), form({ course: contact.slug }))).toEqual({ ok: false, error: "empty" });
    const kv = fakeKv();
    const code = await makeCode();
    const ask = (typed?: string) => checkDiscount(deps("203.0.113.7", kv), form({ course: contact.slug, ...(typed === undefined ? {} : { code: typed }) }));
    for (let i = 0; i < DISCOUNT_CHECK_LIMIT - 1; i++) expect(await ask(code.code)).toMatchObject({ ok: true });
    // emptied fields between the checks take nothing from the 20
    for (let i = 0; i < 5; i++) expect(await ask("  ")).toEqual({ ok: false, error: "empty" });
    expect(await ask(code.code)).toMatchObject({ ok: true });
    // the bucket is empty now: a code is held, an empty field still answers empty
    expect(await ask(code.code)).toEqual({ ok: false, error: "rate" });
    expect(await ask("  ")).toEqual({ ok: false, error: "empty" });
    expect(await ask()).toEqual({ ok: false, error: "empty" });
  });

  it("the 21st check in 10 minutes answers rate", async () => {
    const kv = fakeKv();
    const code = await makeCode();
    for (let i = 0; i < DISCOUNT_CHECK_LIMIT; i++) {
      expect(await checkDiscount(deps("203.0.113.9", kv), form({ course: contact.slug, code: code.code }))).toMatchObject({ ok: true });
    }
    expect(await checkDiscount(deps("203.0.113.9", kv), form({ course: contact.slug, code: code.code }))).toEqual({ ok: false, error: "rate" });
    // another visitor, and a request without an address, are not held
    expect(await checkDiscount(deps("203.0.113.10", kv), form({ course: contact.slug, code: code.code }))).toMatchObject({ ok: true });
    expect(await checkDiscount(deps(null, kv), form({ course: contact.slug, code: code.code }))).toMatchObject({ ok: true });
  });

  it("it takes no e-mail", async () => {
    const code = await makeCode({ audience: "returning" });
    const without = await checkDiscount(deps(), form({ course: contact.slug, code: code.code }));
    const withMail = await checkDiscount(deps(), form({ course: contact.slug, code: code.code, email: "kati@example.test" }));
    expect(withMail).toEqual(without);
  });
});

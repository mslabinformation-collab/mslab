import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { contracts, courses, discountCodes, discountRedemptions, registrations, subscribers, type Course, type CourseSession } from "@/db/schema";
import type { Env } from "@/server/notify";
import { handleRegistration, type Deps } from "@/server/submit";
import { fakeKv } from "../fakes";
import { contactCourse, registrationOn } from "./payments-fixtures";
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
    expect(contract.fields.price).toMatch(/^315(,00)?\s€$/);
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
    expect(await submit({ discountCode: welcome.code, discountCents: "3500", newsletter: "on" }, who)).toEqual({ ok: true });
    await db.delete(discountRedemptions).where(eq(discountRedemptions.codeId, welcome.id));
    await db.delete(discountCodes).where(eq(discountCodes.id, welcome.id));
  });

  it("the welcome code twice for the same course before paying: both get it; for another course: person", async () => {
    const welcome = await makeCode({ welcome: true, audience: "first" });
    const who = email();
    const again = { discountCode: welcome.code, discountCents: "3500", newsletter: "on" };
    expect(await submit(again, who)).toEqual({ ok: true });
    expect(await submit(again, who)).toEqual({ ok: true });
    expect(await rowsOf(who)).toHaveLength(2);
    // the other course (30 000: 10% is 3 000)
    expect(await submit({ ...again, discountCents: "3000" }, who, { slug: other.course.slug, sessionId: other.session.id })).toEqual({ ok: false, errors: { discountCode: "person" } });
    await db.delete(discountRedemptions).where(eq(discountRedemptions.codeId, welcome.id));
    await db.delete(discountCodes).where(eq(discountCodes.id, welcome.id));
  });
});

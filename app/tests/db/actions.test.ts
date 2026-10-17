import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestDb, shownContractVersion } from "./helpers";
import type { Db } from "@/db/client";
import { clientLoginTokens, courses, courseSessions, mailQuota, practicePackages, registrations, requests, settings, subscribers } from "@/db/schema";
import type { PublicChange } from "@/server/cache-targets";
import { CONFIRMATION_MAIL_DAILY_CAP, LOGIN_MAIL_DAILY_CAP, NEWSLETTER_MAIL_DAILY_CAP, issueClientLogin, redeemClientCode } from "@/server/client-auth";
import { confirmSubscriber, unsubscribeByToken } from "@/server/newsletter";
import type { Env } from "@/server/notify";
import { sha256 } from "@/server/token";
import {
  createRegistration,
  handleContact,
  handleIndividual,
  handlePractice,
  handlePurchaseInterest,
  handleRegistration,
  handleSubscribe,
  handleWaitlist,
  runSubmission,
  type Deps,
} from "@/server/submit";
import { fakeKv, stubFetch, type FetchCall } from "../fakes";
import { getCourseBySlug, listUpcomingSessions } from "@/db/queries/public";
import { upcomingFrom } from "@/domain/calendar";

// Form submissions end to end without Next.js: PGlite database, in-memory KV, stubbed fetch for Resend and Telegram.

const NOW = new Date("2026-10-01T10:00:00Z");
const text = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };

let db: Db;
let c: { id: number };
let s: { id: number };
const ids = { other: 0, full: 0, cancelled: 0, past: 0, thisMorning: 0, yesterday: 0, thisEvening: 0, otherCourse: 0, unpublished: 0, groupless: 0 };

/** The contact contract's version the course page shows (contracts R6: the group form sends it with the box). */
let contractVersion = "";

beforeAll(async () => {
  db = await makeTestDb();
  contractVersion = await shownContractVersion(db);
  [c] = await db
    .insert(courses)
    .values({ ...text, slug: "kulmud", type: "contact", title: { et: "Kulmude baaskoolitus" }, published: true, priceGroup: 39000, priceIndividual: 45000 })
    .returning();
  const [other] = await db
    .insert(courses)
    .values({ ...text, slug: "ripsmed", type: "contact", title: { et: "Ripsmed" }, published: true, priceGroup: 30000 })
    .returning();
  const [unpublished] = await db.insert(courses).values({ ...text, slug: "mustand", type: "contact", title: { et: "Mustand" }, priceGroup: 1 }).returning();
  const [groupless] = await db
    .insert(courses)
    .values({ ...text, slug: "ainult-individuaal", type: "contact", title: { et: "Individuaal" }, published: true, priceIndividual: 1 })
    .returning();
  await db.insert(courses).values({ ...text, slug: "e-kulmud", type: "e_learning", title: { et: "Kulmude e-koolitus" }, published: true, price: 19000 });
  const session = (courseId: number, startsAt: string, extra: Partial<typeof courseSessions.$inferInsert> = {}) =>
    db.insert(courseSessions).values({ courseId, startsAt: new Date(startsAt), city: "Pärnu", venue: "MS LAB stuudio", capacity: 4, ...extra }).returning();
  [s] = await session(c.id, "2026-11-14T08:00:00Z");
  ids.other = (await session(c.id, "2026-12-05T08:00:00Z", { city: "Tartu", venue: "" }))[0].id;
  ids.full = (await session(c.id, "2026-12-12T08:00:00Z", { capacity: 1 }))[0].id;
  ids.cancelled = (await session(c.id, "2026-12-19T08:00:00Z", { status: "cancelled" }))[0].id;
  ids.past = (await session(c.id, "2026-09-01T08:00:00Z"))[0].id;
  // NOW is 13:00 on 1.10 in Tallinn: one session began this morning, one yesterday, one begins this evening (item 10)
  ids.thisMorning = (await session(c.id, "2026-10-01T07:00:00Z", { city: "Hommik" }))[0].id;
  ids.yesterday = (await session(c.id, "2026-09-30T07:00:00Z", { city: "Eile" }))[0].id;
  ids.thisEvening = (await session(c.id, "2026-10-01T15:00:00Z", { city: "Õhtu" }))[0].id;
  ids.otherCourse = (await session(other.id, "2026-11-20T08:00:00Z"))[0].id;
  ids.unpublished = unpublished.id;
  ids.groupless = groupless.id;
  // One confirmed registration fills the one-seat session.
  await db.insert(registrations).values({ courseId: c.id, courseSessionId: ids.full, kind: "group", name: "X", email: "x@example.com", paymentChoice: "full", status: "confirmed" });
  await db.insert(practicePackages).values({ code: "MINI", name: { et: "MINI" }, tagline: { et: "" }, models: 2, durationLabel: { et: "4 ak" }, price: 15000 });
});

beforeEach(async () => {
  await db.delete(requests);
  await db.delete(subscribers);
  await db.delete(registrations).where(eq(registrations.email, "test@example.com"));
  await db.delete(registrations).where(sql`email like 'nl-%'`);
  await db.delete(clientLoginTokens);
  await db.delete(mailQuota);
  await db.delete(settings).where(eq(settings.key, "prepayment"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SECRETS = { RESEND_API_KEY: "re_test", TELEGRAM_BOT_TOKEN: "123:abc" };

/** Dependencies with a fresh KV; `flush()` awaits the notification work that production runs after the response. */
function setup(opts: { secrets?: boolean; ip?: string; kv?: ReturnType<typeof fakeKv> } = {}) {
  const kv = opts.kv ?? fakeKv({ "tg:chat": "42" });
  const env: Env = { KV: kv, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.com", SITE_URL: "https://mslab.example", ...(opts.secrets ? SECRETS : {}) };
  const tasks: (() => Promise<unknown>)[] = [];
  const changes: PublicChange[] = [];
  const deps: Deps = { db, env, ip: opts.ip ?? "203.0.113.1", siteUrl: "https://mslab.example", now: NOW, later: (task) => void tasks.push(task), changed: (c) => void changes.push(c) };
  return { deps, kv, changes, flush: () => Promise.all(tasks.splice(0).map((task) => task())) };
}

/** Resend and Telegram stubs; quiet console. */
function outbox() {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = stubFetch((url) => (url.includes("resend") ? Response.json({ id: "email_1" }) : Response.json({ ok: true })));
  const mails = () => f.calls.filter((x) => x.url.includes("resend")).map((x) => x.body as { to: string; subject: string; text: string; html?: string; reply_to?: string });
  const pings = () => f.calls.filter((x: FetchCall) => x.url.includes("telegram")).map((x) => (x.body as { text: string }).text);
  return { mails, pings };
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const group = (extra: Record<string, string> = {}) =>
  form({ course: "kulmud", session: String(s.id), name: "Test  Õpilane", email: " Test@Example.com ", phone: "+372 5555 5555", payment: "half", modelHelp: "on", terms: "on", locale: "ru", contractVersion, ...extra });

test("createRegistration never confirms", async () => {
  const r = await createRegistration(db, { courseId: c.id, courseSessionId: s.id, kind: "group", name: "A", email: "a@example.ee", phone: "1", paymentChoice: "full", wantsModelHelp: true, wantsAccount: false, preferredPeriod: "", message: "", locale: "et" });
  expect(r.status).toBe("awaiting_prepayment");
  expect(r.paidCents).toBe(0);
  await db.delete(registrations).where(eq(registrations.id, r.id));
});

test("createRegistration stores the e-mail trimmed and lowercased", async () => {
  const r = await createRegistration(db, { courseId: c.id, courseSessionId: s.id, kind: "group", name: "A", email: "  A@Example.EE ", phone: "1", paymentChoice: "full", wantsModelHelp: false, wantsAccount: false, preferredPeriod: "", message: "", locale: "et" });
  expect(r.email).toBe("a@example.ee");
  await db.delete(registrations).where(eq(registrations.id, r.id));
});

describe("group registration", () => {
  test("a stored registration revalidates the course's pages and the calendar (seats); a refused one does not", async () => {
    outbox();
    const { deps, changes } = setup();
    expect(await handleRegistration(deps, group({ session: String(ids.full) }))).toEqual({ ok: false, errors: { session: "full" } });
    expect(changes).toEqual([]);
    expect(await handleRegistration(deps, group())).toEqual({ ok: true });
    expect(changes).toEqual([{ kind: "seats", course: "kulmud" }]);
  });

  test("is stored awaiting prepayment, then Maria gets the summary by e-mail and Telegram", async () => {
    const { mails, pings } = outbox();
    const { deps, flush } = setup({ secrets: true });
    expect(await handleRegistration(deps, group())).toEqual({ ok: true });
    const rows = await db.select().from(registrations).where(eq(registrations.email, "test@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      courseId: c.id,
      courseSessionId: s.id,
      kind: "group",
      name: "Test Õpilane",
      phone: "+372 5555 5555",
      paymentChoice: "half",
      wantsModelHelp: true,
      wantsAccount: false,
      locale: "ru",
      status: "awaiting_prepayment",
      paidCents: 0,
    });
    expect(mails()).toHaveLength(0); // notifications run after the response
    await flush();
    const [mail] = mails();
    expect(mail.to).toBe("maria@example.com");
    expect(mail.reply_to).toBe("test@example.com");
    expect(mail.subject).toBe("Registreerimine: Kulmude baaskoolitus, 14.11.2026 kell 10:00, Pärnu — Test Õpilane");
    for (const line of [
      "Koolitus: Kulmude baaskoolitus",
      "Kuupäev: 14.11.2026 kell 10:00",
      "Koht: Pärnu, MS LAB stuudio",
      "Nimi: Test Õpilane",
      "E-post: test@example.com",
      "Telefon: +372 5555 5555",
      "Suhtluskeel: vene",
      "Tasumine: 50% registreerimisel + 50% koolituspäeval",
      "Abi modellide leidmisel: jah",
      "Loo konto: ei",
      "Staatus: ootab ettemaksu. Koht kinnitub alles pärast vähemalt 50% ettemaksu laekumist.",
      "Admin: https://mslab.example/admin",
    ])
      expect(mail.text).toContain(line);
    const [ping] = pings();
    expect(ping).toContain("Uus registreerimine (grupikoolitus)");
    expect(ping).toContain("Test Õpilane · test@example.com · +372 5555 5555");
    expect(ping.endsWith("https://mslab.example/admin")).toBe(true);
  });

  test("a date that filled up meanwhile is a session error; nothing is stored", async () => {
    const { deps } = setup();
    expect(await handleRegistration(deps, group({ session: String(ids.full) }))).toEqual({ ok: false, errors: { session: "full" } });
    for (const id of [ids.cancelled, ids.past, ids.otherCourse, 999999])
      expect(await handleRegistration(deps, group({ session: String(id) })), String(id)).toEqual({ ok: false, errors: { session: "unavailable" } });
    expect(await db.select().from(registrations).where(eq(registrations.email, "test@example.com"))).toHaveLength(0);
  });

  test("a session that began earlier today is no longer listed or bookable; one later today is (item 10, ruling)", async () => {
    // NOW is 13:00 on 1.10 in Tallinn: one session began at 10:00, one begins at 18:00
    const { deps } = setup();
    expect(await handleRegistration(deps, group({ session: String(ids.thisMorning) }))).toEqual({ ok: false, errors: { session: "unavailable" } });
    expect(await handleRegistration(setup().deps, group({ session: String(ids.yesterday) }))).toEqual({ ok: false, errors: { session: "unavailable" } });
    const listed = await getCourseBySlug(db, "kulmud", { sessionsFrom: upcomingFrom(NOW) });
    expect(listed?.sessions.map((x) => x.id)).not.toContain(ids.thisMorning);
    expect(listed?.sessions.map((x) => x.id)).toContain(ids.thisEvening);
    expect((await listUpcomingSessions(db, upcomingFrom(NOW))).map((x) => x.id)).not.toContain(ids.thisMorning);
    expect(await handleRegistration(setup().deps, group({ session: String(ids.thisEvening) }))).toEqual({ ok: true });
    expect(await db.select().from(registrations).where(eq(registrations.email, "test@example.com"))).toHaveLength(1);
  });

  test("only published contact courses with a group price", async () => {
    const { deps } = setup();
    for (const course of ["mustand", "ainult-individuaal", "e-kulmud", "ei-ole"])
      expect(await handleRegistration(deps, group({ course })), course).toEqual({ ok: false, errors: { form: "invalid" } });
  });

  test("without secrets (local dev) it is stored and the notification is skipped", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = stubFetch();
    const { deps, flush } = setup();
    expect(await handleRegistration(deps, group({ session: String(ids.other) }))).toEqual({ ok: true });
    await flush();
    expect(f.calls).toHaveLength(0);
    expect(info).toHaveBeenCalledWith("[notify] RESEND_API_KEY is not set: e-mail skipped");
    expect(await db.select().from(registrations).where(eq(registrations.email, "test@example.com"))).toHaveLength(1);
  });

  test("a failing notification never fails the stored submission", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    stubFetch(() => {
      throw new Error("offline");
    });
    const { deps, flush } = setup({ secrets: true });
    expect(await handleRegistration(deps, group())).toEqual({ ok: true });
    await expect(flush()).resolves.toBeDefined();
    expect(await db.select().from(registrations).where(eq(registrations.email, "test@example.com"))).toHaveLength(1);
  });
});

describe("honeypot and rate limit", () => {
  test("a filled honeypot pretends success and stores nothing (and does not count)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { deps, kv } = setup();
    expect(await handleContact(deps, form({ name: "Bot", email: "bot@example.com", message: "spam", website: "x" }))).toEqual({ ok: true });
    expect(await db.select().from(requests)).toHaveLength(0);
    expect([...kv.store.keys()].filter((k) => k.startsWith("rl:"))).toEqual([]);
  });

  test("a filled honeypot on the newsletter sign-up answers like success, stores no subscriber, sends no mail and does not count", async () => {
    const { mails } = outbox();
    const { deps, kv, flush } = setup({ secrets: true });
    expect(await handleSubscribe(deps, form({ email: "bot@example.com", locale: "et", website: "x" }))).toEqual({ ok: true });
    await flush();
    expect(await db.select().from(subscribers)).toHaveLength(0);
    expect(mails()).toHaveLength(0);
    expect([...kv.store.keys()].filter((k) => k.startsWith("rl:"))).toEqual([]);
    // the same address without the honeypot is a normal sign-up (the test could fail: the form is otherwise good)
    expect(await handleSubscribe(deps, form({ email: "bot@example.com", locale: "et" }))).toEqual({ ok: true });
    expect(await db.select().from(subscribers)).toHaveLength(1);
  });

  test("5 submissions per form and IP in 10 minutes; the 6th gets form 'rate'", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { deps, kv } = setup({ ip: "198.51.100.9" });
    const msg = form({ name: "A", email: "a@example.com", message: "Tere" });
    for (let i = 0; i < 5; i++) expect(await handleContact(deps, msg)).toEqual({ ok: true });
    expect(await handleContact(deps, msg)).toEqual({ ok: false, errors: { form: "rate" } });
    expect(await db.select().from(requests)).toHaveLength(5);
    expect(kv.ttl.get("rl:contact:198.51.100.9")).toBe(600);
    // Another form and another visitor are counted separately.
    expect(await handlePractice(deps, form({ package: "MINI", name: "A", email: "a@example.com", phone: "+372 5555 5555", times: "õhtuti" }))).toEqual({ ok: true });
    expect(await handleContact({ ...deps, ip: "198.51.100.10" }, msg)).toEqual({ ok: true });
  });

  test("a request without a visitor address is not rate limited (no shared bucket); logged once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, kv } = setup();
    const msg = form({ name: "A", email: "a@example.com", message: "Tere" });
    for (let i = 0; i < 7; i++) expect(await handleContact({ ...deps, ip: null }, msg)).toEqual({ ok: true });
    expect([...kv.store.keys()].filter((k) => k.startsWith("rl:"))).toEqual([]);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/\d+\.\d+\.\d+/);
  });

  test("invalid submissions are not counted", async () => {
    const { deps, kv } = setup();
    for (let i = 0; i < 7; i++) expect((await handleContact(deps, form({ name: "", email: "x", message: "" }))).ok).toBe(false);
    expect(kv.store.size).toBe(1); // only tg:chat
  });

  test("when KV fails the submission still goes through (fail open)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const kv = fakeKv();
    kv.get = async () => {
      throw new Error("KV down");
    };
    const { deps } = setup({ kv });
    expect(await handleContact(deps, form({ name: "A", email: "a@example.com", message: "Tere" }))).toEqual({ ok: true });
    expect(await db.select().from(requests)).toHaveLength(1);
  });
});

describe("requests", () => {
  test("individual course: kind individual with the preferred period, no payment choice", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    const r = await handleIndividual(deps, form({ course: "kulmud", name: "Test", email: "TEST@example.com", phone: "+372 5555 5555", period: "Detsembri teine pool", message: "Mul on küsimus.\nTeine rida.", account: "on", terms: "on" }));
    expect(r).toEqual({ ok: true });
    const [row] = await db.select().from(requests);
    expect(row.kind).toBe("individual");
    expect(row.handled).toBe(false);
    expect(row.payload).toEqual({
      course: "kulmud",
      courseId: c.id,
      name: "Test",
      email: "test@example.com",
      phone: "+372 5555 5555",
      preferredPeriod: "Detsembri teine pool",
      message: "Mul on küsimus.\nTeine rida.",
      wantsModelHelp: false,
      wantsAccount: true,
      locale: "et",
    });
    expect(await db.select().from(registrations).where(eq(registrations.email, "test@example.com"))).toHaveLength(0);
    await flush();
    expect(mails()[0].subject).toBe("Individuaalkoolituse päring: Kulmude baaskoolitus — Test");
    expect(mails()[0].text).toContain("Soovitud periood või kuupäev: Detsembri teine pool");
    expect(mails()[0].text).toContain("Sõnum:\nMul on küsimus.\nTeine rida.");
    // A course without an individual price does not take requests.
    expect(await handleIndividual(deps, form({ course: "ripsmed", name: "T", email: "t@example.com", phone: "+372 5555 5555", period: "x", terms: "on" }))).toEqual({ ok: false, errors: { form: "invalid" } });
  });

  test("contact message", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    expect(await handleContact(deps, form({ name: "Mari", email: "mari@example.com", message: "Tere!", locale: "ru" }))).toEqual({ ok: true });
    const [row] = await db.select().from(requests);
    expect(row).toMatchObject({ kind: "contact", payload: { name: "Mari", email: "mari@example.com", message: "Tere!", locale: "ru" } });
    await flush();
    expect(mails()[0]).toMatchObject({ subject: "Sõnum kodulehelt — Mari", reply_to: "mari@example.com" });
  });

  test("purchase interest: a contact request { course, intent: purchase, email } for a published e-course", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { deps } = setup();
    expect(await handlePurchaseInterest(deps, form({ course: "e-kulmud", email: "Ostja@Example.com" }))).toEqual({ ok: true });
    const [row] = await db.select().from(requests);
    expect(row).toMatchObject({ kind: "contact", payload: { course: "e-kulmud", intent: "purchase", email: "ostja@example.com", locale: "et" } });
    expect(await handlePurchaseInterest(deps, form({ course: "kulmud", email: "a@example.com" }))).toEqual({ ok: false, errors: { form: "invalid" } });
  });

  test("practice request for a known package", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { deps } = setup();
    const fields = { package: "MINI", name: "Test", email: "test@example.com", phone: "+372 5555 5555", course: "Kulmud", times: "Tööpäeva õhtud" };
    expect(await handlePractice(deps, form(fields))).toEqual({ ok: true });
    const [row] = await db.select().from(requests);
    expect(row).toMatchObject({ kind: "practice", payload: { ...fields, locale: "et" } });
    expect(await handlePractice(deps, form({ ...fields, package: "MAXI" }))).toEqual({ ok: false, errors: { package: "required" } });
  });

  test("waitlist for a scheduled session of a published course", async () => {
    const { mails } = outbox();
    const { deps, flush, changes } = setup({ secrets: true });
    expect(await handleWaitlist(deps, form({ session: String(ids.full), name: "Test", email: "test@example.com" }))).toEqual({ ok: true });
    // the cached calendar and course page show the session's seats: they are revalidated
    expect(changes).toEqual([{ kind: "seats", course: "kulmud" }]);
    const [row] = await db.select().from(requests);
    expect(row).toMatchObject({ kind: "waitlist", payload: { session: ids.full, course: "kulmud", name: "Test", email: "test@example.com", locale: "et" } });
    await flush();
    expect(mails()[0].subject).toBe("Ootenimekiri: Kulmude baaskoolitus, 12.12.2026 kell 10:00, Pärnu — Test");
    for (const session of [ids.cancelled, 999999])
      expect(await handleWaitlist(deps, form({ session: String(session), name: "T", email: "t@example.com" }))).toEqual({ ok: false, errors: { form: "invalid" } });
    expect(changes).toHaveLength(1); // nothing stored, nothing to revalidate
  });

  test("no waitlist entry for a session that has begun: the same start-time rule as a registration (round 2 item 16)", async () => {
    // NOW is 13:00 on 1.10 in Tallinn: one session began at 10:00 today, one yesterday, one long ago; one is at 18:00
    const { deps, changes } = setup();
    for (const session of [ids.thisMorning, ids.yesterday, ids.past])
      expect(await handleWaitlist(deps, form({ session: String(session), name: "T", email: "begun@example.com" })), String(session)).toEqual({ ok: false, errors: { form: "invalid" } });
    expect(await db.select().from(requests).where(sql`${requests.payload}->>'email' = 'begun@example.com'`)).toHaveLength(0);
    expect(changes).toEqual([]);
    expect(await handleWaitlist(setup().deps, form({ session: String(ids.thisEvening), name: "T", email: "begun@example.com" }))).toEqual({ ok: true });
  });

  test("the cached pages are marked stale before the form answers: the next request shows the new seats (round 2 item 22)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const order: string[] = [];
    const slowChange = (deps: Deps): Deps => ({
      ...deps,
      changed: async (c) => {
        await new Promise((r) => setTimeout(r, 20)); // the revalidation
        order.push(`stale:${c.kind}`);
      },
    });
    const registered = handleRegistration(slowChange(setup().deps), group({ session: String(ids.thisEvening), email: "order@example.com" })).then((r) => (order.push("answer"), r));
    expect(await registered).toEqual({ ok: true });
    const waitlisted = handleWaitlist(slowChange(setup().deps), form({ session: String(ids.full), name: "T", email: "order@example.com" })).then((r) => (order.push("answer"), r));
    expect(await waitlisted).toEqual({ ok: true });
    expect(order).toEqual(["stale:seats", "answer", "stale:seats", "answer"]);
    await db.delete(registrations).where(eq(registrations.email, "order@example.com"));
  });
});

describe("failures are logged without personal data", () => {
  test("a failing insert answers form 'server' and logs the error class and SQLSTATE, never field values", async () => {
    const broken = await makeTestDb();
    await broken.execute(sql`drop table requests`);
    const fields = { name: "Mari Maasikas", email: "mari.secret@example.com", message: "Salajane sõnum 5551234", locale: "et" };
    // Sanity: the driver error message does carry the parameters, so this test would catch them being logged.
    const direct = await broken.insert(requests).values({ kind: "contact", payload: fields }).catch((e: unknown) => e);
    expect(String((direct as Error).message)).toContain("mari.secret@example.com");

    const logs = (["error", "warn", "info", "log"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { deps } = setup();
    const result = await runSubmission("contact", () => ({ ...deps, db: broken }), handleContact, form(fields));
    expect(result).toEqual({ ok: false, errors: { form: "server" } });
    const logged = logs.flatMap((spy) => spy.mock.calls.flat()).map(String).join("\n");
    expect(logged).toContain("[forms] contact: not stored: DrizzleQueryError (code 42P01)");
    for (const value of ["Mari", "Maasikas", "mari.secret", "Salajane", "5551234", "insert into"]) expect(logged).not.toContain(value);
  });

  test("a failure while building the dependencies is answered the same way", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runSubmission("contact", () => {
      throw new Error("no database connection: mari@example.com");
    }, handleContact, form({}));
    expect(result).toEqual({ ok: false, errors: { form: "server" } });
  });
});

describe("newsletter sign-up in one step (owner decision 09.10)", () => {
  // Typing the address and pressing "Liitu" is the whole sign-up: the row is confirmed at once (the time of the submission is the consent), and the only
  // mail is the welcome mail, which carries the unsubscribe link. Every guard of the old confirmation mail still holds: sample address, Resend, 3 a day
  // per address, the once-a-year mark of the welcome and the newsletter's own daily counter.
  const signUp = (deps: Deps, email = "uus@example.com", locale = "et") => handleSubscribe(deps, form({ email, locale }));
  const setCode = (welcomeCode: string) =>
    db.insert(settings).values({ key: "newsletter", value: { discountLabel: "10%", welcomeCode } }).onConflictDoUpdate({ target: settings.key, set: { value: { discountLabel: "10%", welcomeCode } } });
  const WELCOME_RU = "Добро пожаловать в\u00a0MS LAB!";
  const OLD_CONFIRM = ["Kinnita MS LABi uudiskirjaga liitumine", "Подтвердите подписку на рассылку MS LAB"];

  beforeEach(async () => {
    await db.delete(settings).where(eq(settings.key, "newsletter"));
  });

  test("a new address is stored confirmed at once and gets the welcome mail in its language, with the unsubscribe link of its row; no confirmation mail", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    expect(await signUp(deps, " Uus@Example.com ", "ru")).toEqual({ ok: true });
    const [sub] = await db.select().from(subscribers);
    expect(sub).toMatchObject({ email: "uus@example.com", locale: "ru", confirmedAt: NOW });
    expect(sub.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sub.consentAt).toEqual(NOW); // the time of the submission: sending the form is the consent (no consent box)
    await flush();
    const [mail] = mails();
    expect(mails()).toHaveLength(1);
    expect(mail.to).toBe("uus@example.com");
    expect(mail.subject).toBe(WELCOME_RU);
    expect(OLD_CONFIRM).not.toContain(mail.subject);
    expect(mail.text).toContain(`Если вы не подписывались сами или больше не хотите получать письма MS LAB, отпишитесь здесь: https://mslab.example/api/newsletter/loobu?t=${sub.token}`);
    expect(mail.text).not.toContain("/api/newsletter/confirm");
    // The link base is the allow-listed request origin the action resolved (deps.siteUrl), not always SITE_URL.
    await signUp({ ...deps, siteUrl: "https://mslab.diipsolutions.eu" }, "teine@example.com");
    await flush();
    expect(mails()[1].text).toContain("https://mslab.diipsolutions.eu/api/newsletter/loobu?t=");
  });

  test("the welcome mail goes out without a Tervituskood too: no code lines, but the unsubscribe line; with a code it has both", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    await signUp(deps, "ilma@example.com");
    await flush();
    const plain = mails()[0].text;
    expect(plain).toContain("Aitäh, et liitusid MS LABi uudiskirjaga.");
    expect(plain).not.toContain("Sinu tervituskood");
    expect(plain).not.toContain("Lisa kood registreerimisel");
    expect(plain).toContain("Kui sa ei liitunud ise või ei soovi enam MS LABi kirju, loobu siit: https://mslab.example/api/newsletter/loobu?t=");
    await setCode("TERE10");
    await signUp(deps, "koodiga@example.com");
    await flush();
    const coded = mails()[1].text;
    expect(coded).toContain("Sinu tervituskood:");
    expect(coded).toContain("TERE10");
    expect(coded).toContain("Kui sa ei liitunud ise või ei soovi enam MS LABi kirju, loobu siit:");
    expect(coded.indexOf("loobu siit")).toBeGreaterThan(coded.indexOf("TERE10")); // the unsubscribe line is the last before the signature
    expect(coded.trimEnd().endsWith("MS LAB Koolituskeskus")).toBe(true);
  });

  test("the code never reaches the answer: the visitor gets { ok: true } only, with a code set or not", async () => {
    outbox();
    const { deps } = setup({ secrets: true });
    await setCode("TERE10");
    expect(await signUp(deps)).toStrictEqual({ ok: true });
  });

  test("the e-mail alone is a sign-up: no consent field is needed, one that an older page sends changes nothing, a bad address stores nothing", async () => {
    const { deps } = setup({ secrets: true });
    expect(await handleSubscribe(deps, form({ email: "yksi@example.com" }))).toEqual({ ok: true });
    expect(await handleSubscribe(deps, form({ email: "kaks@example.com", consent: "on" }))).toEqual({ ok: true });
    expect(await handleSubscribe(deps, form({ email: "vale-aadress" }))).toEqual({ ok: false, errors: { email: "invalid" } });
    const rows = await db.select().from(subscribers);
    expect(rows.map((r) => r.email).sort()).toEqual(["kaks@example.com", "yksi@example.com"]);
    expect(rows.every((r) => r.confirmedAt?.getTime() === NOW.getTime() && r.consentAt.getTime() === NOW.getTime())).toBe(true);
  });

  test("an unconfirmed row of the old flow becomes confirmed with the new consent time and language, keeps its token, and gets the welcome mail", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    const later = new Date("2026-10-02T00:00:00Z");
    await db.insert(subscribers).values({ email: "vana@example.com", locale: "et", token: "v".repeat(43), consentAt: new Date("2026-09-01T00:00:00Z") });
    expect(await signUp({ ...deps, now: later }, "VANA@example.com", "ru")).toEqual({ ok: true });
    const rows = await db.select().from(subscribers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ locale: "ru", token: "v".repeat(43), consentAt: later, confirmedAt: later });
    await flush();
    expect(mails().map((m) => [m.to, m.subject])).toEqual([["vana@example.com", WELCOME_RU]]);
    expect(mails()[0].text).toContain(`/api/newsletter/loobu?t=${"v".repeat(43)}`);
  });

  test("a confirmed address gets the same answer, no change and no e-mail; signing up twice does not mail twice", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    const old = new Date("2026-09-01T00:00:00Z");
    await db.insert(subscribers).values({ email: "tuttav@example.com", locale: "ru", token: "k".repeat(43), consentAt: old, confirmedAt: old });
    expect(await signUp({ ...deps, now: new Date("2026-10-02T00:00:00Z") }, "tuttav@example.com", "et")).toEqual({ ok: true });
    await flush();
    expect(await db.select().from(subscribers)).toMatchObject([{ locale: "ru", consentAt: old, confirmedAt: old }]); // nothing changed, not even the language
    expect(mails()).toEqual([]);
    expect(await db.select().from(mailQuota)).toEqual([]);
    // a new address: signed up twice → one row, one welcome
    await signUp(deps, "uus@example.com");
    await signUp(deps, "UUS@example.com");
    await flush();
    expect(await db.select().from(subscribers)).toHaveLength(2);
    expect(mails().map((m) => m.to)).toEqual(["uus@example.com"]);
  });

  test("at most 3 welcome e-mails per address and day, whatever the IP (an address that unsubscribed and signed up again, its once-a-year mark taken away)", async () => {
    const { mails } = outbox();
    const { deps, kv, flush } = setup({ secrets: true });
    for (let i = 0; i < 5; i++) {
      expect(await signUp({ ...deps, ip: `10.0.0.${i}` })).toEqual({ ok: true });
      await flush();
      await db.delete(subscribers); // unsubscribed again
      for (const key of [...kv.store.keys()]) if (key.startsWith("rl:welcome:")) kv.store.delete(key); // without the mark, only the day's limit speaks
    }
    expect(mails()).toHaveLength(3);
  });

  test("the welcome goes to an address once a year: a row that was lost some other way and comes back gets a row, and no second mail", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    await signUp(deps);
    await flush();
    await db.delete(subscribers);
    expect(await signUp(deps)).toEqual({ ok: true });
    await flush();
    expect(await db.select().from(subscribers)).toHaveLength(1);
    expect(mails()).toHaveLength(1);
  });

  test("sign up, unsubscribe with the button, sign up again: a second welcome mail goes out, with the new row's token and a working link", async () => {
    const { mails } = outbox();
    const { deps, kv, flush } = setup({ secrets: true });
    await signUp(deps);
    await flush();
    const [first] = await db.select().from(subscribers);
    expect(mails()).toHaveLength(1);
    expect(mails()[0].text).toContain(`/api/newsletter/loobu?t=${first.token}`);
    expect(await unsubscribeByToken(db, kv, first.token)).toEqual({ locale: "et" });
    expect(await db.select().from(subscribers)).toEqual([]);
    expect([...kv.store.keys()].filter((k) => k.startsWith("rl:welcome:"))).toEqual([]);
    expect(await signUp(deps)).toEqual({ ok: true });
    await flush();
    const [second] = await db.select().from(subscribers);
    expect(second.token).not.toBe(first.token);
    expect(mails().map((m) => m.to)).toEqual(["uus@example.com", "uus@example.com"]);
    expect(mails()[1].text).toContain(`/api/newsletter/loobu?t=${second.token}`);
    expect(mails()[1].text).not.toContain(first.token);
    // and that link works: the row goes again, the mark with it
    expect(await unsubscribeByToken(db, kv, second.token)).toEqual({ locale: "et" });
    expect(await db.select().from(subscribers)).toEqual([]);
  });

  test("a KV that cannot forget does not fail the unsubscribing: the row is gone, the failure is logged without the address", async () => {
    outbox();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, kv, flush } = setup({ secrets: true });
    await signUp(deps);
    await flush();
    const [sub] = await db.select().from(subscribers);
    const broken = { ...kv, delete: async () => { throw new Error("kv down for uus@example.com"); } };
    expect(await unsubscribeByToken(db, broken, sub.token)).toEqual({ locale: "et" });
    expect(await db.select().from(subscribers)).toEqual([]);
    const logged = error.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("[newsletter] welcome mark not forgotten");
    expect(logged).not.toContain("uus@example.com");
  });

  describe("the newsletter's mail counts against its own daily counter (phase 2c, security)", () => {
    // The newsletter's places are the `mail_quota` row "<day>:nl" (25 a day); the shared row "<day>" is the logins' and the registration and
    // request confirmations' (60 / 30), and a sign-up neither takes from it nor is stopped by it.
    const NL = "2026-10-01:nl";
    const quotaToday = async () => Object.fromEntries((await db.select().from(mailQuota)).map((r) => [r.day, r.sent]));

    test("below the cap a sign-up takes one place of the newsletter's counter, one for each mail", async () => {
      const { mails } = outbox();
      const { deps, flush } = setup({ secrets: true });
      await db.insert(mailQuota).values({ day: NL, sent: NEWSLETTER_MAIL_DAILY_CAP - 2 });
      expect(await signUp(deps)).toEqual({ ok: true });
      await flush();
      expect(await quotaToday()).toEqual({ [NL]: NEWSLETTER_MAIL_DAILY_CAP - 1 });
      expect(await signUp(deps, "teine@example.com")).toEqual({ ok: true });
      await flush();
      expect(await quotaToday()).toEqual({ [NL]: NEWSLETTER_MAIL_DAILY_CAP });
      expect(mails()).toHaveLength(2);
    });

    test("the cap reached: the address is stored (confirmed) and the answer is the same, but no e-mail goes out and no place is taken; the next day has places again", async () => {
      const { mails } = outbox();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { deps, flush } = setup({ secrets: true });
      await db.insert(mailQuota).values({ day: NL, sent: NEWSLETTER_MAIL_DAILY_CAP });
      expect(await signUp(deps)).toEqual({ ok: true });
      await flush();
      expect(await db.select().from(subscribers)).toMatchObject([{ email: "uus@example.com", confirmedAt: NOW }]);
      expect(mails()).toEqual([]);
      expect(await quotaToday()).toEqual({ [NL]: NEWSLETTER_MAIL_DAILY_CAP });
      expect(error).toHaveBeenCalledWith("[newsletter] daily mail cap reached: no welcome e-mail");
      expect(error.mock.calls.flat().join("\n")).not.toContain("uus@example.com");
      // the next day has places again
      expect(await signUp({ ...deps, now: new Date("2026-10-02T10:00:00Z") }, "teine@example.com")).toEqual({ ok: true });
      await flush();
      expect(mails().map((m) => m.to)).toEqual(["teine@example.com"]);
    });

    test("the shared counter full (the logins' 60) does not stop a welcome mail, and the sign-up takes none of its places", async () => {
      const { mails } = outbox();
      const { deps, flush } = setup({ secrets: true });
      await db.insert(mailQuota).values({ day: "2026-10-01", sent: LOGIN_MAIL_DAILY_CAP });
      expect(await signUp(deps)).toEqual({ ok: true });
      await flush();
      expect(mails().map((m) => m.to)).toEqual(["uus@example.com"]);
      expect(await quotaToday()).toEqual({ "2026-10-01": LOGIN_MAIL_DAILY_CAP, [NL]: 1 });
    });

    test("a sample address is stored confirmed, never mailed and takes no place; nor does a deployment without Resend", async () => {
      const { mails } = outbox();
      const { deps, kv, flush } = setup({ secrets: true });
      expect(await signUp(deps, "kati@example.test")).toEqual({ ok: true });
      await flush();
      expect(await db.select().from(subscribers)).toMatchObject([{ email: "kati@example.test", confirmedAt: NOW }]);
      expect(mails()).toEqual([]);
      expect(await quotaToday()).toEqual({});
      expect([...kv.store.keys()].filter((k) => k.startsWith("rl:welcome:") || k.startsWith("rl:confirm:"))).toEqual([]); // not even the address limit counts it
      const bare = setup();
      expect(await signUp(bare.deps, "mari@example.com")).toEqual({ ok: true });
      await bare.flush();
      expect(await db.select().from(subscribers)).toHaveLength(2);
      expect(mails()).toEqual([]);
      expect(await quotaToday()).toEqual({});
    });
  });

  test("the welcome mail goes after the response, not before it", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    expect(await signUp(deps)).toEqual({ ok: true });
    expect(mails()).toEqual([]); // queued, not yet run
    await flush();
    expect(mails()).toHaveLength(1);
  });

  test("confirmSubscriber (the old confirmation links) sets confirmedAt once and says whether this was the first time; unknown or malformed tokens are null", async () => {
    await db.insert(subscribers).values({ email: "vana@example.com", token: "c".repeat(43) });
    const first = await confirmSubscriber(db, "c".repeat(43), new Date("2026-10-03T00:00:00Z"));
    expect(first).toMatchObject({ first: true, sub: { confirmedAt: new Date("2026-10-03T00:00:00Z") } });
    const again = await confirmSubscriber(db, "c".repeat(43), new Date("2026-10-04T00:00:00Z"));
    expect(again).toMatchObject({ first: false, sub: { confirmedAt: new Date("2026-10-03T00:00:00Z") } });
    expect(await confirmSubscriber(db, "x".repeat(43), NOW)).toBeNull();
    expect(await confirmSubscriber(db, "", NOW)).toBeNull();
    expect(await confirmSubscriber(db, "' or 1=1 --", NOW)).toBeNull();
  });
});

describe("confirmation e-mails to the visitor (phase 2a Task 10)", () => {
  const PAY = { receiver: "MS LAB Koolituskeskus OÜ", iban: "ee382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
  const to = <T extends { to: string }>(mails: T[], address: string): T[] => mails.filter((m) => m.to === address);
  const codeOf = (text: string) => /^\d{6}$/m.exec(text)?.[0];
  const tokenOf = (text: string) => /\/api\/konto\/verify\?t=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  const buttons = (html: string | undefined) => (html?.match(/mso-padding-alt/g) ?? []).length;
  const quota = async () => (await db.select().from(mailQuota)).map((r) => r.sent);
  const visitorKeys = (kv: ReturnType<typeof fakeKv>) => [...kv.store.keys()].filter((k) => k.startsWith("rl:visitor-confirm:"));
  const logs = () => (["error", "warn", "info", "log"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));

  afterEach(async () => {
    await db.delete(registrations).where(sql`${registrations.email} like '%@example.test'`);
  });

  test("a registration queues the confirmation with Maria's notification: after the response, in the visitor's language, 'Ava minu konto' with the address pre-filled", async () => {
    const { mails } = outbox();
    const { deps, kv, flush } = setup({ secrets: true });
    expect(await handleRegistration(deps, group({ locale: "et" }))).toEqual({ ok: true });
    expect(mails()).toHaveLength(0); // after the response
    await flush();
    expect(mails()).toHaveLength(2);
    expect(mails()[0].to).toBe("maria@example.com"); // Maria's notification is the first of the two
    const [mail] = to(mails(), "test@example.com");
    expect(mail.subject).toBe("Registreering on vastu võetud — Kulmude baaskoolitus");
    expect(mail.reply_to).toBe("maria@example.com"); // her answer reaches Maria's inbox (e-course completion, spec D8)
    for (const line of ["Tere, Test!", "Registreering on vastu võetud.", "Kulmude baaskoolitus", "14.11.2026 · 10:00", "Pärnu, MS LAB stuudio", "Koht kinnitatakse pärast vähemalt 50% ettemaksu laekumist.", "Ava minu konto:", "https://mslab.example/konto/sisene#email=test%40example.com"])
      expect(mail.text.split("\n"), line).toContain(line);
    // no prepayment setting: Maria sends an invoice
    expect(mail.text).toContain("Maria saadab sulle arve ettemaksu tasumiseks.");
    // one button, to the login page; no login was issued; the mail counted once, against the confirmation cap
    expect(buttons(mail.html)).toBe(1);
    expect(mail.html).toContain(">Ava minu konto</a>");
    expect(mail.text).not.toContain("/api/konto/verify");
    expect(await db.select().from(clientLoginTokens)).toHaveLength(0);
    expect(await quota()).toEqual([1]);
    // the per-address counter: a day, under the hash of the address (never the address itself)
    const [key] = visitorKeys(kv);
    expect(visitorKeys(kv)).toHaveLength(1);
    expect(key).toMatch(/^rl:visitor-confirm:[0-9a-f]{64}$/);
    expect(key).toBe(`rl:visitor-confirm:${await sha256("test@example.com")}`);
    expect(kv.ttl.get(key)).toBe(86400);
  });

  test("with the prepayment instructions: the amount for the choice, the IBAN in groups of four, the reference with the registration's number", async () => {
    const { mails } = outbox();
    await db.insert(settings).values({ key: "prepayment", value: PAY });
    const { deps, flush } = setup({ secrets: true });
    await handleRegistration(deps, group({ locale: "et" })); // half of 390 €
    await flush();
    await handleRegistration(deps, group({ locale: "et", payment: "full", session: String(ids.other) }));
    await flush();
    const rows = (await db.select().from(registrations).where(eq(registrations.email, "test@example.com"))).sort((a, b) => a.id - b.id);
    const [half, full] = to(mails(), "test@example.com");
    for (const line of ["Koha kinnitamiseks tasu ettemaks 195 €.", "Saaja: MS LAB Koolituskeskus OÜ", "IBAN: EE38 2200 2210 2014 5685", "Pank: Swedbank", "Summa: 195 €", `Selgitus: MSLAB-${rows[0].id}`])
      expect(half.text.split("\n"), line).toContain(line);
    expect(full.text.split("\n")).toEqual(expect.arrayContaining(["Koha kinnitamiseks tasu ettemaks 390 €.", "Summa: 390 €", `Selgitus: MSLAB-${rows[1].id}`, "Tartu"]));
    expect(half.text).not.toContain("Maria saadab sulle arve");
  });

  test("Russian registration: the Russian texts and the Russian login page", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    await handleRegistration(deps, group()); // the form's locale is ru
    await flush();
    const [mail] = to(mails(), "test@example.com");
    expect(mail.subject).toBe("Регистрация принята — Kulmude baaskoolitus"); // the course has no Russian title yet
    expect(mail.text).toContain("Мария пришлёт вам счёт для оплаты предоплаты.");
    expect(mail.text).toContain("https://mslab.example/ru/konto/sisene#email=test%40example.com");
    expect(mail.html).toContain('lang="ru"');
  });

  test("'Loo mulle kohe konto' ticked: a login is issued, its code and link are in the e-mail (one button, 'Logi sisse'), and it counts once", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    await handleRegistration(deps, group({ locale: "et", account: "on" }));
    await flush();
    const [mail] = to(mails(), "test@example.com");
    const code = codeOf(mail.text)!;
    const token = tokenOf(mail.text)!;
    expect(code).toMatch(/^\d{6}$/);
    const [row] = await db.select().from(clientLoginTokens);
    expect(row.email).toBe("test@example.com");
    expect(row.hash).toBe(await sha256(token));
    expect(row.expiresAt).toEqual(new Date(NOW.getTime() + 30 * 60_000));
    expect(mail.text).toContain("Kood ja link kehtivad 30 minutit.");
    expect(mail.text).toContain("Kui sa ei palunud sisselogimist, võid selle kirja kustutada.");
    // the small link: the login page at its code step for this address
    expect(mail.text.split("\n")).toEqual(expect.arrayContaining(["Kui nupp ei tööta, sisesta kood siin:", "https://mslab.example/konto/sisene#email=test%40example.com&kood=1"]));
    expect(mail.text).not.toContain("Ava minu konto");
    expect(buttons(mail.html)).toBe(1);
    expect(mail.html).toContain(">Logi sisse</a>");
    expect(mail.html).toContain(">Ava sisselogimine</a>");
    expect(mail.html).not.toContain("Ava minu konto");
    // it is a real login: the code in the mail signs the visitor in, and the registration part is in the mail as well
    expect(mail.text).toContain("Registreering on vastu võetud.");
    expect(await redeemClientCode(db, "test@example.com", code, NOW)).toMatchObject({ isNew: true });
    expect(await quota()).toEqual([1]);
    // Maria's notification still says whether she ticked it
    expect(to(mails(), "maria@example.com")[0].text).toContain("Loo konto: jah");
  });

  test("a Russian registration's login link opens the Russian login page on a failure (&l=ru)", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    await handleRegistration(deps, group({ account: "on" }));
    await flush();
    const [mail] = to(mails(), "test@example.com");
    expect(mail.text).toMatch(/\/api\/konto\/verify\?t=[A-Za-z0-9_-]+&l=ru/);
    expect(mail.text).toContain("https://mslab.example/ru/konto/sisene#email=test%40example.com&kood=1");
  });

  test("the address has its 3 live logins already: the confirmation goes out without a code, counted against the confirmation cap", async () => {
    const { mails } = outbox();
    for (let i = 0; i < 3; i++) expect(await issueClientLogin(db, "test@example.com", NOW)).not.toBeNull();
    const { deps, flush } = setup({ secrets: true });
    await handleRegistration(deps, group({ locale: "et", account: "on" }));
    await flush();
    const [mail] = to(mails(), "test@example.com");
    expect(mail.text).toContain("Ava minu konto:");
    expect(mail.text).not.toContain("/api/konto/verify");
    expect(codeOf(mail.text)).toBeUndefined();
    expect(buttons(mail.html)).toBe(1);
    expect(await db.select().from(clientLoginTokens)).toHaveLength(3);
    expect(await quota()).toEqual([1]);
  });

  describe("caps", () => {
    test("at most 3 confirmations per address and day: the 4th submission is stored and Maria is told, but the visitor gets no 4th mail", async () => {
      const { mails } = outbox();
      const { deps, kv, flush } = setup({ secrets: true });
      for (let i = 0; i < 4; i++) {
        expect(await handleRegistration(deps, group({ locale: "et" }))).toEqual({ ok: true });
        await flush();
      }
      expect(await db.select().from(registrations).where(eq(registrations.email, "test@example.com"))).toHaveLength(4);
      expect(to(mails(), "maria@example.com")).toHaveLength(4);
      expect(to(mails(), "test@example.com")).toHaveLength(3);
      expect(await quota()).toEqual([3]); // a refused 4th reserved nothing
      expect(visitorKeys(kv)).toHaveLength(1);
      // another address (and another form for the same address: the counter is per address) is counted on its own
      await handleRegistration(deps, group({ locale: "et", email: "other@example.com" }));
      await handleWaitlist(deps, form({ session: String(ids.full), name: "T", email: "test@example.com" }));
      await flush();
      expect(to(mails(), "other@example.com")).toHaveLength(1);
      expect(to(mails(), "test@example.com")).toHaveLength(3);
      expect(to(mails(), "maria@example.com")).toHaveLength(6);
      expect(visitorKeys(kv)).toHaveLength(2);
      await db.delete(registrations).where(eq(registrations.email, "other@example.com"));
    });

    test("the per-address counter does not care about case or spaces in the address", async () => {
      const { mails } = outbox();
      const { deps, flush } = setup({ secrets: true });
      for (const email of ["Test@Example.com", " test@example.com ", "TEST@EXAMPLE.COM", "test@example.com"]) {
        await handleRegistration(deps, group({ locale: "et", email }));
        await flush();
      }
      expect(to(mails(), "test@example.com")).toHaveLength(3);
    });

    test("the day's caps: 60 for mails with a login code, 30 for confirmations without one (each is paired with Maria's notification, which is not counted; Resend Free sends 100), and the newsletter's own 25", async () => {
      expect(LOGIN_MAIL_DAILY_CAP).toBe(60);
      expect(CONFIRMATION_MAIL_DAILY_CAP).toBe(30);
      expect(NEWSLETTER_MAIL_DAILY_CAP).toBe(25);
      // the 30th of the day is the last confirmation without a code
      const { mails } = outbox();
      await db.insert(mailQuota).values({ day: "2026-10-01", sent: 30 });
      const { deps, flush } = setup({ secrets: true });
      await handleWaitlist(deps, form({ session: String(ids.full), name: "T", email: "test@example.com" }));
      await flush();
      expect(to(mails(), "test@example.com")).toHaveLength(0);
      expect(await quota()).toEqual([30]);
    });

    test("the confirmation cap (30 a day) stops mails without a code; Maria is still told, the submission is stored, one line is logged", async () => {
      const { mails } = outbox();
      const [error] = logs();
      await db.insert(mailQuota).values({ day: "2026-10-01", sent: CONFIRMATION_MAIL_DAILY_CAP });
      const { deps, flush } = setup({ secrets: true });
      expect(await handleRegistration(deps, group({ locale: "et" }))).toEqual({ ok: true });
      expect(await handlePractice(deps, form({ package: "MINI", name: "T", email: "test@example.com", phone: "+372 5555 5555", times: "õhtuti" }))).toEqual({ ok: true });
      await flush();
      expect(to(mails(), "test@example.com")).toHaveLength(0);
      expect(to(mails(), "maria@example.com")).toHaveLength(2);
      expect(await db.select().from(registrations).where(eq(registrations.email, "test@example.com"))).toHaveLength(1);
      expect(await quota()).toEqual([CONFIRMATION_MAIL_DAILY_CAP]);
      const logged = error.mock.calls.flat().map(String).join("\n");
      expect(logged.match(/\[forms\] (register|practice): daily mail cap reached: no confirmation e-mail to the visitor/g)).toHaveLength(2);
      expect(logged).not.toContain("test@example.com");
    });

    test("one unit below the confirmation cap the mail still goes out and takes the last one", async () => {
      const { mails } = outbox();
      await db.insert(mailQuota).values({ day: "2026-10-01", sent: CONFIRMATION_MAIL_DAILY_CAP - 1 });
      const { deps, flush } = setup({ secrets: true });
      await handleRegistration(deps, group({ locale: "et" }));
      await flush();
      expect(to(mails(), "test@example.com")).toHaveLength(1);
      expect(await quota()).toEqual([CONFIRMATION_MAIL_DAILY_CAP]);
    });

    test("a full newsletter counter does not stop a registration confirmation, with a login code or without, and the confirmation takes none of its places", async () => {
      const { mails } = outbox();
      await db.insert(mailQuota).values({ day: "2026-10-01:nl", sent: NEWSLETTER_MAIL_DAILY_CAP });
      const { deps, flush } = setup({ secrets: true });
      await handleRegistration(deps, group({ locale: "et" }));
      await handleRegistration(deps, group({ locale: "et", account: "on", session: String(ids.other), email: "test@example.com" }));
      await flush();
      expect(to(mails(), "test@example.com")).toHaveLength(2);
      const byDay = Object.fromEntries((await db.select().from(mailQuota)).map((r) => [r.day, r.sent]));
      expect(byDay).toEqual({ "2026-10-01": 2, "2026-10-01:nl": NEWSLETTER_MAIL_DAILY_CAP });
    });

    test("a mail with a login code uses the login cap (60), not the confirmation cap: it goes out at 30..59 and stops at 60", async () => {
      const { mails } = outbox();
      const [error] = logs();
      await db.insert(mailQuota).values({ day: "2026-10-01", sent: CONFIRMATION_MAIL_DAILY_CAP });
      const { deps, flush } = setup({ secrets: true });
      await handleRegistration(deps, group({ locale: "et", account: "on" }));
      await flush();
      const [mail] = to(mails(), "test@example.com");
      expect(codeOf(mail.text)).toMatch(/^\d{6}$/);
      expect(await quota()).toEqual([CONFIRMATION_MAIL_DAILY_CAP + 1]);

      await db.update(mailQuota).set({ sent: LOGIN_MAIL_DAILY_CAP });
      await handleRegistration(deps, group({ locale: "et", account: "on", session: String(ids.other) }));
      await flush();
      expect(to(mails(), "test@example.com")).toHaveLength(1); // none at the login cap, with or without a code
      expect(to(mails(), "maria@example.com")).toHaveLength(2);
      expect(await quota()).toEqual([LOGIN_MAIL_DAILY_CAP]);
      expect(error.mock.calls.flat().map(String).join("\n")).toContain("[forms] register: daily mail cap reached: no confirmation e-mail to the visitor");
    });

    test("the day's counter never fails open: with the quota table gone there is no visitor mail (Maria still gets hers), and the failure is logged without PII", async () => {
      const { mails } = outbox();
      const [error] = logs();
      await db.execute(sql`alter table mail_quota rename to mail_quota_away`);
      try {
        const { deps, flush } = setup({ secrets: true });
        expect(await handleRegistration(deps, group({ locale: "et" }))).toEqual({ ok: true });
        await expect(flush()).resolves.toBeDefined();
        expect(to(mails(), "test@example.com")).toHaveLength(0);
        expect(to(mails(), "maria@example.com")).toHaveLength(1);
        const logged = error.mock.calls.flat().map(String).join("\n");
        expect(logged).toContain("[forms] register: confirmation e-mail failed: DrizzleQueryError (code 42P01)");
        expect(logged).not.toContain("test@example.com");
      } finally {
        await db.execute(sql`alter table mail_quota_away rename to mail_quota`);
      }
    });
  });

  test("a sample address (@example.test) is never mailed: no confirmation, no login, no quota, no counter; Maria is still told", async () => {
    const { mails } = outbox();
    const { deps, kv, flush } = setup({ secrets: true });
    await handleRegistration(deps, group({ email: "Kati+Test@Example.test", account: "on" }));
    await handleIndividual(deps, form({ course: "kulmud", name: "Kati", email: "kati@example.test", phone: "+372 5555 5555", period: "Detsember", account: "on", terms: "on" }));
    await handlePractice(deps, form({ package: "MINI", name: "Kati", email: "kati@example.test", phone: "+372 5555 5555", times: "õhtuti" }));
    await handleWaitlist(deps, form({ session: String(ids.full), name: "Kati", email: "kati@example.test" }));
    await flush();
    expect(mails().map((m) => m.to)).toEqual(["maria@example.com", "maria@example.com", "maria@example.com", "maria@example.com"]);
    expect(await db.select().from(clientLoginTokens)).toHaveLength(0);
    expect(await quota()).toEqual([]);
    expect(visitorKeys(kv)).toEqual([]);
    expect(await db.select().from(registrations).where(eq(registrations.email, "kati+test@example.test"))).toHaveLength(1); // stored all the same
  });

  test("without Resend (local development): stored, nothing sent, and nothing spent: no login, no quota, no counter", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = stubFetch();
    const { deps, kv, flush } = setup();
    expect(await handleRegistration(deps, group({ account: "on", session: String(ids.other) }))).toEqual({ ok: true });
    await flush();
    expect(f.calls).toHaveLength(0);
    expect(info.mock.calls.flat().filter((m) => m === "[notify] RESEND_API_KEY is not set: e-mail skipped")).toHaveLength(2); // Maria's and the visitor's
    expect(await db.select().from(clientLoginTokens)).toHaveLength(0);
    expect(await quota()).toEqual([]);
    expect(visitorKeys(kv)).toEqual([]);
    expect(await db.select().from(registrations).where(eq(registrations.email, "test@example.com"))).toHaveLength(1);
  });

  test("individual request: the short confirmation with the card's sentence and the button; the account box adds a code", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    const fields = { course: "kulmud", name: "Test", email: "test@example.com", phone: "+372 5555 5555", period: "Detsembri teine pool", terms: "on" };
    await handleIndividual(deps, form(fields));
    await flush();
    const [plain] = to(mails(), "test@example.com");
    expect(plain.subject).toBe("Päring on vastu võetud — Kulmude baaskoolitus");
    expect(plain.text.split("\n")).toEqual(expect.arrayContaining(["Päring on saadetud. Maria vastab peagi.", "Kulmude baaskoolitus", "Ava minu konto:", "https://mslab.example/konto/sisene#email=test%40example.com"]));
    expect(plain.text).not.toContain("Maria võtab sinuga ühendust.");
    expect(buttons(plain.html)).toBe(1);
    expect(await db.select().from(clientLoginTokens)).toHaveLength(0);

    await handleIndividual(deps, form({ ...fields, account: "on", locale: "ru" }));
    await flush();
    const withCode = to(mails(), "test@example.com")[1];
    expect(withCode.subject).toBe("Запрос принят — Kulmude baaskoolitus");
    expect(codeOf(withCode.text)).toMatch(/^\d{6}$/);
    expect(withCode.text).toContain("https://mslab.example/ru/konto/sisene#email=test%40example.com&kood=1");
    expect(buttons(withCode.html)).toBe(1);
    expect(await db.select().from(clientLoginTokens)).toHaveLength(1);
    expect(await quota()).toEqual([2]);
  });

  test("practice request and waitlist entry: the short confirmation each, never a code; the waitlist says what its dashboard card says", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    await handlePractice(deps, form({ package: "MINI", name: "Test Õpilane", email: "test@example.com", phone: "+372 5555 5555", times: "Tööpäeva õhtud", locale: "ru" }));
    await handleWaitlist(deps, form({ session: String(ids.full), name: "Test", email: "test@example.com" }));
    await flush();
    const [practice, waitlist] = to(mails(), "test@example.com");
    expect(practice.subject).toBe("Запрос принят — MINI");
    expect(practice.text.split("\n")).toEqual(expect.arrayContaining(["Здравствуйте, Test!", "Запрос отправлен. Мария скоро ответит.", "MINI", "Открыть мой кабинет:", "https://mslab.example/ru/konto/sisene#email=test%40example.com"]));
    expect(waitlist.subject).toBe("Oled ootenimekirjas — Kulmude baaskoolitus");
    expect(waitlist.text.split("\n")).toEqual(expect.arrayContaining(["Oled ootenimekirjas. Anname teada, kui koht vabaneb.", "12.12.2026 · 10:00", "Pärnu, MS LAB stuudio", "Ava minu konto:"]));
    expect(waitlist.text).not.toContain("Maria võtab sinuga ühendust.");
    for (const mail of [practice, waitlist]) expect(buttons(mail.html)).toBe(1);
    expect(await db.select().from(clientLoginTokens)).toHaveLength(0);
    expect(await quota()).toEqual([2]);
  });

  test("a refused or spam submission sends no confirmation and issues no login", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true, ip: "198.51.100.77" });
    expect(await handleRegistration(deps, group({ account: "on", session: String(ids.full) }))).toEqual({ ok: false, errors: { session: "full" } });
    expect(await handleRegistration(deps, group({ account: "on", website: "bot" }))).toEqual({ ok: true }); // honeypot: pretends
    await flush();
    expect(mails()).toHaveLength(0);
    expect(await db.select().from(clientLoginTokens)).toHaveLength(0);
  });

  test("a failing visitor e-mail never fails the submission or Maria's notification; the log holds no address, name or text", async () => {
    const [error, warn, info, log] = logs();
    const f = stubFetch((url, init) =>
      // by the recipient: the visitor's mail names Maria too, as its Reply-To (spec D8)
      url.includes("resend") && !String(init?.body).includes('"to":"maria@example.com"') ? new Response("{}", { status: 500 }) : Response.json({ id: "email_1" }),
    );
    const { deps, flush } = setup({ secrets: true });
    expect(await handleRegistration(deps, group({ locale: "et", account: "on" }))).toEqual({ ok: true });
    await expect(flush()).resolves.toBeDefined();
    expect(f.calls.filter((c) => c.url.includes("resend"))).toHaveLength(2); // Maria's went out, the visitor's was refused
    expect(error.mock.calls.flat().map(String).join("\n")).toContain("[notify] Resend rejected the e-mail");
    expect(await db.select().from(registrations).where(eq(registrations.email, "test@example.com"))).toHaveLength(1);
    const logged = [error, warn, info, log].flatMap((spy) => spy.mock.calls.flat()).map(String).join("\n");
    for (const value of ["test@example.com", "Test Õpilane", "Kulmude", "Koolituskeskus"]) expect(logged).not.toContain(value);
  });

  test("a database failure while issuing the login still sends the confirmation, without the code (and logs only the error class)", async () => {
    const { mails } = outbox();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await db.execute(sql`alter table client_login_tokens rename to client_login_tokens_away`);
    try {
      const { deps, flush } = setup({ secrets: true });
      expect(await handleRegistration(deps, group({ locale: "et", account: "on" }))).toEqual({ ok: true });
      await flush();
      const [mail] = to(mails(), "test@example.com");
      expect(mail.text).toContain("Ava minu konto:");
      expect(mail.text).not.toContain("/api/konto/verify");
      const logged = error.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("[forms] register: login code unavailable, confirmation without it: DrizzleQueryError (code 42P01)");
      expect(logged).not.toContain("test@example.com");
    } finally {
      await db.execute(sql`alter table client_login_tokens_away rename to client_login_tokens`);
    }
    expect(await quota()).toEqual([1]); // a mail without a code: the confirmation cap
  });

  test("the content is read before anything is spent: with the settings table gone nothing is issued or counted, the error is logged, Maria is still told, the submission stays stored", async () => {
    const { mails } = outbox();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, flush } = setup({ secrets: true });
    // stored first, with its contract (contracts, Task 4: the submit reads the contract's text and the school from the settings, and a
    // registration never stands without its contract); the table goes away before the work after the answer reads the confirmation's content
    expect(await handleRegistration(deps, group({ locale: "et", account: "on" }))).toEqual({ ok: true });
    await db.execute(sql`alter table settings rename to settings_away`);
    try {
      await expect(flush()).resolves.toBeDefined();
      expect(to(mails(), "maria@example.com")).toHaveLength(1);
      expect(to(mails(), "test@example.com")).toHaveLength(0);
      expect(error.mock.calls.flat().map(String).join("\n")).toContain("[forms] register: confirmation e-mail failed: DrizzleQueryError (code 42P01)");
    } finally {
      await db.execute(sql`alter table settings_away rename to settings`);
    }
    expect(await db.select().from(clientLoginTokens)).toHaveLength(0); // no login row burnt
    expect(await quota()).toEqual([]); // no quota unit burnt
    expect(await db.select().from(registrations).where(eq(registrations.email, "test@example.com"))).toHaveLength(1);
  });
});

describe("the newsletter consent on the registration forms (phase 2c)", () => {
  const groupFields = (email: string, extra: Record<string, string> = {}) => ({
    course: "kulmud", session: String(s.id), name: "Kati Tamm", email, phone: "+372 5555 5555", payment: "full", terms: "on", locale: "et", contractVersion, ...extra,
  });
  const WELCOME_SUBJECT = "Tere tulemast MS LABi!";
  const newsletterMails = (mails: { to: string; subject: string }[], to: string) => mails.filter((m) => m.to === to && m.subject === WELCOME_SUBJECT);

  beforeEach(async () => {
    await db.delete(settings).where(eq(settings.key, "newsletter"));
  });

  test("ticked on a group registration: the registration is stored, then a confirmed subscriber and the welcome mail with the unsubscribe link; the message is kept", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    expect(await handleRegistration(deps, form(groupFields("nl-reg@example.com", { newsletter: "on", message: "Kood TERE10" })))).toEqual({ ok: true });
    await flush();
    const [reg] = await db.select().from(registrations).where(eq(registrations.email, "nl-reg@example.com"));
    expect(reg.message).toBe("Kood TERE10");
    const [sub] = await db.select().from(subscribers).where(eq(subscribers.email, "nl-reg@example.com"));
    expect(sub).toMatchObject({ locale: "et", confirmedAt: NOW, consentAt: NOW });
    const sent = mails().filter((m) => m.to === "nl-reg@example.com");
    expect(sent.map((m) => m.subject)).toContain(WELCOME_SUBJECT);
    expect(sent.map((m) => m.subject)).not.toContain("Kinnita MS LABi uudiskirjaga liitumine");
    expect(sent.find((m) => m.subject === WELCOME_SUBJECT)?.text).toContain(`/api/newsletter/loobu?t=${sub.token}`);
  });

  test("not ticked: no subscriber; an address already confirmed: nothing new; on the waitlist and the purchase wish too", async () => {
    const { deps, flush } = setup({ secrets: true });
    outbox();
    await handleRegistration(deps, form(groupFields("nl-none@example.com")));
    await db.insert(subscribers).values({ email: "nl-done@example.com", token: "d1", confirmedAt: NOW });
    await handleWaitlist(deps, form({ session: String(ids.full), name: "Kati", email: "nl-done@example.com", locale: "et", newsletter: "on" }));
    await handlePurchaseInterest(deps, form({ course: "e-kulmud", email: "nl-cart@example.com", locale: "ru", newsletter: "on" }));
    await flush();
    const rows = await db.select({ email: subscribers.email, locale: subscribers.locale, confirmed: subscribers.confirmedAt }).from(subscribers);
    expect(rows.map((r) => r.email).sort()).toEqual(["nl-cart@example.com", "nl-done@example.com"]);
    expect(rows.find((r) => r.email === "nl-cart@example.com")).toMatchObject({ locale: "ru", confirmed: NOW });
  });

  test("a failure of the sign-up never fails the registration (it runs after the answer, and is only logged)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, flush } = setup();
    await db.execute(sql`alter table subscribers rename to subscribers_away`);
    try {
      expect(await handleRegistration(deps, form(groupFields("nl-fail@example.com", { newsletter: "on" })))).toEqual({ ok: true });
      await flush();
      const logged = errors.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("[forms] register: newsletter sign-up failed: DrizzleQueryError (code 42P01)");
      expect(logged).not.toContain("nl-fail@example.com"); // the log line holds the error class and code, never the address
      expect(logged).not.toContain("example.com");
    } finally {
      await db.execute(sql`alter table subscribers_away rename to subscribers`);
    }
    expect(await db.select().from(registrations).where(eq(registrations.email, "nl-fail@example.com"))).toHaveLength(1);
  });

  test("a sample address (@example.test) ticked: its confirmed row, and no mail and no quota (as the forms' own confirmations)", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    expect(await handleRegistration(deps, form(groupFields("nl-sample@example.test", { newsletter: "on" })))).toEqual({ ok: true });
    await flush();
    expect(await db.select({ email: subscribers.email, confirmed: subscribers.confirmedAt }).from(subscribers)).toEqual([{ email: "nl-sample@example.test", confirmed: NOW }]);
    expect(mails().filter((m) => m.to === "nl-sample@example.test")).toEqual([]);
  });

  // The registration forms' box and the newsletter's own forms share one sign-up (subscribeAddress), so its four guards hold for both.
  describe("the sign-up's guards hold for the registration forms' box too", () => {
    const quota = async () => (await db.select().from(mailQuota)).map((r) => [r.day, r.sent]);

    const NL = "2026-10-01:nl";
    const quotaMap = async () => Object.fromEntries((await db.select().from(mailQuota)).map((r) => [r.day, r.sent]));

    test("the newsletter's cap reached: the subscriber is stored (confirmed), no welcome mail goes out and no place is taken", async () => {
      const { mails } = outbox();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { deps, flush } = setup({ secrets: true });
      await db.insert(mailQuota).values({ day: NL, sent: NEWSLETTER_MAIL_DAILY_CAP });
      expect(await handleRegistration(deps, form(groupFields("nl-cap@example.com", { newsletter: "on" })))).toEqual({ ok: true });
      await flush();
      expect(await db.select().from(registrations).where(eq(registrations.email, "nl-cap@example.com"))).toHaveLength(1);
      expect(await db.select({ email: subscribers.email, confirmed: subscribers.confirmedAt }).from(subscribers)).toEqual([{ email: "nl-cap@example.com", confirmed: NOW }]);
      expect(newsletterMails(mails(), "nl-cap@example.com")).toEqual([]);
      expect(mails().filter((m) => m.to === "nl-cap@example.com")).toHaveLength(1); // the registration's own confirmation is not stopped by it
      expect(await quotaMap()).toEqual({ "2026-10-01": 1, [NL]: NEWSLETTER_MAIL_DAILY_CAP });
      expect(error).toHaveBeenCalledWith("[newsletter] daily mail cap reached: no welcome e-mail");
    });

    test("below the cap the newsletter mail takes a place of the newsletter's counter, the waitlist confirmation one of the shared counter", async () => {
      const { mails } = outbox();
      const { deps, flush } = setup({ secrets: true });
      await db.insert(mailQuota).values({ day: NL, sent: NEWSLETTER_MAIL_DAILY_CAP - 2 });
      expect(await handleWaitlist(deps, form({ session: String(ids.full), name: "Kati", email: "nl-wait@example.com", locale: "et", newsletter: "on" }))).toEqual({ ok: true });
      await flush();
      expect(newsletterMails(mails(), "nl-wait@example.com")).toHaveLength(1);
      expect(await quotaMap()).toEqual({ "2026-10-01": 1, [NL]: NEWSLETTER_MAIL_DAILY_CAP - 1 });
    });

    test("at most 3 welcome mails per address and day, however the sign-ups came (the address unsubscribing in between, its once-a-year mark taken away)", async () => {
      const { mails } = outbox();
      const { deps, kv, flush } = setup({ secrets: true });
      const forget = async () => {
        await db.delete(subscribers);
        for (const key of [...kv.store.keys()]) if (key.startsWith("rl:welcome:")) kv.store.delete(key);
      };
      for (let i = 0; i < 2; i++) {
        await handleSubscribe({ ...deps, ip: `10.0.1.${i}` }, form({ email: "nl-many@example.com", locale: "et" }));
        await flush();
        await forget();
      }
      expect(await handleRegistration(deps, form(groupFields("nl-many@example.com", { newsletter: "on" })))).toEqual({ ok: true });
      await flush();
      await forget();
      expect(await handleRegistration(deps, form(groupFields("nl-many@example.com", { newsletter: "on" })))).toEqual({ ok: true }); // the 4th
      await flush();
      expect(newsletterMails(mails(), "nl-many@example.com")).toHaveLength(3);
      expect(await db.select().from(subscribers)).toHaveLength(1);
    });

    test("a deployment without Resend (local development): the row is stored, nothing is sent, nothing is counted", async () => {
      const { mails } = outbox();
      const { deps, flush } = setup();
      expect(await handleRegistration(deps, form(groupFields("nl-dev@example.com", { newsletter: "on" })))).toEqual({ ok: true });
      await flush();
      expect(await db.select({ email: subscribers.email }).from(subscribers)).toEqual([{ email: "nl-dev@example.com" }]);
      expect(mails()).toEqual([]);
      expect(await quota()).toEqual([]);
    });

    test("the shared counter at its last place does not cost the newsletter its mail: the registration's confirmation takes that place and goes first, then the newsletter's own counter is asked", async () => {
      const { mails } = outbox();
      // the visitor confirmation's own counter is the slow store here, as it can be on a bad day: the two mails still go in this order
      const kv = fakeKv({ "tg:chat": "42" });
      const get = kv.get;
      kv.get = async (key: string) => {
        if (key.startsWith("rl:visitor-confirm:")) await new Promise((resolve) => setTimeout(resolve, 60));
        return get(key);
      };
      const { deps, flush } = setup({ secrets: true, kv });
      await db.insert(mailQuota).values({ day: "2026-10-01", sent: CONFIRMATION_MAIL_DAILY_CAP - 1 });
      expect(await handleRegistration(deps, form(groupFields("nl-last@example.com", { newsletter: "on" })))).toEqual({ ok: true });
      await flush();
      expect(mails().filter((m) => m.to === "nl-last@example.com").map((m) => m.subject)).toEqual(["Registreering on vastu võetud — Kulmude baaskoolitus", WELCOME_SUBJECT]);
      expect(await db.select({ email: subscribers.email, confirmed: subscribers.confirmedAt }).from(subscribers)).toEqual([{ email: "nl-last@example.com", confirmed: NOW }]);
      expect(await quotaMap()).toEqual({ "2026-10-01": CONFIRMATION_MAIL_DAILY_CAP, [NL]: 1 });
    });
  });

  test("the confirmation's own work throwing (not only failing quietly) cannot skip the newsletter sign-up: it is logged without the address and the sign-up still runs", async () => {
    const { mails } = outbox();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = setup({ secrets: true });
    const tasks: (() => Promise<unknown>)[] = [];
    const queued = { ...deps, later: (task: () => Promise<unknown>) => void tasks.push(task) };
    expect(await handleRegistration(queued, form(groupFields("nl-throw@example.com", { newsletter: "on" })))).toEqual({ ok: true });
    expect(tasks).toHaveLength(2); // Maria's notification, then the visitor's confirmation and the sign-up as one task
    // The first look at the Resend key (sendConfirmation's own, before its try) throws, as a bug there one day might; the later ones do not.
    let armed = true;
    Object.defineProperty(queued.env, "RESEND_API_KEY", {
      get() {
        if (!armed) return "re_test";
        armed = false;
        throw new Error("boom nl-throw@example.com");
      },
    });
    await expect(tasks[1]()).resolves.toBeUndefined();
    expect(await db.select({ email: subscribers.email, confirmed: subscribers.confirmedAt }).from(subscribers)).toEqual([{ email: "nl-throw@example.com", confirmed: NOW }]);
    expect(newsletterMails(mails(), "nl-throw@example.com")).toHaveLength(1);
    const logged = error.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("[forms] register: confirmation e-mail task failed: Error");
    expect(logged).not.toContain("nl-throw@example.com");
  });

  test("the individual request: the sign-up follows in the visitor's language, and the stored request does not carry the box", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    expect(await handleIndividual(deps, form({ course: "kulmud", name: "Kati", email: "nl-ind@example.com", phone: "+372 5555 5555", period: "detsember", terms: "on", locale: "ru", newsletter: "on" }))).toEqual({ ok: true });
    await flush();
    expect(await db.select({ email: subscribers.email, locale: subscribers.locale, confirmed: subscribers.confirmedAt }).from(subscribers)).toEqual([{ email: "nl-ind@example.com", locale: "ru", confirmed: NOW }]);
    expect(mails().filter((m) => m.to === "nl-ind@example.com" && m.subject === "Добро пожаловать в\u00a0MS LAB!")).toHaveLength(1);
    expect(mails().filter((m) => m.to === "nl-ind@example.com" && m.subject === "Подтвердите подписку на рассылку MS LAB")).toHaveLength(0);
    const [row] = await db.select().from(requests);
    expect(row.payload).not.toHaveProperty("wantsNewsletter");
  });

  test("Maria's notification of a group registration shows the message; without one, no 'Sõnum' line", async () => {
    const { mails } = outbox();
    const { deps, flush } = setup({ secrets: true });
    await handleRegistration(deps, form(groupFields("nl-msg@example.com", { message: "Kood TERE10" })));
    await handleRegistration(deps, form(groupFields("nl-nomsg@example.com")));
    await flush();
    const maria = mails().filter((m) => m.to === "maria@example.com");
    expect(maria.find((m) => m.text.includes("nl-msg@example.com"))?.text).toContain("Sõnum:\nKood TERE10");
    expect(maria.find((m) => m.text.includes("nl-nomsg@example.com"))?.text).not.toContain("Sõnum");
  });
});

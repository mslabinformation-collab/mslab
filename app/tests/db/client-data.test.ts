import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Db } from "@/db/client";
import {
  clientFavourites, clientLoginTokens, clients, clientSessions, courseAccess, courses, courseSessions, pages, practicePackages, registrations, requests, settings,
  lessonProgress, lessons, subscribers, termsAcceptances,
} from "@/db/schema";
import { nextStep, parsePrepayment } from "@/domain/account-cards";
import {
  acceptTerms, courseTermsVersion, createChangeRequest, deleteClient, favouriteSlugs, loadDashboard, loadEcourse, mergeFavourites,
  setFavourite, setNewsletter, updateProfile,
} from "@/server/client-data";
import { issueClientLogin, redeemClientCode, redeemClientLink } from "@/server/client-auth";
import { loadSettings, saveSettingsForm } from "@/server/admin-site";
import { addModules, makeTestDb } from "./helpers";

// What a client sees and may change (server/client-data.ts) against a real (PGlite) database. Every address is `@example.test`.

const NOW = new Date("2026-10-03T10:00:00Z");
const day = 86_400_000;
const at = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * day);

let db: Db;
beforeAll(async () => {
  db = await makeTestDb();
});

const TABLES = [termsAcceptances, clientFavourites, courseAccess, clientSessions, registrations, requests, subscribers, clients, courseSessions, courses, settings, pages, practicePackages] as const;

type Fixtures = Awaited<ReturnType<typeof seed>>;
let f: Fixtures;

const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };

/** Courses: a published contact course (group 350 €, individual 450 €), a draft contact course, two e-courses (one a draft), and their sessions. */
async function seed() {
  const [lami] = await db.insert(courses).values({
    ...base, slug: "kulmude-lami", type: "contact", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" }, published: true, priceGroup: 35000, priceIndividual: 45000,
  }).returning();
  const [draft] = await db.insert(courses).values({ ...base, slug: "ootel", type: "contact", title: { et: "Veel peidus" }, published: false, priceGroup: 10000 }).returning();
  const [online] = await db.insert(courses).values({
    ...base, slug: "veebikursus", type: "e_learning", title: { et: "Veebikursus" }, published: true, price: 9500, accessMonths: 6,
  }).returning();
  await addModules(db, online.id, [{ et: "Sissejuhatus" }, { et: "Praktika", ru: "Практика" }]);
  const [hiddenOnline] = await db.insert(courses).values({ ...base, slug: "peidus-kursus", type: "e_learning", title: { et: "Peidus kursus" }, published: false, price: 5000 }).returning();
  const session = async (courseId: number, startsAt: Date, over: Partial<typeof courseSessions.$inferInsert> = {}) =>
    (await db.insert(courseSessions).values({ courseId, startsAt, city: "Pärnu", venue: "Salong", ...over }).returning())[0];
  return {
    lami, draft, online, hiddenOnline,
    soon: await session(lami.id, at(30)),
    later: await session(lami.id, at(60), { city: "Tartu" }),
    mid: await session(lami.id, at(50)),
    past: await session(lami.id, at(-20)),
    called: await session(lami.id, at(45), { status: "cancelled" }),
    draftSession: await session(draft.id, at(40)),
  };
}

beforeEach(async () => {
  for (const table of TABLES) await db.delete(table);
  f = await seed();
});

async function client(email = "kati@example.test", over: Partial<typeof clients.$inferInsert> = {}) {
  return (await db.insert(clients).values({ email, ...over }).returning())[0];
}

type RegOver = Partial<typeof registrations.$inferInsert>;
async function register(clientId: number | null, courseId: number, courseSessionId: number | null, over: RegOver = {}) {
  return (await db.insert(registrations).values({
    courseId, courseSessionId, kind: "group", name: "Kati Tamm", email: "kati@example.test", phone: "+3725551234", paymentChoice: "full", clientId, ...over,
  }).returning())[0];
}

async function request(clientId: number | null, kind: typeof requests.$inferInsert["kind"], payload: Record<string, string | number | boolean>, over: Partial<typeof requests.$inferInsert> = {}) {
  return (await db.insert(requests).values({ kind, payload, clientId, ...over }).returning())[0];
}

const grant = async (clientId: number, courseId: number, over: Partial<typeof courseAccess.$inferInsert> = {}) =>
  (await db.insert(courseAccess).values({ clientId, courseId, grantedBy: "admin@example.test", grantedAt: at(-10), expiresAt: at(170), ...over }).returning())[0];

const setting = (key: string, value: unknown) => db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });

describe("loadDashboard", () => {
  test("lists the client's registrations, requests (waitlist included) and e-course access; open ones soonest session first, then undated open ones, over cards last", async () => {
    const kati = await client();
    const soon = await register(kati.id, f.lami.id, f.soon.id, { status: "confirmed", paidCents: 17500, paymentChoice: "half" });
    const later = await register(kati.id, f.lami.id, f.later.id);
    const past = await register(kati.id, f.lami.id, f.past.id, { status: "confirmed", paidCents: 35000 });
    const cancelled = await register(kati.id, f.lami.id, f.later.id, { status: "cancelled" });
    const individual = await register(kati.id, f.lami.id, null, { kind: "individual", preferredPeriod: "novembri lõpp", createdAt: at(-1) });
    await db.insert(practicePackages).values({ code: "MINI", name: { et: "Mini pakett", ru: "Мини пакет" }, tagline: { et: "" }, models: 2, durationLabel: { et: "2 h" }, price: 5000 });
    const practice = await request(kati.id, "practice", { package: "MINI", course: "kulmude-lami", times: "E ja K õhtuti", email: "kati@example.test" }, { createdAt: at(-3) });
    const wait = await request(kati.id, "waitlist", { session: f.mid.id, course: "kulmude-lami", email: "kati@example.test" }, { createdAt: at(-2) });
    const individualRequest = await request(kati.id, "individual", { course: "kulmude-lami", preferredPeriod: "jaanuar", message: "ei kuulu kaardile", email: "kati@example.test" }, { createdAt: at(-1), handled: true });
    await grant(kati.id, f.online.id);

    const dash = (await loadDashboard(db, kati.id, NOW))!;
    expect(dash.client).toEqual({ email: "kati@example.test", name: "", phone: "", locale: "et", newsletter: false, passwordSetAt: null });
    expect(dash.favourites).toEqual([]);
    expect(dash.prepayment).toBeNull();

    // open ones with a date, the soonest first; then open ones without a date, the newest first (made or granted); over ones, the most recent first
    const order = dash.cards.map((c) => (c.kind === "contact" || c.kind === "individual" ? `reg${c.registrationId}` : c.kind === "ecourse" ? `course:${c.course.slug}` : `req${c.requestId}`));
    expect(order).toEqual([
      `reg${soon.id}`, // session in 30 days
      `req${wait.id}`, // waitlist for the session in 50 days
      `reg${later.id}`, // session in 60 days
      `reg${individual.id}`, // no date: made yesterday
      `req${practice.id}`, // no date: made 3 days ago
      `course:veebikursus`, // no date: granted 10 days ago
      // over: the cancelled registration (its session is in 60 days), the handled request (yesterday), the past session (20 days ago)
      `reg${cancelled.id}`,
      `req${individualRequest.id}`,
      `reg${past.id}`,
    ]);
  });

  test("a contact registration card carries its course, session, status, payment and the price it is measured by", async () => {
    const kati = await client();
    const reg = await register(kati.id, f.lami.id, f.soon.id, { status: "confirmed", paidCents: 17500, paymentChoice: "half" });
    const { cards } = (await loadDashboard(db, kati.id, NOW))!;
    expect(cards).toEqual([
      {
        kind: "contact", registrationId: reg.id, course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } },
        session: { startsAt: f.soon.startsAt.toISOString(), city: "Pärnu", venue: "Salong", cancelled: false },
        status: "confirmed", paymentChoice: "half", priceCents: 35000, paidCents: 17500, createdAt: reg.createdAt.toISOString(),
        contract: null, contractRequested: false,
      },
    ]);
    // the cards feed nextStep as they are (they are the JSON the endpoint sends)
    expect(nextStep(cards[0], NOW, null).key).toBe("confirmedRest");
  });

  test("an individual-kind registration with a session is measured by the individual price; a called-off session is marked", async () => {
    const kati = await client();
    await register(kati.id, f.lami.id, f.soon.id, { kind: "individual" });
    await register(kati.id, f.lami.id, f.called.id, { status: "confirmed" });
    const { cards } = (await loadDashboard(db, kati.id, NOW))!;
    const byDate = Object.fromEntries(cards.map((c) => [c.kind === "contact" ? c.session.startsAt : "", c]));
    expect(byDate[f.soon.startsAt.toISOString()]).toMatchObject({ priceCents: 45000 });
    expect(byDate[f.called.startsAt.toISOString()]).toMatchObject({ session: { cancelled: true } });
    expect(nextStep(byDate[f.called.startsAt.toISOString()], NOW, null).key).toBe("cancelled");
  });

  test("a registration without a session is an individual card; one for a course that is not published still shows", async () => {
    const kati = await client();
    const reg = await register(kati.id, f.lami.id, null, { kind: "individual", preferredPeriod: "jaanuar" });
    const draftReg = await register(kati.id, f.draft.id, f.draftSession.id);
    const { cards } = (await loadDashboard(db, kati.id, NOW))!;
    expect(cards.find((c) => c.kind === "individual")).toMatchObject({ registrationId: reg.id, preferredPeriod: "jaanuar", status: "awaiting_prepayment", course: { slug: "kulmude-lami" } });
    expect(cards.find((c) => c.kind === "contact")).toMatchObject({ registrationId: draftReg.id, course: { slug: "ootel" }, priceCents: 10000 });
  });

  test("a request's card names the course or practice package and what was asked; a waitlist card its session", async () => {
    const kati = await client();
    await db.insert(practicePackages).values({ code: "MINI", name: { et: "Mini pakett", ru: "Мини пакет" }, tagline: { et: "" }, models: 2, durationLabel: { et: "2 h" }, price: 5000 });
    // a practice request's own "course" field is free text: it must not be matched against course slugs
    const practice = await request(kati.id, "practice", { package: "MINI", course: "kulmude-lami", times: "E ja K õhtuti", email: "kati@example.test" });
    const individual = await request(kati.id, "individual", { course: "kulmude-lami", preferredPeriod: "jaanuar", message: "salajane", email: "kati@example.test" });
    const wait = await request(kati.id, "waitlist", { session: f.later.id, course: "kulmude-lami", email: "kati@example.test" });
    const cards = (await loadDashboard(db, kati.id, NOW))!.cards;
    expect(cards.find((c) => c.kind === "request" && c.requestId === practice.id)).toEqual({
      kind: "request", requestId: practice.id, requestKind: "practice", title: { et: "Mini pakett", ru: "Мини пакет" }, detail: "E ja K õhtuti", handled: false, createdAt: practice.createdAt.toISOString(),
    });
    expect(cards.find((c) => c.kind === "request" && c.requestId === individual.id)).toEqual({
      kind: "request", requestId: individual.id, requestKind: "individual", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" }, detail: "jaanuar", handled: false, createdAt: individual.createdAt.toISOString(),
    });
    expect(JSON.stringify(cards)).not.toContain("salajane"); // the message stays out of the card
    expect(cards.find((c) => c.kind === "waitlist")).toEqual({
      kind: "waitlist", requestId: wait.id, course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } },
      session: { startsAt: f.later.startsAt.toISOString(), city: "Tartu", venue: "Salong", cancelled: false }, handled: false, createdAt: wait.createdAt.toISOString(),
    });
  });

  test("a waitlist card knows when Maria has dealt with it and when its date was called off; the sentences follow", async () => {
    const kati = await client();
    const open = await request(kati.id, "waitlist", { session: f.later.id, course: "kulmude-lami" });
    const handled = await request(kati.id, "waitlist", { session: f.later.id, course: "kulmude-lami" }, { handled: true });
    const called = await request(kati.id, "waitlist", { session: f.called.id, course: "kulmude-lami" });
    const { cards } = (await loadDashboard(db, kati.id, NOW))!;
    const card = (id: number) => cards.find((c) => c.kind === "waitlist" && c.requestId === id)!;
    expect(card(handled.id)).toMatchObject({ handled: true, session: { cancelled: false } });
    expect(card(called.id)).toMatchObject({ handled: false, session: { cancelled: true } });
    expect([open, handled, called].map((r) => nextStep(card(r.id), NOW, null).key)).toEqual(["waitlist", "requestDone", "cancelled"]);
    // the open one first, then the over ones by their date, the later first (the handled one's date is in 60 days, the called-off one's in 45)
    expect(cards.map((c) => c.kind === "waitlist" && c.requestId)).toEqual([open.id, handled.id, called.id]);
  });

  test("a request whose payload points nowhere (no such session, a session that is not a number, a course that is gone) still shows, and the query does not fail", async () => {
    const kati = await client();
    await request(kati.id, "waitlist", { session: "abc", course: "olematu" });
    await request(kati.id, "waitlist", { session: 999999, course: "kulmude-lami" });
    await request(kati.id, "waitlist", { session: "99999999999999", course: "kulmude-lami" }); // too many digits for the id column
    await request(kati.id, "individual", { course: "olematu", preferredPeriod: "x" });
    await request(kati.id, "practice", { package: "XXL", times: "y" });
    const cards = (await loadDashboard(db, kati.id, NOW))!.cards;
    expect(cards).toHaveLength(5);
    expect(cards.filter((c) => c.kind === "waitlist").map((c) => c.kind === "waitlist" && c.session)).toEqual([null, null, null]);
    expect(cards.filter((c) => c.kind === "request").map((c) => c.kind === "request" && c.title)).toEqual([null, null]);
  });

  test("text on a request card is cut at 200 characters", async () => {
    const kati = await client();
    await request(kati.id, "individual", { course: "kulmude-lami", preferredPeriod: "x".repeat(500) });
    const [card] = (await loadDashboard(db, kati.id, NOW))!.cards;
    expect(card.kind === "request" && card.detail).toHaveLength(200);
  });

  test("contact messages and change requests are not cards", async () => {
    const kati = await client();
    const reg = await register(kati.id, f.lami.id, f.soon.id);
    await request(kati.id, "contact", { name: "Kati", message: "Tere", email: "kati@example.test" });
    await request(kati.id, "contact", { course: "veebikursus", intent: "purchase", email: "kati@example.test" });
    await request(kati.id, "change_request", { registrationId: reg.id, kind: "cancel", message: "", email: "kati@example.test" });
    expect((await loadDashboard(db, kati.id, NOW))!.cards.map((c) => c.kind)).toEqual(["contact"]);
  });

  test("only the client's own records: another client's, and ones not linked to anybody, are not shown", async () => {
    const kati = await client();
    const mari = await client("mari@example.test");
    await register(mari.id, f.lami.id, f.soon.id, { name: "Mari" });
    await register(null, f.lami.id, f.soon.id, { email: "kati@example.test" }); // the same address, but not linked (linking is the login's job)
    await request(mari.id, "practice", { package: "MINI", times: "x" });
    await request(null, "individual", { course: "kulmude-lami", preferredPeriod: "x", email: "kati@example.test" });
    await grant(mari.id, f.online.id);
    await db.insert(clientFavourites).values({ clientId: mari.id, courseId: f.lami.id });
    const dash = (await loadDashboard(db, kati.id, NOW))!;
    expect(dash.cards).toEqual([]);
    expect(dash.favourites).toEqual([]);
    expect((await loadDashboard(db, mari.id, NOW))!.cards).toHaveLength(3);
  });

  test("e-course access: active, expired and revoked are cards (the sentence differs), also for a course that is no longer published", async () => {
    const kati = await client();
    const second = await db.insert(courses).values({ ...base, slug: "teine-kursus", type: "e_learning", title: { et: "Teine" }, published: true, price: 100 }).returning();
    const third = await db.insert(courses).values({ ...base, slug: "kolmas-kursus", type: "e_learning", title: { et: "Kolmas" }, published: true, price: 100 }).returning();
    await grant(kati.id, f.online.id);
    await grant(kati.id, second[0].id, { expiresAt: at(-1), grantedAt: at(-30) });
    await grant(kati.id, third[0].id, { revokedAt: at(-5), grantedAt: at(-20) });
    await grant(kati.id, f.hiddenOnline.id, { grantedAt: at(-5) }); // the course was unpublished after the access was granted: the access stays
    const { cards } = (await loadDashboard(db, kati.id, NOW))!;
    // open ones newest grant first, then over ones the most recent first
    expect(cards.map((c) => c.kind === "ecourse" && c.course.slug)).toEqual(["peidus-kursus", "veebikursus", "kolmas-kursus", "teine-kursus"]);
    expect(cards.map((c) => nextStep(c, NOW, null).key)).toEqual(["openCourse", "openCourse", "accessEnded", "accessEnded"]);
    expect(cards[1]).toEqual({ kind: "ecourse", course: { slug: "veebikursus", title: { et: "Veebikursus" } }, grantedAt: at(-10).toISOString(), expiresAt: at(170).toISOString(), revoked: false, progress: null, completedAt: null, certificateId: null, contract: null, contractRequested: false });
    expect(cards[2]).toMatchObject({ revoked: true });
  });

  test("favourites are the published courses the client hearted, newest first; the profile and newsletter flag are the client's", async () => {
    const kati = await client("kati@example.test", { name: "Kati", phone: "+3725551234", locale: "ru" });
    await db.insert(clientFavourites).values([
      { clientId: kati.id, courseId: f.lami.id, createdAt: at(-5) },
      { clientId: kati.id, courseId: f.draft.id, createdAt: at(-4) }, // unpublished: left out
      { clientId: kati.id, courseId: f.online.id, createdAt: at(-1) },
    ]);
    await db.insert(subscribers).values({ email: "Kati@Example.TEST", token: "t1", confirmedAt: at(-2) }); // stored in another case
    const dash = (await loadDashboard(db, kati.id, NOW))!;
    expect(dash.favourites).toEqual(["veebikursus", "kulmude-lami"]);
    expect(dash.client).toEqual({ email: "kati@example.test", name: "Kati", phone: "+3725551234", locale: "ru", newsletter: true, passwordSetAt: null });
  });

  test("a subscriber still waiting for confirmation is not 'on'", async () => {
    const kati = await client();
    await db.insert(subscribers).values({ email: "kati@example.test", token: "t1" });
    expect((await loadDashboard(db, kati.id, NOW))!.client.newsletter).toBe(false);
  });

  test("the prepayment setting: the strings of the instructions, null when unset or empty", async () => {
    const kati = await client();
    expect((await loadDashboard(db, kati.id, NOW))!.prepayment).toBeNull();
    await setting("prepayment", { receiver: "", iban: "", bank: "", referencePrefix: "" });
    expect((await loadDashboard(db, kati.id, NOW))!.prepayment).toBeNull();
    await setting("prepayment", { receiver: " MS LAB OÜ ", iban: "EE00 0000 0000 0000 0000", bank: "Pank", referencePrefix: "MS", extra: "x" });
    expect((await loadDashboard(db, kati.id, NOW))!.prepayment).toEqual({ receiver: "MS LAB OÜ", iban: "EE00 0000 0000 0000 0000", bank: "Pank", referencePrefix: "MS" });
  });

  test("parsePrepayment tolerates anything stored there", () => {
    expect(parsePrepayment(null)).toBeNull();
    expect(parsePrepayment("EE00")).toBeNull();
    expect(parsePrepayment([{ iban: "EE00" }])).toBeNull();
    expect(parsePrepayment({ iban: 5, bank: null })).toBeNull();
    expect(parsePrepayment({ iban: "EE00", bank: 7 })).toEqual({ receiver: "", iban: "EE00", bank: "", referencePrefix: "" });
  });

  test("a client that is gone: null", async () => {
    expect(await loadDashboard(db, 987654, NOW)).toBeNull();
  });
});

describe("favourites", () => {
  test("setFavourite hearts and un-hearts a published course and returns the list; hearting twice is the same", async () => {
    const kati = await client();
    expect(await setFavourite(db, kati.id, "kulmude-lami", true)).toEqual(["kulmude-lami"]);
    expect(await setFavourite(db, kati.id, "kulmude-lami", true)).toEqual(["kulmude-lami"]);
    expect(await setFavourite(db, kati.id, "veebikursus", true)).toEqual(["veebikursus", "kulmude-lami"]);
    expect(await setFavourite(db, kati.id, "kulmude-lami", false)).toEqual(["veebikursus"]);
    expect(await setFavourite(db, kati.id, "kulmude-lami", false)).toEqual(["veebikursus"]); // not there: fine
    expect(await db.select().from(clientFavourites)).toHaveLength(1);
  });

  test("hearting a course that does not exist or is not published is refused (null); taking one off is always fine", async () => {
    const kati = await client();
    expect(await setFavourite(db, kati.id, "olematu", true)).toBeNull();
    expect(await setFavourite(db, kati.id, "ootel", true)).toBeNull();
    expect(await db.select().from(clientFavourites)).toEqual([]);
    expect(await setFavourite(db, kati.id, "olematu", false)).toEqual([]);
    // a heart on a course that was unpublished later can be taken off, though it is not listed
    await db.insert(clientFavourites).values({ clientId: kati.id, courseId: f.draft.id });
    expect(await setFavourite(db, kati.id, "ootel", false)).toEqual([]);
    expect(await db.select().from(clientFavourites)).toEqual([]);
  });

  test("a client's hearts are its own", async () => {
    const kati = await client();
    const mari = await client("mari@example.test");
    await setFavourite(db, mari.id, "kulmude-lami", true);
    expect(await setFavourite(db, kati.id, "kulmude-lami", false)).toEqual([]);
    expect(await favouriteSlugs(db, mari.id)).toEqual(["kulmude-lami"]);
  });

  test("mergeFavourites adds what exists and is published, ignores unknown slugs and duplicates, and keeps what is there", async () => {
    const kati = await client();
    await setFavourite(db, kati.id, "veebikursus", true);
    const merged = await mergeFavourites(db, kati.id, ["kulmude-lami", "olematu", "ootel", "kulmude-lami", "veebikursus", "peidus-kursus", ""]);
    expect([...merged].sort()).toEqual(["kulmude-lami", "veebikursus"]);
    expect(await db.select().from(clientFavourites)).toHaveLength(2);
    expect(await mergeFavourites(db, kati.id, [])).toEqual(merged);
  });
});

describe("profile and newsletter", () => {
  test("updateProfile saves name, phone and language, for that client only", async () => {
    const kati = await client();
    const mari = await client("mari@example.test", { name: "Mari" });
    expect(await updateProfile(db, kati.id, { name: "Kati Tamm", phone: "+3725551234", locale: "ru" })).toBe(true);
    expect(await db.select().from(clients).where(eq(clients.id, kati.id))).toMatchObject([{ name: "Kati Tamm", phone: "+3725551234", locale: "ru", email: "kati@example.test" }]);
    expect((await db.select().from(clients).where(eq(clients.id, mari.id)))[0].name).toBe("Mari");
    expect(await updateProfile(db, 987654, { name: "x", phone: "", locale: "et" })).toBe(false);
  });

  test("newsletter on makes a confirmed subscriber of the account's address, linked to the client, in its language; on again changes nothing", async () => {
    const kati = await client("kati@example.test", { locale: "ru" });
    expect(await setNewsletter(db, kati.id, true, NOW)).toBe(true);
    const [sub] = await db.select().from(subscribers);
    expect(sub).toMatchObject({ email: "kati@example.test", locale: "ru", clientId: kati.id, confirmedAt: NOW, consentAt: NOW });
    expect(sub.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    await setNewsletter(db, kati.id, true, at(1));
    expect(await db.select().from(subscribers)).toEqual([sub]);
    expect((await loadDashboard(db, kati.id, NOW))!.client.newsletter).toBe(true);
  });

  test("newsletter on confirms an address that was waiting for it (the first consent time is kept) and reuses a row stored in another case", async () => {
    const kati = await client();
    await db.insert(subscribers).values({ email: "KATI@example.test", token: "t1", consentAt: at(-9) });
    await setNewsletter(db, kati.id, true, NOW);
    const rows = await db.select().from(subscribers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "KATI@example.test", token: "t1", clientId: kati.id, confirmedAt: NOW, consentAt: at(-9) });
    // already confirmed: the first confirmation time stays
    await setNewsletter(db, kati.id, true, at(3));
    expect((await db.select().from(subscribers))[0].confirmedAt).toEqual(NOW);
  });

  test("newsletter off deletes the subscriber of the address (whatever its case or state), and only that one", async () => {
    const kati = await client();
    await db.insert(subscribers).values([{ email: "Kati@example.test", token: "t1" }, { email: "mari@example.test", token: "t2", confirmedAt: NOW }]);
    expect(await setNewsletter(db, kati.id, false, NOW)).toBe(true);
    expect((await db.select().from(subscribers)).map((s) => s.email)).toEqual(["mari@example.test"]);
    expect(await setNewsletter(db, kati.id, false, NOW)).toBe(true); // nothing to delete: fine
    expect(await setNewsletter(db, 987654, true, NOW)).toBe(false);
    expect(await setNewsletter(db, 987654, false, NOW)).toBe(false);
  });
});

describe("createChangeRequest", () => {
  test("stores a change_request for the client's own registration and changes nothing else", async () => {
    const kati = await client();
    const reg = await register(kati.id, f.lami.id, f.soon.id, { status: "confirmed", paidCents: 35000 });
    const info = await createChangeRequest(db, kati.id, reg.id, "cancel", "Haigestusin", NOW);
    expect(info).toEqual({
      registrationId: reg.id, course: "Kulmude lamineerimine", session: { startsAt: f.soon.startsAt, city: "Pärnu", venue: "Salong" },
      name: "Kati Tamm", email: "kati@example.test", phone: "+3725551234", locale: "et",
    });
    const rows = await db.select().from(requests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "change_request", clientId: kati.id, handled: false,
      payload: { registrationId: reg.id, kind: "cancel", message: "Haigestusin", email: "kati@example.test" },
    });
    expect((await db.select().from(registrations).where(eq(registrations.id, reg.id)))[0]).toEqual(reg); // untouched
  });

  test("a registration without a session works too (an individual course)", async () => {
    const kati = await client();
    const reg = await register(kati.id, f.lami.id, null, { kind: "individual", name: "", phone: "" });
    await db.update(clients).set({ name: "Kati", phone: "123" }).where(eq(clients.id, kati.id));
    expect(await createChangeRequest(db, kati.id, reg.id, "change", "", NOW)).toMatchObject({ session: null, name: "Kati", phone: "123" });
    expect((await db.select().from(requests))[0].payload).toEqual({ registrationId: reg.id, kind: "change", message: "", email: "kati@example.test" });
  });

  test("an awaiting registration may ask too, and one whose session is today but not yet begun", async () => {
    const kati = await client();
    const reg = await register(kati.id, f.lami.id, f.soon.id);
    expect(await createChangeRequest(db, kati.id, reg.id, "change", "", NOW)).not.toBe(false);
    const justBefore = new Date(f.soon.startsAt.getTime() - 1);
    expect(await createChangeRequest(db, kati.id, reg.id, "change", "", justBefore)).not.toBe(false);
  });

  test("refused (false, nothing stored) for another client's registration, one linked to nobody, and one that does not exist", async () => {
    const kati = await client();
    const mari = await client("mari@example.test");
    const maris = await register(mari.id, f.lami.id, f.soon.id, { email: "mari@example.test" });
    const loose = await register(null, f.lami.id, f.soon.id); // the same address as Kati's, not linked
    expect(await createChangeRequest(db, kati.id, maris.id, "cancel", "x", NOW)).toBe(false);
    expect(await createChangeRequest(db, kati.id, loose.id, "cancel", "x", NOW)).toBe(false);
    expect(await createChangeRequest(db, kati.id, 987654, "cancel", "x", NOW)).toBe(false);
    expect(await db.select().from(requests)).toEqual([]);
  });

  test("refused (false, nothing stored) for a cancelled registration, a session that has begun (also the instant it begins) and a session that was called off", async () => {
    const kati = await client();
    const cancelled = await register(kati.id, f.lami.id, f.soon.id, { status: "cancelled" });
    const past = await register(kati.id, f.lami.id, f.past.id, { status: "confirmed" });
    const called = await register(kati.id, f.lami.id, f.called.id, { status: "confirmed" });
    const starting = await register(kati.id, f.lami.id, f.soon.id, { status: "confirmed" });
    expect(await createChangeRequest(db, kati.id, cancelled.id, "change", "x", NOW)).toBe(false);
    expect(await createChangeRequest(db, kati.id, past.id, "cancel", "x", NOW)).toBe(false);
    expect(await createChangeRequest(db, kati.id, called.id, "cancel", "x", NOW)).toBe(false);
    expect(await createChangeRequest(db, kati.id, starting.id, "cancel", "x", f.soon.startsAt)).toBe(false); // begun: the calendar's own boundary
    expect(await createChangeRequest(db, kati.id, starting.id, "cancel", "x", at(31))).toBe(false);
    expect(await db.select().from(requests)).toEqual([]);
  });
});

describe("e-course and terms", () => {
  const TERMS = { title: { et: "E-koolituse tingimused" }, body: { et: "Ligipääs on isiklik.", ru: "Доступ личный." } };
  const V2 = "2026-11-01T09:00:00.000Z";
  // the terms text exists unless a test says otherwise (without one there is nothing to accept)
  beforeEach(async () => {
    await db.insert(pages).values({ key: "course_terms", ...TERMS });
  });

  test("the e-course view: the course, its modules, the access end and the terms still to accept (with their version and text)", async () => {
    const kati = await client();
    await grant(kati.id, f.online.id);
    expect(await loadEcourse(db, kati.id, "veebikursus", NOW)).toEqual({
      course: {
        slug: "veebikursus",
        title: { et: "Veebikursus" },
        modules: [{ id: expect.any(Number), title: { et: "Sissejuhatus" }, lessons: [] }, { id: expect.any(Number), title: { et: "Praktika", ru: "Практика" }, lessons: [] }],
      },
      access: { expiresAt: at(170).toISOString() },
      terms: { version: "1", accepted: false, text: TERMS.body },
      progress: { done: 0, total: 0, next: null },
      completion: { lessons: { done: 0, total: 0, state: "done" }, test: null, practical: null, completedAt: null, protocolSent: false, certificate: null, certificateName: "" },
    });
    await setting("courseTermsVersion", V2);
    expect((await loadEcourse(db, kati.id, "veebikursus", NOW))!.terms.version).toBe(V2);
  });

  test("no terms text stored (no page row, or an empty Estonian text): nothing to accept, the course opens, and no acceptance is recorded", async () => {
    const kati = await client();
    await grant(kati.id, f.online.id);
    for (const clear of [
      () => db.delete(pages).where(eq(pages.key, "course_terms")),
      async () => {
        await db.insert(pages).values({ key: "course_terms", title: { et: "x" }, body: { et: "  ", ru: "Только по-русски" } });
      },
    ]) {
      await db.delete(pages);
      await clear();
      expect((await loadEcourse(db, kati.id, "veebikursus", NOW))!.terms).toEqual({ version: "1", accepted: true, text: null });
      // a stale page (loaded when there was a text) that accepts now: nothing is stored, and the page loaded again finds the course open
      expect(await acceptTerms(db, kati.id, "veebikursus", "1", NOW)).toBe("stale");
      expect(await db.select().from(termsAcceptances)).toEqual([]);
    }
  });

  test("a stored body that is not an { et, ru? } of strings is no text: the course opens, nothing is asked, nothing throws", async () => {
    const kati = await client();
    await grant(kati.id, f.online.id);
    for (const body of [{ et: 5 }, { et: "Tekst", ru: 5 }, { et: "Tekst", ru: ["x"] }, {}, [], "Ligipääs on isiklik.", 7, true, { ru: "Только русский" }, { et: null }]) {
      await db.delete(pages);
      await db.insert(pages).values({ key: "course_terms", title: { et: "x" }, body } as never);
      const view = await loadEcourse(db, kati.id, "veebikursus", NOW);
      expect(view!.terms, JSON.stringify(body)).toEqual({ version: "1", accepted: true, text: null });
      expect(await acceptTerms(db, kati.id, "veebikursus", "1", NOW), JSON.stringify(body)).toBe("stale");
    }
    expect(await db.select().from(termsAcceptances)).toEqual([]);
    // a null Russian text is as good as none; the Estonian one is shown
    await db.delete(pages);
    await db.insert(pages).values({ key: "course_terms", title: { et: "x" }, body: { et: "Tekst.", ru: null } } as never);
    expect((await loadEcourse(db, kati.id, "veebikursus", NOW))!.terms).toEqual({ version: "1", accepted: false, text: { et: "Tekst." } });
  });

  test("a text added later brings the notice: the version moves with the admin's save, and accepting then stores it", async () => {
    const kati = await client();
    await grant(kati.id, f.online.id);
    await db.delete(pages);
    expect((await loadEcourse(db, kati.id, "veebikursus", NOW))!.terms.accepted).toBe(true);
    const s = await loadSettings(db);
    const fd = new FormData();
    fd.set("data", JSON.stringify({ parts: { course_terms: { version: s.versions.course_terms, value: { body: { et: "Esimesed tingimused." } } } } }));
    expect(await saveSettingsForm(db, fd)).toMatchObject({ ok: true });
    const view = (await loadEcourse(db, kati.id, "veebikursus", NOW))!;
    expect(view.terms).toEqual({ version: await courseTermsVersion(db), accepted: false, text: { et: "Esimesed tingimused." } });
    expect(view.terms.version).not.toBe("1");
    expect(await acceptTerms(db, kati.id, "veebikursus", view.terms.version, NOW)).toBe("accepted");
    expect(await db.select().from(termsAcceptances)).toHaveLength(1);
  });

  test("null without active access: none, another client's, revoked, expired, an unknown slug", async () => {
    const kati = await client();
    const mari = await client("mari@example.test");
    expect(await loadEcourse(db, kati.id, "veebikursus", NOW)).toBeNull();
    await grant(mari.id, f.online.id);
    expect(await loadEcourse(db, kati.id, "veebikursus", NOW)).toBeNull();
    expect(await loadEcourse(db, kati.id, "olematu", NOW)).toBeNull();
    await grant(kati.id, f.online.id, { revokedAt: at(-1) });
    expect(await loadEcourse(db, kati.id, "veebikursus", NOW)).toBeNull();
    await db.update(courseAccess).set({ revokedAt: null, expiresAt: at(-1) }).where(eq(courseAccess.clientId, kati.id));
    expect(await loadEcourse(db, kati.id, "veebikursus", NOW)).toBeNull();
    // until, not including, the moment access ends
    await db.update(courseAccess).set({ expiresAt: NOW }).where(eq(courseAccess.clientId, kati.id));
    expect(await loadEcourse(db, kati.id, "veebikursus", NOW)).toBeNull();
    await db.update(courseAccess).set({ expiresAt: new Date(NOW.getTime() + 1) }).where(eq(courseAccess.clientId, kati.id));
    expect(await loadEcourse(db, kati.id, "veebikursus", NOW)).not.toBeNull();
  });

  test("active access survives unpublishing the course: the view opens and the terms can be accepted; ended access does not", async () => {
    const kati = await client();
    await grant(kati.id, f.hiddenOnline.id);
    expect(await loadEcourse(db, kati.id, "peidus-kursus", NOW)).toMatchObject({ course: { slug: "peidus-kursus" }, terms: { version: "1", accepted: false } });
    expect(await acceptTerms(db, kati.id, "peidus-kursus", "1", NOW)).toBe("accepted");
    expect((await loadEcourse(db, kati.id, "peidus-kursus", NOW))!.terms.accepted).toBe(true);
    await db.update(courseAccess).set({ revokedAt: at(-1) }).where(eq(courseAccess.clientId, kati.id));
    expect(await loadEcourse(db, kati.id, "peidus-kursus", NOW)).toBeNull();
    expect(await acceptTerms(db, kati.id, "peidus-kursus", "1", NOW)).toBe("noAccess");
  });

  test("the version is the settings key courseTermsVersion, \"1\" until the admin has saved the terms", async () => {
    expect(await courseTermsVersion(db)).toBe("1");
    await setting("courseTermsVersion", "");
    expect(await courseTermsVersion(db)).toBe("1");
    await setting("courseTermsVersion", 5);
    expect(await courseTermsVersion(db)).toBe("1");
    await setting("courseTermsVersion", "2026-10-01T09:00:00.000Z");
    expect(await courseTermsVersion(db)).toBe("2026-10-01T09:00:00.000Z");
  });

  test("accepting stores the version for this client and course; the notice then stays away, and the text is not sent again", async () => {
    const kati = await client();
    await grant(kati.id, f.online.id);
    expect(await acceptTerms(db, kati.id, "veebikursus", "1", NOW)).toBe("accepted");
    expect(await db.select().from(termsAcceptances)).toEqual([{ clientId: kati.id, courseId: f.online.id, termsVersion: "1", acceptedAt: NOW }]);
    expect((await loadEcourse(db, kati.id, "veebikursus", NOW))!.terms).toEqual({ version: "1", accepted: true, text: null });
    expect(await acceptTerms(db, kati.id, "veebikursus", "1", at(1))).toBe("accepted"); // again: nothing changes
    expect(await db.select().from(termsAcceptances)).toHaveLength(1);
  });

  test("a new terms version asks again, and accepting stores that version next to the old one", async () => {
    const kati = await client();
    await grant(kati.id, f.online.id);
    await acceptTerms(db, kati.id, "veebikursus", "1", NOW);
    await setting("courseTermsVersion", V2);
    expect((await loadEcourse(db, kati.id, "veebikursus", at(40)))!.terms).toMatchObject({ version: V2, accepted: false });
    expect(await acceptTerms(db, kati.id, "veebikursus", V2, at(40))).toBe("accepted");
    expect((await db.select().from(termsAcceptances)).map((t) => t.termsVersion).sort()).toEqual(["1", V2]);
    expect((await loadEcourse(db, kati.id, "veebikursus", at(40)))!.terms.accepted).toBe(true);
  });

  test("the admin's own save of new terms (Seaded) asks a student who accepted before again, and the 409 case follows from it", async () => {
    const kati = await client();
    await grant(kati.id, f.online.id);
    const save = async (et: string) => {
      const s = await loadSettings(db);
      const fd = new FormData();
      fd.set("data", JSON.stringify({ parts: { course_terms: { version: s.versions.course_terms, value: { body: { et } } } } }));
      return saveSettingsForm(db, fd);
    };
    expect(await acceptTerms(db, kati.id, "veebikursus", "1", NOW)).toBe("accepted");
    expect((await loadEcourse(db, kati.id, "veebikursus", NOW))!.terms).toMatchObject({ version: "1", accepted: true, text: null });

    const seen = (await loadEcourse(db, kati.id, "veebikursus", NOW))!.terms.version; // a page was loaded with this version
    expect(await save("Uued tingimused.")).toMatchObject({ ok: true });
    const view = (await loadEcourse(db, kati.id, "veebikursus", NOW))!;
    expect(view.terms).toEqual({ version: await courseTermsVersion(db), accepted: false, text: { et: "Uued tingimused." } });
    expect(view.terms.version).not.toBe(seen);
    expect(await acceptTerms(db, kati.id, "veebikursus", seen, NOW)).toBe("stale"); // the old page's click
    expect(await acceptTerms(db, kati.id, "veebikursus", view.terms.version, NOW)).toBe("accepted");
    expect((await loadEcourse(db, kati.id, "veebikursus", NOW))!.terms).toMatchObject({ accepted: true, text: null });
    // the same text saved again changes nothing: nobody is asked again
    const kept = await courseTermsVersion(db);
    expect(await save("Uued tingimused.")).toMatchObject({ ok: true });
    expect(await courseTermsVersion(db)).toBe(kept);
  });

  test("a stale version is refused and nothing is stored: the student saw the old text, the admin has saved a new one", async () => {
    const kati = await client();
    await grant(kati.id, f.online.id);
    const seen = (await loadEcourse(db, kati.id, "veebikursus", NOW))!.terms.version; // the page was loaded with "1"
    await setting("courseTermsVersion", V2); // the admin saves new terms
    expect(await acceptTerms(db, kati.id, "veebikursus", seen, NOW)).toBe("stale");
    expect(await db.select().from(termsAcceptances)).toEqual([]);
    expect((await loadEcourse(db, kati.id, "veebikursus", NOW))!.terms.accepted).toBe(false);
    // any other version is stale too, also a newer one the page cannot have seen, and an empty one
    for (const version of ["2", "2026-12-01T09:00:00.000Z", "", V2.slice(0, -1)]) expect(await acceptTerms(db, kati.id, "veebikursus", version, NOW), version).toBe("stale");
    expect(await db.select().from(termsAcceptances)).toEqual([]);
    expect(await acceptTerms(db, kati.id, "veebikursus", V2, NOW)).toBe("accepted"); // after reloading, the current one
  });

  test("no access is reported before a stale version (a client without access learns nothing about the terms)", async () => {
    const kati = await client();
    await setting("courseTermsVersion", V2);
    expect(await acceptTerms(db, kati.id, "veebikursus", "1", NOW)).toBe("noAccess");
  });

  test("an acceptance is per client: another client's does not count", async () => {
    const kati = await client();
    const mari = await client("mari@example.test");
    await grant(kati.id, f.online.id);
    await grant(mari.id, f.online.id);
    await acceptTerms(db, mari.id, "veebikursus", "1", NOW);
    expect((await loadEcourse(db, kati.id, "veebikursus", NOW))!.terms.accepted).toBe(false);
  });

  test("accepting needs active access: none, expired, revoked, another client's, unknown slug (\"noAccess\", nothing stored)", async () => {
    const kati = await client();
    const mari = await client("mari@example.test");
    expect(await acceptTerms(db, kati.id, "veebikursus", "1", NOW)).toBe("noAccess");
    await grant(mari.id, f.online.id);
    expect(await acceptTerms(db, kati.id, "veebikursus", "1", NOW)).toBe("noAccess");
    expect(await acceptTerms(db, kati.id, "olematu", "1", NOW)).toBe("noAccess");
    expect(await acceptTerms(db, kati.id, "kulmude-lami", "1", NOW)).toBe("noAccess"); // a published course, but no access
    await grant(kati.id, f.online.id, { expiresAt: at(-1) });
    expect(await acceptTerms(db, kati.id, "veebikursus", "1", NOW)).toBe("noAccess");
    await db.update(courseAccess).set({ expiresAt: at(30), revokedAt: at(-1) }).where(and(eq(courseAccess.clientId, kati.id), eq(courseAccess.courseId, f.online.id)));
    expect(await acceptTerms(db, kati.id, "veebikursus", "1", NOW)).toBe("noAccess");
    expect(await db.select().from(termsAcceptances)).toEqual([]);
  });
});

describe("deleteClient", () => {
  test("deletes the client and what hangs on it, keeps the registrations and requests unlinked with their name and address as given, and unsubscribes the address", async () => {
    const kati = await client("kati@example.test", { name: "Kati", locale: "ru" });
    const mari = await client("mari@example.test");
    const reg = await register(kati.id, f.lami.id, f.soon.id, { name: "Kati Tamm" });
    const maris = await register(mari.id, f.lami.id, f.soon.id, { name: "Mari", email: "mari@example.test" });
    const req = await request(kati.id, "individual", { course: "kulmude-lami", preferredPeriod: "x", email: "kati@example.test" });
    await grant(kati.id, f.online.id);
    await grant(mari.id, f.online.id);
    await acceptTerms(db, kati.id, "veebikursus", "1", NOW);
    await db.insert(clientFavourites).values([{ clientId: kati.id, courseId: f.lami.id }, { clientId: mari.id, courseId: f.lami.id }]);
    await db.insert(clientSessions).values({ idHash: "h1", clientId: kati.id, expiresAt: at(100) });
    await db.insert(subscribers).values([{ email: "Kati@example.test", token: "t1", confirmedAt: NOW, clientId: kati.id }, { email: "mari@example.test", token: "t2", clientId: mari.id }]);

    expect(await deleteClient(db, kati.id)).toEqual({ email: "kati@example.test", locale: "ru", photoKeys: [] });

    expect((await db.select().from(clients)).map((c) => c.email)).toEqual(["mari@example.test"]);
    expect(await db.select().from(clientSessions)).toEqual([]);
    expect(await db.select().from(termsAcceptances)).toEqual([]);
    expect(await db.select().from(courseAccess).then((rows) => rows.map((r) => r.clientId))).toEqual([mari.id]);
    expect(await db.select().from(clientFavourites).then((rows) => rows.map((r) => r.clientId))).toEqual([mari.id]);
    expect((await db.select().from(subscribers)).map((s) => s.email)).toEqual(["mari@example.test"]);
    // the booking stays with Maria: unlinked, nothing else changed
    expect((await db.select().from(registrations).where(eq(registrations.id, reg.id)))[0]).toEqual({ ...reg, clientId: null });
    expect((await db.select().from(requests).where(eq(requests.id, req.id)))[0]).toEqual({ ...req, clientId: null });
    expect((await db.select().from(registrations).where(eq(registrations.id, maris.id)))[0]).toEqual(maris);
  });

  test("the login codes and links still waiting for the address are deleted with it: no token row is left, and a code or link issued before no longer signs in", async () => {
    const T0 = new Date("2026-10-03T09:50:00Z"); // a live login at NOW: issued ten minutes ago, valid 30
    const first = (await issueClientLogin(db, "kati@example.test", T0))!;
    const kati = (await redeemClientCode(db, "kati@example.test", first.code, T0)) as { clientId: number }; // the first login makes the account
    // "Saada uuesti": more logins issued while signed in, one for a mail in another case and one for another address
    const resent = (await issueClientLogin(db, "Kati@Example.test", T0))!;
    const again = (await issueClientLogin(db, "kati@example.test", T0))!;
    const other = (await issueClientLogin(db, "mari@example.test", T0))!;
    expect(await db.select().from(clientLoginTokens)).toHaveLength(4); // the used one and three live ones, one for Mari

    expect(await deleteClient(db, kati.clientId)).toEqual({ email: "kati@example.test", locale: "et", photoKeys: [] });

    expect((await db.select().from(clientLoginTokens)).map((t) => t.email)).toEqual(["mari@example.test"]);
    expect(await redeemClientCode(db, "kati@example.test", resent.code, NOW)).toBeNull();
    expect(await redeemClientCode(db, "kati@example.test", again.code, NOW)).toBeNull();
    expect(await redeemClientLink(db, again.token, NOW)).toBeNull();
    expect(await redeemClientLink(db, resent.token, NOW)).toBeNull();
    expect(await db.select().from(clients)).toEqual([]); // nothing signed in again, so nothing re-created the account
    // another address keeps its login
    expect(await redeemClientCode(db, "mari@example.test", other.code, NOW)).toMatchObject({ isNew: true });
  });

  test("a client that is gone: null (deleting twice is fine)", async () => {
    const kati = await client();
    expect(await deleteClient(db, kati.id)).not.toBeNull();
    expect(await deleteClient(db, kati.id)).toBeNull();
  });
});

describe("e-course progress on the dashboard (phase 2c)", () => {
  /** An e-course of `n` text lessons in one module "M" (L1…Ln), published. */
  async function lessonCourse(slug: string, n: number) {
    const [course] = await db.insert(courses).values({ ...base, slug, type: "e_learning", title: { et: slug }, published: true, price: 100 }).returning();
    const [m] = await addModules(db, course.id, [{ et: "M" }]);
    const list = [];
    for (let i = 1; i <= n; i++) list.push((await db.insert(lessons).values({ moduleId: m.id, position: i, title: { et: `L${i}` }, kind: "text" }).returning())[0]);
    return { course, lessons: list };
  }

  test("an open e-course carries done of total and the next lesson with its module; one without lessons null; an ended or revoked access none", async () => {
    const kati = await client();
    const a = await lessonCourse("kursus-a", 3);
    await grant(kati.id, a.course.id);
    await grant(kati.id, f.online.id); // modules, no lessons
    const ended = await lessonCourse("kursus-vana", 1);
    await grant(kati.id, ended.course.id, { expiresAt: at(-1), grantedAt: at(-30) });
    const revoked = await lessonCourse("kursus-tuhistatud", 2); // lessons, but the access was revoked: not open
    await grant(kati.id, revoked.course.id, { revokedAt: at(-1), grantedAt: at(-20) });
    await db.insert(lessonProgress).values({ clientId: kati.id, lessonId: a.lessons[0].id, doneAt: NOW });
    const { cards } = (await loadDashboard(db, kati.id, NOW))!;
    const card = (slug: string) => cards.find((c) => c.kind === "ecourse" && c.course.slug === slug)!;
    expect(card("kursus-a")).toMatchObject({ progress: { done: 1, total: 3, next: { lessonId: a.lessons[1].id, title: { et: "L2" }, moduleTitle: { et: "M" } } } });
    expect(card("veebikursus")).toMatchObject({ progress: null });
    expect(card("kursus-vana")).not.toHaveProperty("progress");
    expect(card("kursus-tuhistatud")).toMatchObject({ revoked: true });
    expect(card("kursus-tuhistatud")).not.toHaveProperty("progress");
  });

  test("the 'Pooleli' card is for the e-course she did something in last; with no activity the first open one with lessons; none when all are finished", async () => {
    const kati = await client();
    const a = await lessonCourse("kursus-a", 2);
    const b = await lessonCourse("kursus-b", 2);
    await grant(kati.id, a.course.id, { grantedAt: at(-3) });
    await grant(kati.id, b.course.id, { grantedAt: at(-2) });
    // a revoked access with lessons and the freshest activity of all: never chosen
    const revoked = await lessonCourse("kursus-tuhistatud", 2);
    await grant(kati.id, revoked.course.id, { revokedAt: at(-1), grantedAt: at(-1) });
    await db.insert(lessonProgress).values({ clientId: kati.id, lessonId: revoked.lessons[0].id, updatedAt: NOW });
    const resume = async () => (await loadDashboard(db, kati.id, NOW))!.resume;
    expect(await resume()).toBe("kursus-b"); // no activity in a and b: the cards' order, the newest grant first
    await db.insert(lessonProgress).values({ clientId: kati.id, lessonId: a.lessons[0].id, updatedAt: at(-1) });
    expect(await resume()).toBe("kursus-a");
    await db.insert(lessonProgress).values({ clientId: kati.id, lessonId: b.lessons[0].id, updatedAt: NOW });
    expect(await resume()).toBe("kursus-b");
    // b finished: back to a; both finished: none
    await db.update(lessonProgress).set({ doneAt: NOW }).where(eq(lessonProgress.lessonId, b.lessons[0].id));
    await db.insert(lessonProgress).values({ clientId: kati.id, lessonId: b.lessons[1].id, doneAt: NOW, updatedAt: NOW });
    expect(await resume()).toBe("kursus-a");
    await db.update(lessonProgress).set({ doneAt: NOW }).where(eq(lessonProgress.lessonId, a.lessons[0].id));
    await db.insert(lessonProgress).values({ clientId: kati.id, lessonId: a.lessons[1].id, doneAt: NOW });
    expect(await resume()).toBeNull();
  });
});

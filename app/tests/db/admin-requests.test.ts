import { beforeEach, describe, expect, test } from "vitest";
import { makeTestDb } from "./helpers";
import type { Db } from "@/db/client";
import { courses, courseSessions, registrations, requests } from "@/db/schema";
import { adminCounts, pageRequests, requestCounts } from "@/db/queries/admin";
import { saveHandled } from "@/server/admin";

// Päringud (admin UX pass, README A7, piece 2 Task 15) on a real (PGlite) database: the search that looks in every tab, the open requests and the
// done ones (the fold „Tehtud ({n})“) as two lists, the tabs' open counts, and „Märgi tehtuks“ with its „Võta tagasi“, which never overwrites a newer change.

const base = { level: "basic" as const, title: { et: "Kulmumeistri baaskoolitus" }, summary: { et: "" }, body: { et: "" } };

let db: Db;
let ids: Record<string, number>;
let registration: { id: number };

const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 9, day, hour));
const add = async (key: string, kind: typeof requests.$inferInsert.kind, payload: Record<string, string | number | boolean>, over: Partial<typeof requests.$inferInsert> = {}) => {
  const [row] = await db.insert(requests).values({ kind, payload, ...over }).returning();
  ids[key] = row.id;
  return row;
};

beforeEach(async () => {
  db = await makeTestDb();
  ids = {};
  const [course] = await db.insert(courses).values({ ...base, slug: "kulm", type: "contact", priceGroup: 35000, priceIndividual: 45000 }).returning();
  const [session] = await db.insert(courseSessions).values({ courseId: course.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu" }).returning();
  [registration] = await db
    .insert(registrations)
    .values({ courseId: course.id, courseSessionId: session.id, kind: "group", name: "Kati Kask", email: "kati@example.test", phone: "+372 5000 0001", paymentChoice: "half" })
    .returning();
  await add("contact", "contact", { name: "Mari Maasikas", email: "mari@example.test", message: "Tere! Kas jaanuaris on veel kohti?", locale: "et" }, { createdAt: at(1) });
  await add("interest", "contact", { course: "kulm", intent: "purchase", email: "reet@example.test", locale: "et" }, { createdAt: at(2) });
  await add("individual", "individual", { course: "kulm", name: "Jaan Tamm", email: "jaan@example.test", phone: "+372 5555 0102", message: "", locale: "et" }, { createdAt: at(3) });
  await add("practice", "practice", { package: "MINI", name: "Liis Lepp", email: "liis@example.test", phone: "+372 5555 0103", course: "Baaskoolitus", times: "õhtuti", locale: "et" }, { createdAt: at(4) });
  await add("waitlist", "waitlist", { session: session.id, course: "kulm", name: "Ott Kask", email: "ott@example.test", locale: "et" }, { createdAt: at(5) });
  await add("change", "change_request", { registrationId: registration.id, kind: "cancel", message: "Jään haigeks.", email: "kati.konto@example.test" }, { createdAt: at(6) });
  await add("doneContact", "contact", { name: "Vana Vestlus", email: "vana@example.test", message: "Aitäh!", locale: "et" }, { createdAt: at(7), handled: true });
});

const open = async (search: string, kind?: Parameters<typeof pageRequests>[1]["kind"]) =>
  (await pageRequests(db, { kind, search, handled: false, page: 1 })).rows.map((r) => r.id);
const idsOf = (...keys: string[]) => keys.map((k) => ids[k]);

describe("pageRequests: a tab, open or done", () => {
  test("a tab's open requests, newest first; its done ones are the other list", async () => {
    expect((await pageRequests(db, { kind: "contact", handled: false, page: 1 })).rows.map((r) => r.id)).toEqual(idsOf("interest", "contact"));
    expect((await pageRequests(db, { kind: "contact", handled: true, page: 1 })).rows.map((r) => r.id)).toEqual(idsOf("doneContact"));
    expect(await pageRequests(db, { kind: "waitlist", handled: true, page: 1 })).toMatchObject({ total: 0, rows: [] });
  });

  test("with no tab, every kind", async () => {
    expect((await pageRequests(db, { handled: false, page: 1 })).total).toBe(6);
    expect((await pageRequests(db, { handled: true, page: 1 })).total).toBe(1);
  });

  test("each list pages by itself: open ones and done ones, newest first, an out-of-range page shows the last", async () => {
    await db.insert(requests).values(Array.from({ length: 5 }, (_, i) => ({ kind: "practice" as const, payload: { name: `P${i}` }, createdAt: at(10 + i), handled: i % 2 === 0 })));
    const names = async (handled: boolean, page: number) => (await pageRequests(db, { kind: "practice", handled, page }, 2)).rows.map((r) => r.payload.name);
    // open: 1 and 3 (i odd) + the fixture's Liis; done: 0, 2, 4
    expect(await names(false, 1)).toEqual(["P3", "P1"]);
    expect(await names(false, 2)).toEqual(["Liis Lepp"]);
    expect(await names(true, 1)).toEqual(["P4", "P2"]);
    expect(await names(true, 2)).toEqual(["P0"]);
    expect(await names(true, 9)).toEqual(["P0"]);
    expect(await pageRequests(db, { kind: "practice", handled: true, page: 2 }, 2)).toMatchObject({ page: 2, pages: 2, total: 3 });
  });
});

describe("pageRequests: the search looks in every tab", () => {
  test("a Praktika request is found from the Kontakt tab by the digits of its phone, however the phone is written", async () => {
    for (const q of ["5555 0103", "55550103", "5555-0103", "+372 5555 0103", "372 5555 0103", "(5555) 0103"]) {
      expect(await open(q, "contact"), q).toEqual(idsOf("practice"));
    }
    // the same search with no tab at all, and from another tab
    expect(await open("5555 0103")).toEqual(idsOf("practice"));
    expect(await open("5555 0103", "waitlist")).toEqual(idsOf("practice"));
    // fewer digits find both numbers; two digits are no phone (a name like „Kati 5“ is none)
    expect(await open("55550")).toEqual(idsOf("practice", "individual"));
    expect(await open("55")).toEqual([]);
  });

  test("the name, the e-mail and the message, in upper or lower case, Cyrillic too", async () => {
    await add("russian", "contact", { name: "Мария Кузнецова", email: "maria.k@example.test", message: "Здравствуйте! Есть ли курсы?", locale: "ru" }, { createdAt: at(8) });
    expect(await open("MAASIKAS")).toEqual(idsOf("contact"));
    expect(await open("liis@EXAMPLE")).toEqual(idsOf("practice"));
    expect(await open("jaanuaris")).toEqual(idsOf("contact"));
    expect(await open("МАРИЯ")).toEqual(idsOf("russian"));
    expect(await open("курсы")).toEqual(idsOf("russian"));
    // (the e-learning interest has only an address)
    expect(await open("reet@")).toEqual(idsOf("interest"));
  });

  test("%, _ and \\ are taken literally", async () => {
    await add("percent", "contact", { name: "Pr", email: "pr@example.test", message: "Hind 100% ok", locale: "et" });
    await add("under", "contact", { name: "Un", email: "un@example.test", message: "mis_mis", locale: "et" });
    await add("slash", "contact", { name: "Sl", email: "sl@example.test", message: "a\\b", locale: "et" });
    expect(await open("100%")).toEqual(idsOf("percent"));
    expect(await open("%")).toEqual(idsOf("percent"));
    expect(await open("_")).toEqual(idsOf("under"));
    expect(await open("m_s")).toEqual([]);
    expect(await open("\\")).toEqual(idsOf("slash"));
  });

  test("a change request is found by the name, the e-mail and the phone of its registration, which the card shows", async () => {
    expect(await open("Kati Kask")).toEqual(idsOf("change"));
    expect(await open("kati@example")).toEqual(idsOf("change"));
    expect(await open("5000 0001")).toEqual(idsOf("change"));
    // the address in the request itself, and its message
    expect(await open("kati.konto")).toEqual(idsOf("change"));
    expect(await open("haigeks")).toEqual(idsOf("change"));
    // the waitlist's Ott Kask shares „Kask“ with her
    expect(await open("kask")).toEqual(idsOf("change", "waitlist"));
  });

  test("a payload whose registrationId is no plain number does not break the search", async () => {
    await add("bad1", "change_request", { registrationId: "abc", kind: "cancel", message: "x", email: "bad1@example.test" });
    await add("bad2", "change_request", { registrationId: 99999999999999, kind: "cancel", message: "x", email: "bad2@example.test" });
    await add("bad3", "change_request", { kind: "cancel", message: "x", email: "bad3@example.test" });
    expect(await open("bad2@")).toEqual(idsOf("bad2"));
    expect(await open("Kati Kask")).toEqual(idsOf("change"));
  });

  test("the search finds done requests in the done list, and the open ones in the open list", async () => {
    expect((await pageRequests(db, { search: "vana", handled: true, page: 1 })).rows.map((r) => r.id)).toEqual(idsOf("doneContact"));
    expect(await open("vana")).toEqual([]);
    expect((await pageRequests(db, { search: "vana", handled: false, page: 1 })).total).toBe(0);
  });

  test("an empty or blank search is no search", async () => {
    expect(await open("")).toHaveLength(6);
    expect(await open("   ")).toHaveLength(6);
  });
});

describe("requestCounts: the open requests of each tab", () => {
  test("open ones only, per tab; the e-learning interest is a Kontakt request; the same numbers as the menu badge", async () => {
    const counts = await requestCounts(db);
    expect(counts).toEqual({ kontakt: 2, individuaal: 1, praktika: 1, ootenimekiri: 1, muutmine: 1 });
    const badge = (await adminCounts(db, "maria@example.test", new Date("2026-10-21T09:00:00Z"))).openRequests;
    expect(counts).toEqual({ kontakt: badge.contact, individuaal: badge.individual, praktika: badge.practice, ootenimekiri: badge.waitlist, muutmine: badge.change_request });
  });

  test("a tab with nothing open is 0", async () => {
    await db.delete(requests);
    expect(await requestCounts(db)).toEqual({ kontakt: 0, individuaal: 0, praktika: 0, ootenimekiri: 0, muutmine: 0 });
  });

  test("marking done takes one off the tab's count; opening it again puts it back", async () => {
    await saveHandled(db, { id: ids.practice, handled: true, expected: false });
    expect((await requestCounts(db)).praktika).toBe(0);
    await saveHandled(db, { id: ids.practice, handled: false, expected: true });
    expect((await requestCounts(db)).praktika).toBe(1);
  });
});

describe("„Märgi tehtuks“ and „Võta tagasi“", () => {
  const stored = async (key: string) => (await db.select().from(requests)).find((r) => r.id === ids[key])!.handled;
  const done = (key: string, over: Record<string, unknown> = {}) => saveHandled(db, { id: ids[key], handled: true, expected: false, ...over });

  test("marking a request done answers with the version the bar's undo will ask for; the undo opens it again", async () => {
    const marked = await done("practice");
    expect(marked).toMatchObject({ ok: true });
    if (!marked.ok) throw new Error("not ok");
    expect(marked.version).toMatch(/^\d+$/);
    expect(await stored("practice")).toBe(true);

    expect(await saveHandled(db, { id: ids.practice, handled: false, expected: true, version: marked.version })).toMatchObject({ ok: true });
    expect(await stored("practice")).toBe(false);
  });

  test("„Märgi tegemata“ of a done request needs no version", async () => {
    expect(await saveHandled(db, { id: ids.doneContact, handled: false, expected: true })).toMatchObject({ ok: true });
    expect(await stored("doneContact")).toBe(false);
  });

  test("an undo after the request was reopened elsewhere is refused and writes nothing", async () => {
    const marked = await done("practice");
    if (!marked.ok) throw new Error("not ok");
    await saveHandled(db, { id: ids.practice, handled: false, expected: true }); // the other tab: „Märgi tegemata“
    expect(await saveHandled(db, { id: ids.practice, handled: false, expected: true, version: marked.version })).toEqual({ ok: false, error: "stale" });
    expect(await stored("practice")).toBe(false);
  });

  test("an undo after another tab reopened it and closed it again is refused too: the request was changed since", async () => {
    const marked = await done("practice");
    if (!marked.ok) throw new Error("not ok");
    await saveHandled(db, { id: ids.practice, handled: false, expected: true });
    await saveHandled(db, { id: ids.practice, handled: true, expected: false });
    expect(await stored("practice")).toBe(true);
    // the stored value is the one the undo expects, but it is a newer change: it stays
    expect(await saveHandled(db, { id: ids.practice, handled: false, expected: true, version: marked.version })).toEqual({ ok: false, error: "stale" });
    expect(await stored("practice")).toBe(true);
  });

  test("a press built on an old card is refused: the request is not what the card showed", async () => {
    await done("practice");
    // another tab already marked it: this card still says „Märgi tehtuks“
    expect(await done("practice")).toEqual({ ok: false, error: "stale" });
    expect(await saveHandled(db, { id: ids.doneContact, handled: true, expected: false })).toEqual({ ok: false, error: "stale" });
    expect(await stored("doneContact")).toBe(true);
  });

  test("a request that is gone, and input that is no request", async () => {
    expect(await saveHandled(db, { id: 9999, handled: true, expected: false })).toEqual({ ok: false, error: "notFound" });
    const bad = [
      { id: 0, handled: true, expected: false },
      { id: ids.practice, handled: "1", expected: false },
      { id: ids.practice, handled: true },
      { id: ids.practice, handled: true, expected: false, version: "12 or 1=1" },
      { id: ids.practice, handled: true, expected: false, version: "" },
      null,
      "yes",
    ];
    for (const input of bad) expect(await saveHandled(db, input), JSON.stringify(input)).toEqual({ ok: false, error: "invalid" });
    expect(await stored("practice")).toBe(false);
  });
});

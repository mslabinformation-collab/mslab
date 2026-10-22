import { beforeAll, describe, expect, test } from "vitest";
import { makeTestDb } from "./helpers";
import type { Db } from "@/db/client";
import { courses, courseSessions, registrations } from "@/db/schema";
import { countRegistrations, listRegistrationScopes, pageRegistrations, registrationCounts, type RegistrationFilter } from "@/db/queries/admin";
import type { RegStatus } from "@/domain/registration";

// Admin UX pass, piece 2, Task 4 (A2 Registreerimised, B7): the list's search over name, e-mail and phone, its course / session scope, and the counts
// on its two pill rows, on a real (PGlite) database. A registration is found by a part of its name or e-mail (any case, `%` `_` `\` taken
// literally) or by the digits of its phone, whatever spaces, dashes and plus were typed or stored; each pill's count is the number of rows the
// pill shows (B9).

const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };

let db: Db;
let brows: { id: number }; // contact course „Kulmude LAMI“
let lash: { id: number }; // contact course „Lash Lift“
let online: { id: number }; // e-course
let sessionA: { id: number }; // Kulmude LAMI, 12.12.2026
let sessionB: { id: number }; // Kulmude LAMI, 19.12.2026
let sessionC: { id: number }; // Lash Lift, 05.12.2026

type Seed = Partial<typeof registrations.$inferInsert> & { name: string };
const ids = new Map<string, number>();
async function add(seed: Seed) {
  const [r] = await db
    .insert(registrations)
    .values({ courseId: brows.id, courseSessionId: sessionA.id, kind: "group", email: `${seed.name.replace(/\W+/g, "").toLowerCase()}@example.test`, paymentChoice: "half", ...seed })
    .returning();
  ids.set(seed.name, r.id);
  return r;
}
/** The names found by `filter`, newest first (the list's own order). */
const names = async (filter: RegistrationFilter) => (await pageRegistrations(db, filter, 1)).rows.map((r) => r.name).sort();

beforeAll(async () => {
  db = await makeTestDb();
  [brows] = await db.insert(courses).values({ ...base, slug: "lami", type: "contact", title: { et: "Kulmude LAMI" }, priceGroup: 22000, priceIndividual: 30000 }).returning();
  [lash] = await db.insert(courses).values({ ...base, slug: "lash", type: "contact", title: { et: "Lash Lift" }, priceGroup: 29000, priceIndividual: 39000 }).returning();
  [online] = await db.insert(courses).values({ ...base, slug: "ekursus", type: "e_learning", title: { et: "Kulmumeistri e-koolitus" }, price: 19000 }).returning();
  [sessionA] = await db.insert(courseSessions).values({ courseId: brows.id, startsAt: new Date("2026-12-12T08:00:00Z"), city: "Tartu" }).returning();
  [sessionB] = await db.insert(courseSessions).values({ courseId: brows.id, startsAt: new Date("2026-12-19T08:00:00Z"), city: "Tartu" }).returning();
  [sessionC] = await db.insert(courseSessions).values({ courseId: lash.id, startsAt: new Date("2026-12-05T08:00:00Z"), city: "Pärnu" }).returning();

  // contact course, session A
  await add({ name: "Kati Kask", email: "kati.kask@example.test", phone: "+372 5123 4567", status: "awaiting_prepayment", createdAt: new Date("2026-10-19T08:00:00Z") });
  await add({ name: "Mari Mets", email: "mari@example.test", phone: "5000-0002", status: "confirmed", paidCents: 22000, createdAt: new Date("2026-10-18T08:00:00Z") });
  await add({ name: "Мария Кузнецова", email: "maria.k@example.test", phone: "+372 50000003", status: "confirmed", createdAt: new Date("2026-10-17T08:00:00Z") });
  // contact course, session B
  await add({ name: "50% Liis", email: "liis@example.test", phone: "", courseSessionId: sessionB.id, status: "cancelled", createdAt: new Date("2026-10-16T08:00:00Z") });
  await add({ name: "a_b Tamm", email: "tamm@example.test", phone: "+37250000005", courseSessionId: sessionB.id, status: "awaiting_prepayment", createdAt: new Date("2026-10-15T08:00:00Z") });
  await add({ name: "Back\\slash Saar", email: "saar@example.test", phone: "5000 0006", courseSessionId: sessionB.id, status: "confirmed", createdAt: new Date("2026-10-14T08:00:00Z") });
  // the other contact course
  await add({ name: "Lea Lash", email: "lea@example.test", phone: "+372 5000 0007", courseId: lash.id, courseSessionId: sessionC.id, status: "confirmed", createdAt: new Date("2026-10-13T08:00:00Z") });
  await add({ name: "Kristel Kask", email: "kristel@example.test", phone: "612 3456", courseId: lash.id, courseSessionId: sessionC.id, status: "cancelled", createdAt: new Date("2026-10-12T08:00:00Z") });
  // e-learning: no session
  await add({ name: "Eda Ekursus", email: "eda@example.test", phone: "+372 5000 0009", courseId: online.id, courseSessionId: null, kind: "individual", status: "confirmed", createdAt: new Date("2026-10-11T08:00:00Z") });
  await add({ name: "Ene Ekursus", email: "ene@example.test", phone: "+372 5000 0010", courseId: online.id, courseSessionId: null, kind: "individual", status: "awaiting_prepayment", createdAt: new Date("2026-10-10T08:00:00Z") });
  // digits in a name and an e-mail, and no phone
  await add({ name: "Ott 2027", email: "ott2027@example.test", phone: "", status: "confirmed", createdAt: new Date("2026-10-09T08:00:00Z") });
});

describe("search (?otsi=): name, e-mail and phone", () => {
  test("a part of a name, any case", async () => {
    expect(await names({ search: "ati" })).toEqual(["Kati Kask"]);
    expect(await names({ search: "KATI" })).toEqual(["Kati Kask"]);
    expect(await names({ search: "kask" })).toEqual(["Kati Kask", "Kristel Kask"]);
  });

  test("a Cyrillic name, in upper or lower case", async () => {
    expect(await names({ search: "МАРИЯ" })).toEqual(["Мария Кузнецова"]);
    expect(await names({ search: "кузнецова" })).toEqual(["Мария Кузнецова"]);
  });

  test("a part of the e-mail, any case", async () => {
    expect(await names({ search: "kati.kask@" })).toEqual(["Kati Kask"]);
    expect(await names({ search: "TAMM@EXAMPLE" })).toEqual(["a_b Tamm"]);
    expect(await names({ search: "maria.k" })).toEqual(["Мария Кузнецова"]);
  });

  test("a phone typed with spaces finds the number stored as „+372 51234567“, and the other way round", async () => {
    // stored with one spacing, typed with another
    expect(await names({ search: "5123 4567" })).toEqual(["Kati Kask"]);
    expect(await names({ search: "+372 5123 4567" })).toEqual(["Kati Kask"]);
    expect(await names({ search: "5123-4567" })).toEqual(["Kati Kask"]);
    expect(await names({ search: "51234567" })).toEqual(["Kati Kask"]);
    // stored „5000-0002“ and „+372 50000003“
    expect(await names({ search: "5000 0002" })).toEqual(["Mari Mets"]);
    expect(await names({ search: "5000 0003" })).toEqual(["Мария Кузнецова"]);
  });

  test("a number typed with +372 finds the same number stored without the country code, and one stored compact", async () => {
    // Mari's number is stored „5000-0002“ (no +372): typed with it, the search is by the digits after the 372
    expect(await names({ search: "+372 5000 0002" })).toEqual(["Mari Mets"]);
    expect(await names({ search: "+37250000002" })).toEqual(["Mari Mets"]);
    // a_b Tamm's is stored „+37250000005“: found typed with or without the code, spaced or not
    expect(await names({ search: "+372 5000 0005" })).toEqual(["a_b Tamm"]);
    expect(await names({ search: "5000 0005" })).toEqual(["a_b Tamm"]);
    expect(await names({ search: "50000005" })).toEqual(["a_b Tamm"]);
    // Kati's „+372 5123 4567“ typed without the code, and with it
    expect(await names({ search: "5123 4567" })).toEqual(["Kati Kask"]);
    expect(await names({ search: "+372 5123 4567" })).toEqual(["Kati Kask"]);
    // a 372 with 7 digits or fewer after it is digits typed so far: it finds the numbers stored with the code
    expect((await names({ search: "+372 5000" })).length).toBeGreaterThanOrEqual(4);
    expect(await names({ search: "+372 6000" })).toEqual([]);
  });

  test("a 7-digit landline typed with +372 finds the number stored without it", async () => {
    // Kristel's number is stored „612 3456“ (no +372, 7 digits)
    expect(await names({ search: "+372 612 3456" })).toEqual(["Kristel Kask"]);
    expect(await names({ search: "+3726123456" })).toEqual(["Kristel Kask"]);
    expect(await names({ search: "612 3456" })).toEqual(["Kristel Kask"]);
    // 6 digits after the 372 are a number typed so far: whole, so nobody stored without the code is found by it
    expect(await names({ search: "+372 612 345" })).toEqual([]);
  });

  test("a phone is searched from 3 digits; fewer digits are no phone (a name like „Kati 5“ stays a name)", async () => {
    expect((await names({ search: "000" })).length).toBeGreaterThan(5); // 3 digits: a part of the number
    // 1 digit: found in a name only (if it were a phone, nearly everybody has a 5 in the number)
    expect(await names({ search: "5" })).toEqual(["50% Liis"]);
    expect(await names({ search: "Kati 5" })).toEqual([]);
    expect(await names({ search: "99" })).toEqual([]);
  });

  test("a search with digits still finds an e-mail or a name that holds them", async () => {
    expect(await names({ search: "2027" })).toEqual(["Ott 2027"]);
    expect(await names({ search: "ott2027" })).toEqual(["Ott 2027"]);
  });

  test("`%`, `_` and `\\` are taken literally", async () => {
    expect(await names({ search: "%" })).toEqual(["50% Liis"]);
    expect(await names({ search: "50%" })).toEqual(["50% Liis"]);
    expect(await names({ search: "_" })).toEqual(["a_b Tamm"]);
    expect(await names({ search: "a_b" })).toEqual(["a_b Tamm"]);
    expect(await names({ search: "k_sk" })).toEqual([]); // `_` is not „any character“
    expect(await names({ search: "\\" })).toEqual(["Back\\slash Saar"]);
    expect(await names({ search: "back\\s" })).toEqual(["Back\\slash Saar"]);
  });

  test("an empty or blank search filters nothing", async () => {
    const all = await countRegistrations(db, {});
    expect(await countRegistrations(db, { search: "" })).toBe(all);
    expect(await countRegistrations(db, { search: "   " })).toBe(all);
  });

  test("the search works with the status, the form and the scope", async () => {
    expect(await names({ search: "kask", status: "awaiting_prepayment" })).toEqual(["Kati Kask"]);
    expect(await names({ search: "kask", status: "cancelled" })).toEqual(["Kristel Kask"]);
    expect(await names({ search: "kask", type: "contact", courseId: lash.id })).toEqual(["Kristel Kask"]);
    expect(await names({ search: "ekursus", type: "contact" })).toEqual([]);
    expect(await names({ search: "ekursus", type: "e_learning" })).toEqual(["Eda Ekursus", "Ene Ekursus"]);
  });

  test("the pages are counted under the search, newest first", async () => {
    const page = await pageRegistrations(db, { search: "kask" }, 1);
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r.name)).toEqual(["Kati Kask", "Kristel Kask"]);
  });
});

describe("scope: one course (?koolitus=) or one session (?toimumine=)", () => {
  test("a session limits to its registrations", async () => {
    expect(await names({ sessionId: sessionA.id })).toEqual(["Kati Kask", "Mari Mets", "Ott 2027", "Мария Кузнецова"]);
    expect(await names({ sessionId: sessionB.id })).toEqual(["50% Liis", "Back\\slash Saar", "a_b Tamm"].sort());
    expect(await names({ sessionId: sessionC.id })).toEqual(["Kristel Kask", "Lea Lash"]);
  });

  test("a course limits to all its sessions; the e-course has none", async () => {
    expect((await names({ courseId: brows.id })).length).toBe(7); // session A: 4, session B: 3
    expect(await names({ courseId: lash.id })).toEqual(["Kristel Kask", "Lea Lash"]);
    expect(await names({ courseId: online.id })).toEqual(["Eda Ekursus", "Ene Ekursus"]);
  });

  test("the scope works with the search and the status", async () => {
    // („mari“ is in Mari Mets's name and in Мария Кузнецова's e-mail address, maria.k@…)
    expect(await names({ sessionId: sessionA.id, search: "mari" })).toEqual(["Mari Mets", "Мария Кузнецова"]);
    expect(await names({ sessionId: sessionB.id, search: "mari" })).toEqual([]);
    expect(await names({ courseId: brows.id, status: "cancelled" })).toEqual(["50% Liis"]);
    expect(await names({ sessionId: sessionB.id, search: "kask" })).toEqual([]);
  });
});

describe("pill counts (B9): the status row counts under the other filters, so a pill's count is the rows it shows", () => {
  const STATUS: Record<"ootab" | "kinnitatud" | "tuhistatud", RegStatus> = { ootab: "awaiting_prepayment", kinnitatud: "confirmed", tuhistatud: "cancelled" };

  /** Every status pill against the rows the same filter shows with that pill chosen (the form pills carry no count: README A2). */
  async function expectPillsToMatchRows(filter: RegistrationFilter) {
    const counts = await registrationCounts(db, filter);
    const { status: _status, ...rest } = filter;
    void _status;
    // under the form (and the search and the scope), whatever status is chosen
    expect(counts.status.all, "status all").toBe(await countRegistrations(db, rest));
    for (const [key, one] of Object.entries(STATUS)) expect(counts.status[key as keyof typeof STATUS], `status ${key}`).toBe(await countRegistrations(db, { ...rest, status: one }));
    return counts;
  }

  test("no filter: every registration, by status", async () => {
    const counts = await expectPillsToMatchRows({});
    expect(counts).toEqual({ status: { all: 11, ootab: 3, kinnitatud: 6, tuhistatud: 2 } });
  });

  test("with a search: the counts follow the search", async () => {
    const counts = await expectPillsToMatchRows({ search: "kask" });
    expect(counts.status).toEqual({ all: 2, ootab: 1, kinnitatud: 0, tuhistatud: 1 });
    await expectPillsToMatchRows({ search: "5000" });
    await expectPillsToMatchRows({ search: "ekursus" });
    await expectPillsToMatchRows({ search: "zzz" });
  });

  test("with a scope: the counts follow the course or the session", async () => {
    const session = await expectPillsToMatchRows({ sessionId: sessionB.id });
    expect(session.status).toEqual({ all: 3, ootab: 1, kinnitatud: 1, tuhistatud: 1 });
    const course = await expectPillsToMatchRows({ courseId: online.id });
    expect(course.status).toEqual({ all: 2, ootab: 1, kinnitatud: 1, tuhistatud: 0 });
  });

  test("the row ignores the status chosen (its own pills show every status) and keeps the form chosen", async () => {
    const withStatus = await expectPillsToMatchRows({ status: "confirmed" });
    expect(withStatus.status).toEqual({ all: 11, ootab: 3, kinnitatud: 6, tuhistatud: 2 });
    const withType = await expectPillsToMatchRows({ type: "e_learning" });
    expect(withType.status).toEqual({ all: 2, ootab: 1, kinnitatud: 1, tuhistatud: 0 });
    const contact = await expectPillsToMatchRows({ type: "contact" });
    expect(contact.status).toEqual({ all: 9, ootab: 2, kinnitatud: 5, tuhistatud: 2 });
  });

  test("everything together", async () => {
    await expectPillsToMatchRows({ search: "5000", type: "contact", status: "confirmed", courseId: brows.id });
    await expectPillsToMatchRows({ search: "a", status: "awaiting_prepayment", sessionId: sessionA.id });
  });

  test("a client's drawer and the id filters keep working with the counts", async () => {
    const some = [ids.get("Kati Kask")!, ids.get("Mari Mets")!, ids.get("Lea Lash")!];
    const counts = await expectPillsToMatchRows({ ids: some });
    expect(counts.status).toEqual({ all: 3, ootab: 1, kinnitatud: 2, tuhistatud: 0 });
    expect((await registrationCounts(db, { ids: [] })).status).toEqual({ all: 0, ootab: 0, kinnitatud: 0, tuhistatud: 0 });
  });
});

describe("the scope select's options", () => {
  const NOW = new Date("2026-12-10T09:00:00Z");

  test("every course in its order, with its sessions: the coming ones first (nearest first), then the past ones (newest first)", async () => {
    const [past] = await db.insert(courseSessions).values({ courseId: brows.id, startsAt: new Date("2026-11-07T08:00:00Z"), city: "Pärnu" }).returning();
    const [older] = await db.insert(courseSessions).values({ courseId: brows.id, startsAt: new Date("2026-09-05T08:00:00Z"), city: "Tallinn" }).returning();
    const scopes = await listRegistrationScopes(db, NOW);
    expect(scopes.map((s) => s.course.id)).toEqual([brows.id, lash.id, online.id]);
    expect(scopes[0].sessions.map((s) => s.id)).toEqual([sessionA.id, sessionB.id, past.id, older.id]);
    expect(scopes[0].sessions[0]).toMatchObject({ id: sessionA.id, city: "Tartu" });
    expect(scopes[0].sessions[0].startsAt).toEqual(new Date("2026-12-12T08:00:00Z"));
    expect(scopes[1].sessions.map((s) => s.id)).toEqual([sessionC.id]);
    expect(scopes[2].sessions).toEqual([]);
    expect(scopes[0].course.title).toEqual({ et: "Kulmude LAMI" });
  });

  test("a session today is still coming (the day is the Tallinn day)", async () => {
    const [today] = await db.insert(courseSessions).values({ courseId: lash.id, startsAt: new Date("2026-12-10T05:00:00Z"), city: "Viljandi" }).returning();
    const scopes = await listRegistrationScopes(db, new Date("2026-12-10T20:00:00Z"));
    const lashSessions = scopes.find((s) => s.course.id === lash.id)!.sessions;
    expect(lashSessions.map((s) => s.id)).toEqual([today.id, sessionC.id]);
  });
});

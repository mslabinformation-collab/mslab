import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { makeTestDb } from "./helpers";
import type { Db } from "@/db/client";
import { listRegistrations } from "@/db/queries/admin";
import { clients, clientSessions, contracts, courseAccess, courses, courseSessions, courseTests, practicePackages, protocols, registrations, requests, subscribers, testAttempts } from "@/db/schema";
import { PAGE_SIZE } from "@/domain/paging";
import { registrationHeading as heading } from "@/domain/registration-card";
import { getDict } from "@/i18n/locales";
import {
  addClient,
  addClientForm,
  clientDetail,
  clientLabel,
  grantAccess,
  grantAccessForm,
  listClients,
  listEcourses,
  revokeAccess,
  revokeAccessForm,
} from "@/server/admin-clients";
import { issueClientLogin, redeemClientCode } from "@/server/client-auth";
import { loadDashboard } from "@/server/client-data";

// Phase 2a Task 9: the admin's Õpilased on a real (PGlite) database — the list (filters, search, paging, the course count),
// one student's drawer, "Lisa õpilane", and e-course access granted and ended by an admin.

const registrationHeading = (r: Parameters<typeof heading>[0]) => heading(r, getDict("et").account.dashboard.untitled);

const NOW = new Date("2026-10-04T09:00:00Z"); // 12:00 in Tallinn (summer time)
const ADMIN = "maria@example.test";
const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

let db: Db;
let contact: { id: number };
let ecourse: { id: number };
let draftEcourse: { id: number };
let session: { id: number };

beforeEach(async () => {
  db = await makeTestDb();
  [contact] = await db.insert(courses).values({ ...base, slug: "kulm", type: "contact", title: { et: "Kulmude lamineerimine" }, priceGroup: 35000, published: true, sort: 1 }).returning();
  [ecourse] = await db.insert(courses).values({ ...base, slug: "e-kulm", type: "e_learning", title: { et: "Kulmumeistri e-koolitus" }, price: 9500, accessMonths: 6, published: true, sort: 2 }).returning();
  [draftEcourse] = await db.insert(courses).values({ ...base, slug: "e-ripsmed", type: "e_learning", title: { et: "Ripsmete e-koolitus" }, price: 9500, accessMonths: null, published: false, sort: 3 }).returning();
  [session] = await db.insert(courseSessions).values({ courseId: contact.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio" }).returning();
});

const client = async (email: string, over: Partial<typeof clients.$inferInsert> = {}) => (await db.insert(clients).values({ email, ...over }).returning())[0];
const register = async (clientId: number | null, email: string, over: Partial<typeof registrations.$inferInsert> = {}) =>
  (
    await db
      .insert(registrations)
      .values({ courseId: contact.id, courseSessionId: session.id, kind: "group", name: "Liis Tamm", email, paymentChoice: "half", clientId, ...over })
      .returning()
  )[0];
const access = async (clientId: number, over: Partial<typeof courseAccess.$inferInsert> = {}) =>
  (await db.insert(courseAccess).values({ clientId, courseId: ecourse.id, grantedBy: "e2e", expiresAt: new Date("2027-04-04T20:59:59.999Z"), ...over }).returning())[0];

describe("listClients", () => {
  test("newest first, with the name (own, else the latest registration's) and the number of courses (registrations not cancelled + accesses not ended by an admin)", async () => {
    const kati = await client("kati@example.test", { name: "Kati Kask", createdAt: new Date("2026-10-01T10:00:00Z") });
    const liis = await client("liis@example.test", { createdAt: new Date("2026-10-02T10:00:00Z") });
    const olga = await client("olga@example.test", { createdAt: new Date("2026-10-03T10:00:00Z") });
    await register(liis.id, liis.email, { name: "Liis Vana", createdAt: new Date("2026-09-01T10:00:00Z") });
    await register(liis.id, liis.email, { name: "Liis Tamm", status: "cancelled", createdAt: new Date("2026-09-20T10:00:00Z") });
    await access(liis.id, { revokedAt: NOW });
    await access(liis.id, { courseId: draftEcourse.id });
    await access(kati.id, { courseId: draftEcourse.id, expiresAt: new Date("2026-01-01T00:00:00Z") });
    await register(null, "someone@example.test"); // not linked: counts for nobody

    const list = await listClients(db, { filter: "all", q: "", page: 1 });
    expect(list).toMatchObject({ page: 1, pages: 1, total: 3 });
    expect(list.rows.map((r) => [r.email, r.name, r.courses])).toEqual([
      ["olga@example.test", "", 0],
      ["liis@example.test", "Liis Tamm", 2], // the cancelled registration and the ended access do not count
      ["kati@example.test", "Kati Kask", 1], // an access that ran out does: she took that course
    ]);
    expect(list.rows[0].createdAt).toEqual(olga.createdAt);
  });

  test("E-õpe: any e-course access (open, run out or ended); Kontaktõpe: a registration on a contact course", async () => {
    const onlyE = await client("e@example.test");
    const onlyK = await client("k@example.test");
    const both = await client("both@example.test");
    const eReg = await client("ereg@example.test"); // a registration on an e-course only: neither filter
    await client("none@example.test");
    await access(onlyE.id, { expiresAt: new Date("2026-01-01T00:00:00Z") });
    await register(onlyK.id, onlyK.email, { status: "cancelled" });
    await access(both.id, { revokedAt: NOW });
    await register(both.id, both.email);
    await register(eReg.id, eReg.email, { courseId: ecourse.id, courseSessionId: null });

    const emails = async (filter: "all" | "e" | "k") => (await listClients(db, { filter, q: "", page: 1 })).rows.map((r) => r.email).sort();
    expect(await emails("e")).toEqual(["both@example.test", "e@example.test"]);
    expect(await emails("k")).toEqual(["both@example.test", "k@example.test"]);
    expect(await emails("all")).toHaveLength(5);
  });

  test("search: a part of the name or the e-mail, any case; % and _ are taken literally; combined with a filter", async () => {
    const kati = await client("kati.kask@example.test", { name: "Kati Kask" });
    const liis = await client("liis_t@example.test");
    await register(liis.id, liis.email, { name: "Liis Õunapuu" });
    await client("x100%@example.test");
    await access(kati.id);

    const find = async (q: string, filter: "all" | "e" | "k" = "all") => (await listClients(db, { filter, q, page: 1 })).rows.map((r) => r.email);
    expect(await find("KASK")).toEqual(["kati.kask@example.test"]);
    expect(await find("õunapuu")).toEqual(["liis_t@example.test"]); // the registration's name
    expect(await find("s_t")).toEqual(["liis_t@example.test"]); // "_" is an underscore, not any character
    expect(await find("i_k")).toEqual([]);
    expect(await find("100%")).toEqual(["x100%@example.test"]);
    expect(await find("%")).toEqual(["x100%@example.test"]); // not "everything"
    expect(await find("\\")).toEqual([]);
    expect(await find("'; drop table clients; --")).toEqual([]);
    expect(await find("example", "e")).toEqual(["kati.kask@example.test"]);
    expect(await db.select().from(clients)).toHaveLength(3);
  });

  test("50 a page; a page beyond the end shows the last one", async () => {
    await db.insert(clients).values(Array.from({ length: PAGE_SIZE + 3 }, (_, i) => ({ email: `s${i}@example.test`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) })));
    const first = await listClients(db, { filter: "all", q: "", page: 1 });
    expect(first).toMatchObject({ page: 1, pages: 2, total: PAGE_SIZE + 3 });
    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(first.rows[0].email).toBe(`s${PAGE_SIZE + 2}@example.test`);
    const second = await listClients(db, { filter: "all", q: "", page: 2 });
    expect(second.rows.map((r) => r.email)).toEqual(["s2@example.test", "s1@example.test", "s0@example.test"]);
    expect((await listClients(db, { filter: "all", q: "", page: 99 })).page).toBe(2);
    expect((await listClients(db, { filter: "all", q: "nobody", page: 3 })).rows).toEqual([]);
  });
});

describe("clientDetail", () => {
  test("her registrations, requests (named and with their subject, as Päringud), accesses with their state, contracts; nothing of anybody else", async () => {
    const kati = await client("kati@example.test", { phone: "+372 5555 0101", locale: "ru" });
    const other = await client("other@example.test");
    const reg = await register(kati.id, kati.email, { name: "Kati Kask" });
    await register(other.id, other.email);
    await db.insert(practicePackages).values({ code: "MINI", name: { et: "Mini praktika" }, tagline: { et: "" }, models: 2, durationLabel: { et: "4 ak" }, price: 9000 });
    const at = (day: number) => new Date(Date.UTC(2026, 9, day, 10));
    await db.insert(requests).values([
      { kind: "change_request", payload: { registrationId: reg.id, kind: "cancel", message: "", email: kati.email }, clientId: kati.id, createdAt: at(3) },
      { kind: "contact", payload: { course: "e-kulm", intent: "purchase", email: kati.email, locale: "ru" }, clientId: kati.id, createdAt: at(2) },
      { kind: "practice", payload: { package: "MINI", course: "vaba tekst", email: kati.email }, clientId: kati.id, createdAt: at(1) },
      { kind: "contact", payload: { name: "Kati", message: "Tere!", email: kati.email }, clientId: kati.id, handled: true, createdAt: new Date("2026-09-30T10:00:00Z") },
      { kind: "individual", payload: { course: "kulm", email: kati.email }, clientId: kati.id, handled: true, createdAt: new Date("2026-09-29T10:00:00Z") },
      { kind: "change_request", payload: { registrationId: 999_999, kind: "change", email: kati.email }, clientId: kati.id, createdAt: new Date("2026-09-28T10:00:00Z") },
      { kind: "practice", payload: { email: other.email }, clientId: other.id },
    ]);
    const open = await access(kati.id, { grantedBy: ADMIN, grantedAt: new Date("2026-10-01T10:00:00Z") });
    await access(kati.id, { courseId: draftEcourse.id, expiresAt: new Date("2026-10-01T00:00:00Z"), grantedAt: new Date("2026-04-01T10:00:00Z") });
    // her contracts (contracts Task 5): the e-course's from the terms gate, and the registration's, replaced by a newer one; another student's is not hers
    const fields = { school: { company: "MS LAB OÜ", registryCode: "", address: "" }, student: { name: "Kati Kask", email: kati.email }, course: "Kulmumeistri e-koolitus", session: "", price: "", payment: "" };
    const made = { locale: "et" as const, fields, body: "Tekst.", version: "1" };
    await db.insert(contracts).values([
      { ...made, kind: "ecourse", clientId: kati.id, accessId: open.id, courseId: ecourse.id, title: "E-koolituse tingimused", acceptedAt: new Date("2026-10-02T11:00:00Z"), acceptedVia: "terms" },
      { ...made, kind: "contact", clientId: kati.id, registrationId: reg.id, title: "Kontaktkoolituse leping", acceptedAt: new Date("2026-10-01T11:00:00Z"), acceptedVia: "form", supersededAt: new Date("2026-10-03T11:00:00Z"), body: "Vana tekst." },
      { ...made, kind: "contact", clientId: kati.id, registrationId: reg.id, title: "Kontaktkoolituse leping", acceptedAt: new Date("2026-10-03T11:00:00Z"), acceptedVia: "account", sentAt: new Date("2026-10-03T11:05:00Z") },
      { ...made, kind: "ecourse", clientId: other.id, courseId: ecourse.id, title: "Teise leping", acceptedAt: new Date("2026-10-02T12:00:00Z"), acceptedVia: "terms" },
    ]);

    const d = (await clientDetail(db, kati.id, NOW))!;
    expect(d.client).toMatchObject({ id: kati.id, email: "kati@example.test", name: "Kati Kask", ownName: "", phone: "+372 5555 0101", locale: "ru" });
    expect(d.registrations.map((r) => r.id)).toEqual([reg.id]);
    expect(registrationHeading(d.registrations[0])).toEqual({ title: "Kulmude lamineerimine", time: "14.11.2026 · 10:00", place: "Pärnu, MS LAB stuudio" });
    expect(d.requests.map((r) => [r.kind, r.interest, r.wish, r.subject, r.handled])).toEqual([
      ["change_request", false, "cancel", "Kulmude lamineerimine — 14.11.2026 · 10:00", false],
      ["contact", true, null, "Kulmumeistri e-koolitus", false], // E-õppe huvi
      ["practice", false, null, "Mini praktika (MINI)", false], // the package, not the free-text course
      ["contact", false, null, null, true],
      ["individual", false, null, "Kulmude lamineerimine", true],
      ["change_request", false, "change", null, false], // its registration is gone
    ]);
    expect(d.access.map((a) => [a.courseId, a.state, a.grantedBy])).toEqual([
      [ecourse.id, "active", ADMIN],
      [draftEcourse.id, "expired", "e2e"],
    ]);
    expect(d.access[0]).toMatchObject({ id: open.id, slug: "e-kulm", title: { et: "Kulmumeistri e-koolitus" } });
    // the newest acceptance first, the superseded one too; the text itself stays out of the drawer's data (the PDF has it)
    expect(d.contracts.map((k) => [k.kind, k.title, k.acceptedVia, k.registrationId, k.supersededAt !== null, k.sentAt !== null])).toEqual([
      ["contact", "Kontaktkoolituse leping", "account", reg.id, false, true],
      ["ecourse", "E-koolituse tingimused", "terms", null, false, false],
      ["contact", "Kontaktkoolituse leping", "form", reg.id, true, false],
    ]);
    expect(Object.keys(d.contracts[0]).sort()).toEqual(["acceptedAt", "acceptedVia", "id", "kind", "locale", "registrationId", "sentAt", "supersededAt", "title"]);
    await revokeAccess(db, { clientId: kati.id, accessId: open.id, now: NOW });
    expect((await clientDetail(db, kati.id, NOW))!.access[0].state).toBe("revoked");
    expect(await clientDetail(db, 999_999, NOW)).toBeNull();
  });

  test("the label: her name, else the latest registration's, else the e-mail", async () => {
    const a = await client("a@example.test", { name: "Anu" });
    const b = await client("b@example.test");
    const c = await client("c@example.test");
    await register(b.id, b.email, { name: "Berit Saar" });
    expect([await clientLabel(db, a.id), await clientLabel(db, b.id), await clientLabel(db, c.id), await clientLabel(db, 999_999)]).toEqual(["Anu", "Berit Saar", "c@example.test", null]);
  });

  test("the drawer's newsletter line: yes, waiting for confirmation, or no (phase 2c)", async () => {
    const kati = await client("kati@example.test");
    expect((await clientDetail(db, kati.id, NOW))!.newsletter).toBe("no");
    await db.insert(subscribers).values({ email: "Kati@example.test", token: "n1" });
    expect((await clientDetail(db, kati.id, NOW))!.newsletter).toBe("pending");
    await db.update(subscribers).set({ confirmedAt: NOW });
    expect((await clientDetail(db, kati.id, NOW))!.newsletter).toBe("yes");
  });

  test("the e-courses to pick from: e-learning only, drafts too, in the public order, with today + their access months (12 without)", async () => {
    expect(await listEcourses(db, NOW)).toEqual([
      { id: ecourse.id, title: { et: "Kulmumeistri e-koolitus" }, published: true, accessMonths: 6, until: "2027-04-04" },
      { id: draftEcourse.id, title: { et: "Ripsmete e-koolitus" }, published: false, accessMonths: null, until: "2027-10-04" },
    ]);
  });

  test("each access with its steps, its protocol and her newest score; each registration with its protocol and whether it is a contact course (e-course completion, spec §5.5)", async () => {
    const kati = await client("kati@example.test", { name: "Kati" });
    await db.update(courses).set({ protocolStages: ["Ettevalmistus", "Värvimine"] }).where(eq(courses.id, ecourse.id));
    const question = { id: "qvalik01", kind: "choice" as const, text: "Üks?", options: [{ id: "o1oige01", text: "Jah", correct: true }, { id: "o1vale01", text: "Ei", correct: false }] };
    await db.insert(courseTests).values({ courseId: ecourse.id, questions: [question], passPercent: 80, tries: 3 });
    const open = await access(kati.id);
    const done = await access(kati.id, { courseId: draftEcourse.id, completedAt: new Date("2026-10-01T10:00:00Z") });
    const openOnly = { id: "qavatud1", kind: "open" as const, text: "Kirjelda." };
    await db.insert(testAttempts).values([
      { clientId: kati.id, courseId: ecourse.id, number: 1, questions: [question], answers: { qvalik01: ["o1vale01"] }, correct: 0, total: 1, status: "failed", submittedAt: new Date("2026-10-02T10:00:00Z") },
      { clientId: kati.id, courseId: ecourse.id, number: 2, questions: [question], answers: { qvalik01: ["o1oige01"] }, correct: 1, total: 1, status: "passed", submittedAt: new Date("2026-10-03T10:00:00Z") },
      // open answers only: no score before Maria's review (percentOf(0, 0) would say 100)
      { clientId: kati.id, courseId: draftEcourse.id, number: 1, questions: [openOnly], answers: { qavatud1: "Nii." }, correct: 0, total: 0, status: "review", submittedAt: new Date("2026-10-02T10:00:00Z") },
    ]);
    const [practical] = await db
      .insert(protocols)
      .values({ accessId: open.id, stages: [{ title: "Ettevalmistus", note: "" }, { title: "Värvimine", note: "" }], verdicts: [null, null], round: 1, submittedAt: NOW })
      .returning();
    const contactReg = await register(kati.id, kati.email);
    const [dayProtocol] = await db.insert(protocols).values({ registrationId: contactReg.id, stages: [] }).returning();
    const plainReg = await register(kati.id, kati.email, { name: "Kati Kask" });
    const purchase = await register(kati.id, kati.email, { courseId: ecourse.id, courseSessionId: null, kind: "individual" });

    const d = (await clientDetail(db, kati.id, NOW))!;
    const byAccess = new Map(d.access.map((a) => [a.id, a]));
    expect(byAccess.get(open.id)).toMatchObject({
      protocolId: practical.id,
      testPercent: 100, // her newest attempt, the second
      hasAttempts: true,
      steps: { lessons: { done: 0, total: 0 }, test: { state: "done" }, practical: { state: "review", round: 1 }, completedAt: null },
    });
    expect(byAccess.get(done.id)).toMatchObject({ protocolId: null, testPercent: null, hasAttempts: true, steps: { test: null, practical: null, completedAt: "2026-10-01T10:00:00.000Z" } });
    const byReg = new Map(d.registrations.map((r) => [r.id, [r.contact, r.protocolId]]));
    expect(byReg.get(contactReg.id)).toEqual([true, dayProtocol.id]);
    expect(byReg.get(plainReg.id)).toEqual([true, null]);
    expect(byReg.get(purchase.id)).toEqual([false, null]);
  });
});

describe("Lisa õpilane", () => {
  test("creates the student of a new address (normalised, no session), with the language of her latest registration, and links her records", async () => {
    await register(null, "Mari.Maasikas@Example.test", { locale: "et", createdAt: new Date("2026-09-01T10:00:00Z") });
    const latest = await register(null, "mari.maasikas@example.test", { locale: "ru", createdAt: new Date("2026-09-20T10:00:00Z") });
    await db.insert(requests).values({ kind: "individual", payload: { email: "MARI.maasikas@example.test" } });
    await db.insert(subscribers).values({ email: "mari.maasikas@example.test", token: "t1" });

    const r = await addClient(db, "  Mari.Maasikas@EXAMPLE.test ");
    expect(r).toMatchObject({ ok: true, created: true });
    const id = (r as { id: number }).id;
    const [row] = await db.select().from(clients).where(eq(clients.id, id));
    expect(row).toMatchObject({ email: "mari.maasikas@example.test", name: "Liis Tamm", locale: "ru" }); // the newest registration's name
    expect((await db.select({ c: registrations.clientId }).from(registrations)).map((x) => x.c)).toEqual([id, id]);
    expect((await db.select({ c: requests.clientId }).from(requests))[0].c).toBe(id);
    expect((await db.select({ c: subscribers.clientId }).from(subscribers))[0].c).toBe(id);
    expect(await db.select().from(clientSessions)).toHaveLength(0);
    expect((await clientDetail(db, id, NOW))!.registrations.map((x) => x.id)).toContain(latest.id);
  });

  test("her language is the one she last used: of her newest registration or request (an e-course buyer has only the cart's request)", async () => {
    // only the e-learning cart's purchase request, in Russian
    await db.insert(requests).values({ kind: "contact", payload: { course: "e-kulm", intent: "purchase", email: "Olga@Example.test", locale: "ru" } });
    const olga = (await addClient(db, "olga@example.test")) as { id: number };
    expect((await db.select().from(clients).where(eq(clients.id, olga.id)))[0].locale).toBe("ru");
    // an older Russian request, a newer Estonian registration: Estonian
    await db.insert(requests).values({ kind: "contact", payload: { course: "e-kulm", intent: "purchase", email: "anu@example.test", locale: "ru" }, createdAt: new Date("2026-09-01T10:00:00Z") });
    await register(null, "anu@example.test", { locale: "et", createdAt: new Date("2026-09-10T10:00:00Z") });
    const anu = (await addClient(db, "anu@example.test")) as { id: number };
    expect((await db.select().from(clients).where(eq(clients.id, anu.id)))[0].locale).toBe("et");
    // an older Estonian registration, a newer Russian request: Russian
    await register(null, "irina@example.test", { locale: "et", createdAt: new Date("2026-09-01T10:00:00Z") });
    await db.insert(requests).values({ kind: "individual", payload: { course: "kulm", email: "irina@example.test", locale: "ru" }, createdAt: new Date("2026-09-10T10:00:00Z") });
    const irina = (await addClient(db, "irina@example.test")) as { id: number };
    expect((await db.select().from(clients).where(eq(clients.id, irina.id)))[0].locale).toBe("ru");
    // a request without a language (or an odd one) is not asked
    await db.insert(requests).values([
      { kind: "contact", payload: { email: "mari@example.test", locale: "xx" }, createdAt: new Date("2026-09-20T10:00:00Z") },
      { kind: "contact", payload: { email: "mari@example.test" }, createdAt: new Date("2026-09-21T10:00:00Z") },
    ]);
    await register(null, "mari@example.test", { locale: "ru", createdAt: new Date("2026-09-01T10:00:00Z") });
    const mari = (await addClient(db, "mari@example.test")) as { id: number };
    expect((await db.select().from(clients).where(eq(clients.id, mari.id)))[0].locale).toBe("ru");
  });

  test("a new student gets the name and phone of her newest registration or request that has each (spec 2.1 rule 4); an existing one keeps hers", async () => {
    await register(null, "kati@example.test", { name: "Kati Kask", phone: "+372 5555 0001", createdAt: new Date("2026-09-01T10:00:00Z") });
    await db.insert(requests).values({ kind: "individual", payload: { course: "kulm", email: "KATI@example.test", name: "Katrin Kask", phone: "" }, createdAt: new Date("2026-09-10T10:00:00Z") });
    const kati = (await addClient(db, "kati@example.test")) as { id: number };
    expect((await db.select().from(clients).where(eq(clients.id, kati.id)))[0]).toMatchObject({ name: "Katrin Kask", phone: "+372 5555 0001" });
    expect((await clientDetail(db, kati.id, NOW))!.client).toMatchObject({ name: "Katrin Kask", ownName: "Katrin Kask", phone: "+372 5555 0001" });

    const existing = await client("olemas@example.test", { name: "Olemas", phone: "" });
    await register(null, "olemas@example.test", { name: "Teine Nimi", phone: "+372 5555 0002" });
    expect(await addClient(db, "olemas@example.test")).toEqual({ ok: true, id: existing.id, created: false });
    expect((await db.select().from(clients).where(eq(clients.id, existing.id)))[0]).toMatchObject({ name: "Olemas", phone: "" });
  });

  test("an address without registrations: Estonian; an existing student: the same one, nothing created", async () => {
    const r = await addClient(db, "uus@example.test");
    expect(r).toMatchObject({ ok: true, created: true });
    expect((await db.select().from(clients))[0].locale).toBe("et");
    const existing = await client("olemas@example.test", { name: "Olemas", locale: "ru" });
    expect(await addClient(db, "OLEMAS@example.test")).toEqual({ ok: true, id: existing.id, created: false });
    expect(await addClientForm(db, form({ email: "olemas@example.test" }))).toEqual({ ok: true, id: existing.id });
    expect(await db.select().from(clients)).toHaveLength(2);
    expect((await db.select().from(clients).where(eq(clients.id, existing.id)))[0]).toMatchObject({ name: "Olemas", locale: "ru" });
  });

  test("a bad address is refused, nothing is stored", async () => {
    for (const bad of ["", "   ", "mari", "mari@", "mari@example", "@example.test", "ma ri@example.test", `${"x".repeat(250)}@example.test`])
      expect(await addClientForm(db, form({ email: bad })), bad).toEqual({ ok: false, error: "email" });
    expect(await addClientForm(db, new FormData())).toEqual({ ok: false, error: "email" });
    expect(await db.select().from(clients)).toHaveLength(0);
  });

  test("her first login finds the student the admin added (not new), with the access already there", async () => {
    const r = (await addClient(db, "kati@example.test")) as { id: number };
    expect(await grantAccess(db, { clientId: r.id, courseId: ecourse.id, until: "2027-04-04", by: ADMIN, now: NOW })).toEqual({ ok: true });
    const { code } = (await issueClientLogin(db, "kati@example.test", NOW))!;
    const login = await redeemClientCode(db, "kati@example.test", code, NOW);
    expect(login).toMatchObject({ clientId: r.id, isNew: false });
    const dash = (await loadDashboard(db, r.id, NOW))!;
    expect(dash.cards).toEqual([expect.objectContaining({ kind: "ecourse", course: { slug: "e-kulm", title: { et: "Kulmumeistri e-koolitus" } }, revoked: false })]);
  });
});

describe("e-course access", () => {
  test("Ava ligipääs: until the end of the chosen Estonian day, granted by the admin now; the student's card shows it", async () => {
    const kati = await client("kati@example.test");
    expect(await grantAccessForm(db, form({ clientId: String(kati.id), courseId: String(ecourse.id), until: "2027-04-04" }), ADMIN, NOW)).toEqual({ ok: true });
    const [row] = await db.select().from(courseAccess);
    expect(row).toMatchObject({ clientId: kati.id, courseId: ecourse.id, grantedBy: ADMIN, grantedAt: NOW, revokedAt: null });
    expect(row.expiresAt.toISOString()).toBe("2027-04-04T20:59:59.999Z"); // 23:59:59.999 in Tallinn (summer time, UTC+3)
    const summer = await client("suvi@example.test");
    await grantAccess(db, { clientId: summer.id, courseId: ecourse.id, until: "2027-07-01", by: ADMIN, now: NOW });
    expect((await db.select().from(courseAccess).where(eq(courseAccess.clientId, summer.id)))[0].expiresAt.toISOString()).toBe("2027-07-01T20:59:59.999Z"); // UTC+3
    const dash = (await loadDashboard(db, kati.id, NOW))!;
    expect(dash.cards).toEqual([{ kind: "ecourse", course: { slug: "e-kulm", title: { et: "Kulmumeistri e-koolitus" } }, grantedAt: NOW.toISOString(), expiresAt: "2027-04-04T20:59:59.999Z", revoked: false, progress: null, completedAt: null, certificateId: null }]);
    // a draft e-course can be granted (bought before it is published)
    expect(await grantAccess(db, { clientId: kati.id, courseId: draftEcourse.id, until: "2026-10-04", by: ADMIN, now: NOW })).toEqual({ ok: true });
  });

  test("granting again (run out, or ended) is the same row: new expiry, end cleared, the new admin and time recorded", async () => {
    const kati = await client("kati@example.test");
    const old = await access(kati.id, { grantedBy: "dim@example.test", grantedAt: new Date("2026-01-01T10:00:00Z"), expiresAt: new Date("2026-07-01T00:00:00Z") });
    const later = new Date("2026-10-05T08:00:00Z");
    expect(await grantAccess(db, { clientId: kati.id, courseId: ecourse.id, until: "2027-01-31", by: ADMIN, now: later })).toEqual({ ok: true });
    let rows = await db.select().from(courseAccess);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: old.id, grantedBy: ADMIN, grantedAt: later, revokedAt: null });
    expect(rows[0].expiresAt.toISOString()).toBe("2027-01-31T21:59:59.999Z");

    expect(await revokeAccess(db, { clientId: kati.id, accessId: old.id, now: later })).toEqual({ ok: true });
    expect((await db.select().from(courseAccess))[0].revokedAt).toEqual(later);
    expect(await grantAccess(db, { clientId: kati.id, courseId: ecourse.id, until: "2027-02-28", by: "dim@example.test", now: later })).toEqual({ ok: true });
    rows = await db.select().from(courseAccess);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: old.id, grantedBy: "dim@example.test", revokedAt: null });
    expect((await loadDashboard(db, kati.id, later))!.cards[0]).toMatchObject({ kind: "ecourse", revoked: false, expiresAt: "2027-02-28T21:59:59.999Z" });
  });

  test("refused: a day before today (Estonian), not a date, more than 10 years ahead, not an e-course, no such student, bad ids", async () => {
    const kati = await client("kati@example.test");
    const grant = (until: string, courseId = ecourse.id, clientId = kati.id) => grantAccess(db, { clientId, courseId, until, by: ADMIN, now: NOW });
    expect(await grant("2026-10-03")).toEqual({ ok: false, error: "date" });
    expect(await grant("2026-10-04")).toEqual({ ok: true }); // today is fine: open until tonight
    expect(await grant("2027-02-30")).toEqual({ ok: false, error: "date" });
    expect(await grant("04.04.2027")).toEqual({ ok: false, error: "date" });
    expect(await grant("")).toEqual({ ok: false, error: "date" });
    expect(await grant("2036-10-05")).toEqual({ ok: false, error: "date" });
    expect(await grant("2027-04-04", contact.id)).toEqual({ ok: false, error: "course" });
    expect(await grant("2027-04-04", 999_999)).toEqual({ ok: false, error: "course" });
    expect(await grant("2027-04-04", ecourse.id, 999_999)).toEqual({ ok: false, error: "notFound" });
    const f = (fields: Record<string, string>) => grantAccessForm(db, form(fields), ADMIN, NOW);
    expect(await f({ clientId: "x", courseId: String(ecourse.id), until: "2027-04-04" })).toEqual({ ok: false, error: "invalid" });
    expect(await f({ clientId: String(kati.id), courseId: "", until: "2027-04-04" })).toEqual({ ok: false, error: "course" });
    // just after midnight in Tallinn (still the day before in UTC), "today" is already the Estonian date
    expect(await grantAccess(db, { clientId: kati.id, courseId: ecourse.id, until: "2026-10-05", by: ADMIN, now: new Date("2026-10-04T21:30:00Z") })).toEqual({ ok: true });
    expect(await grantAccess(db, { clientId: kati.id, courseId: ecourse.id, until: "2026-10-04", by: ADMIN, now: new Date("2026-10-04T21:30:00Z") })).toEqual({ ok: false, error: "date" });
  });

  test("Lõpeta ligipääs: ends it now (kept as ended, the card says so); only that student's row; again changes nothing", async () => {
    const kati = await client("kati@example.test");
    const other = await client("other@example.test");
    const row = await access(kati.id);
    const theirs = await access(other.id);
    expect(await revokeAccessForm(db, form({ clientId: String(other.id), accessId: String(row.id) }), NOW)).toEqual({ ok: false, error: "notFound" });
    expect((await db.select().from(courseAccess).where(eq(courseAccess.id, row.id)))[0].revokedAt).toBeNull();
    expect(await revokeAccessForm(db, form({ clientId: String(kati.id), accessId: String(row.id) }), NOW)).toEqual({ ok: true });
    expect((await db.select().from(courseAccess).where(eq(courseAccess.id, row.id)))[0].revokedAt).toEqual(NOW);
    expect(await revokeAccess(db, { clientId: kati.id, accessId: row.id, now: new Date("2026-10-06T00:00:00Z") })).toEqual({ ok: true });
    expect((await db.select().from(courseAccess).where(eq(courseAccess.id, row.id)))[0].revokedAt).toEqual(NOW);
    expect((await db.select().from(courseAccess).where(eq(courseAccess.id, theirs.id)))[0].revokedAt).toBeNull();
    expect((await loadDashboard(db, kati.id, NOW))!.cards[0]).toMatchObject({ kind: "ecourse", revoked: true });
    expect(await revokeAccessForm(db, form({ clientId: String(kati.id), accessId: "abc" }), NOW)).toEqual({ ok: false, error: "invalid" });
  });

  test("the ids of Ava ligipääs and Lõpeta ligipääs are read like every id from text (parseRowId): digits only; \"1e3\", \" 7\", \"007\", \"0x10\" and the like are refused", async () => {
    const kati = await client("kati@example.test");
    const row = await access(kati.id);
    // spellings of the very ids that exist, which z.coerce.number() would read as those ids
    const spelled = (n: number) => [` ${n}`, `${n} `, `0${n}`, `${n}e0`, `0x${n.toString(16)}`, `+${n}`, `${n}.0`, `${n}.`];
    for (const bad of spelled(kati.id)) {
      expect(await grantAccessForm(db, form({ clientId: bad, courseId: String(ecourse.id), until: "2027-04-04" }), ADMIN, NOW), bad).toEqual({ ok: false, error: "invalid" });
      expect(await revokeAccessForm(db, form({ clientId: bad, accessId: String(row.id) }), NOW), bad).toEqual({ ok: false, error: "invalid" });
    }
    for (const bad of spelled(ecourse.id)) expect(await grantAccessForm(db, form({ clientId: String(kati.id), courseId: bad, until: "2027-04-04" }), ADMIN, NOW), bad).toEqual({ ok: false, error: "course" });
    for (const bad of spelled(row.id)) expect(await revokeAccessForm(db, form({ clientId: String(kati.id), accessId: bad }), NOW), bad).toEqual({ ok: false, error: "invalid" });
    expect((await db.select().from(courseAccess).where(eq(courseAccess.id, row.id)))[0].revokedAt).toBeNull(); // nothing was ended
    // the plain digits still work
    expect(await revokeAccessForm(db, form({ clientId: String(kati.id), accessId: String(row.id) }), NOW)).toEqual({ ok: true });
  });
});

describe("the change requests' registrations (Päringud, Muutmine)", () => {
  test("listRegistrations by ids: those (with course and session), none for an empty list; named as the student's card names them", async () => {
    const a = await register(null, "a@example.test");
    const b = await register(null, "b@example.test", { courseSessionId: null, kind: "individual", preferredPeriod: "Jaanuaris" });
    await register(null, "c@example.test");
    const rows = await listRegistrations(db, { ids: [b.id, a.id, 999_999] });
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(await listRegistrations(db, { ids: [] })).toEqual([]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(registrationHeading(byId.get(a.id)!)).toEqual({ title: "Kulmude lamineerimine", time: "14.11.2026 · 10:00", place: "Pärnu, MS LAB stuudio" });
    expect(registrationHeading(byId.get(b.id)!)).toEqual({ title: "Kulmude lamineerimine", time: "Jaanuaris", place: "" });
  });
});

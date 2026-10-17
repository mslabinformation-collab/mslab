import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import * as schema from "@/db/schema";
import { clients, contracts, courseAccess, courses, courseSessions, pages, payments, registrations, type Contract, type Registration } from "@/db/schema";
import { CONTRACT_CONTACT_KEY, CONTRACT_CONTACT_VERSION_KEY, type ContractFields } from "@/domain/contract";
import { TERMS_PAGE_KEY, TERMS_VERSION_KEY } from "@/domain/course-terms";
import { INVOICE_KEY } from "@/domain/invoice";
import {
  accessContractFields, contractForAccess, contractForAdmin, contractForRegistration, contractForStudent, contractPdf, contractsOfClient, contractsOfRegistration,
  contractTemplate, markContractSent, registrationContractFields, requestContract, saveContractTexts,
} from "@/server/contracts";
import { readPdf } from "../pdf-read";
import { makeTestDb } from "./helpers";
import { contactCourse, registrationOn } from "./payments-fixtures";

// The contracts' server (contracts, Task 3; spec D2–D7, §3–§6) against a real (PGlite) database: the frozen contract of a registration and of an
// e-course access (the filled text, the parties, the course in the contract's language, the session, the price), asking again and superseding
// under the row's lock, the reads of the student and of Maria, the contract texts of Seaded (the contact text, its version bumped only by a
// change; the public terms as the text until Maria writes hers) and the PDF. The order of the locks, and of the version before the text, is read
// off drizzle's query log, as the invoices' tests do. Logs carry ids only: this module logs nothing, and every test asserts it.

const NOW = new Date("2026-10-17T09:00:00Z");
const LATER = new Date("2026-10-18T09:00:00Z");
const LATEST = new Date("2026-10-19T09:00:00Z");
const NBSP = "\u00a0";
const SCHOOL = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu" };

/** Maria's contact text: every placeholder, an unknown one, and two paragraphs; the Russian text with its own title. */
const CONTACT = {
  title: { et: "Kontaktkoolituse leping", ru: "Договор очного обучения" },
  body: {
    et: "Õpilane {nimi} ({e-post}) registreerub koolitusele {koolitus}.\n\nToimumine: {toimumine}. Hind {hind}, ettemaks {ettemaks}. {tundmatu}",
    ru: "Ученик {nimi} ({e-post}) записывается на курс {koolitus}.\n\nДата и место: {toimumine}. Цена {hind}, предоплата {ettemaks}.",
  },
};
/** The same text in Estonian alone. */
const CONTACT_ET = { title: { et: CONTACT.title.et }, body: { et: CONTACT.body.et } };
type Texts = { title: { et: string; ru?: string }; body: { et: string; ru?: string } };
/** The e-course text (course_terms), as the seed stores it. */
const ECOURSE = { title: { et: "E-koolituse tingimused", ru: "Условия онлайн-обучения" }, body: { et: "Tere {nimi}, hind {hind}.", ru: "Здравствуйте, {nimi}, цена {hind}." } };

const CONSOLE = ["log", "info", "warn", "error", "debug"] as const;
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of CONSOLE) vi.spyOn(console, method);
});
afterEach(() => {
  // the module logs nothing: not an id, not a name, not an amount (the spies pass anything through, so that it would show)
  for (const method of CONSOLE) expect(console[method], `console.${method}`).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

type LogEntry = { query: string; params: unknown[] };
/** A fresh migrated database that records every query it runs (drizzle's logger); it replaces `db`, which the helpers below write through. */
async function useLoggedDb(): Promise<LogEntry[]> {
  const log: LogEntry[] = [];
  const logged: Db = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string, params: unknown[]) => void log.push({ query, params }) } });
  await migrate(logged, { migrationsFolder: "./drizzle" });
  db = logged;
  return log;
}
/** Where in a query log the first statement matching `re` runs (-1: none); `key`: the statement names this key (a setting's or a page's) among its parameters. */
const at = (log: LogEntry[], re: RegExp, key?: string): number => log.findIndex((e) => re.test(e.query) && (key === undefined || e.params.includes(key)));
const count = (log: LogEntry[], re: RegExp, key?: string): number => log.filter((e) => re.test(e.query) && (key === undefined || e.params.includes(key))).length;
const SETTING = /^select .* from "settings"/;
const PAGE = /^select .* from "pages"/;

const writePage = async (key: string, title: { et: string; ru?: string }, body: { et: string; ru?: string }) => {
  await db.insert(pages).values({ key, title, body }).onConflictDoUpdate({ target: pages.key, set: { title, body } });
};
const saveContact = async (text: Texts = CONTACT, now: Date = NOW) => {
  expect(await saveContractTexts(db, text, now)).toEqual({ ok: true });
};
const seller = () => setSetting(db, INVOICE_KEY, SCHOOL);
const client = async (email = "kati@example.com", name = "Kati Tamm") => (await db.insert(clients).values({ email, name }).returning())[0];
const allContracts = () => db.select().from(contracts).orderBy(contracts.id);
/** The statement fails, and the database names `constraint` in its error (drizzle puts it in `cause`), so that another failure cannot pass for it. */
async function violates(statement: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(statement).then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error, `a failure on ${constraint}`).not.toBeNull();
  expect(error!.cause?.message ?? error!.message).toContain(`"${constraint}"`);
}
/** The same contract as an insert would make it again: without its id and its creation time, which the database gives. */
const again = (c: Contract): typeof contracts.$inferInsert => ({ ...c, id: undefined, createdAt: undefined });
const registrationRow = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0];

/** What the student's tick on the form does: the fields and the template of the registration, then the contract, in one transaction. */
async function accept(r: Registration, over: { via?: "form" | "account"; now?: Date } = {}): Promise<Contract> {
  return db.transaction(async (tx) => {
    const f = (await registrationContractFields(tx, r.id))!;
    return contractForRegistration(tx, { registrationId: r.id, clientId: r.clientId, courseId: r.courseId, template: f.template, fields: f.fields, prepaymentText: f.prepaymentText, via: over.via ?? "form", now: over.now ?? NOW });
  });
}

/** An e-course (190 €), a client with access to it, and (on request) the paid payment she bought it with. */
async function ecourse(opts: { paid?: boolean } = {}) {
  const [course] = await db
    .insert(courses)
    .values({ slug: "kulmumeistri-e-koolitus", type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
    .returning();
  const c = await client();
  const [access] = await db.insert(courseAccess).values({ clientId: c.id, courseId: course.id, grantedBy: opts.paid ? "payment" : "maria@example.test", expiresAt: new Date("2027-04-17T00:00:00Z") }).returning();
  const [payment] = opts.paid
    ? await db.insert(payments).values({ reference: "MSLAB-L1", kind: "ecourse", courseId: course.id, clientId: c.id, email: c.email, name: c.name, amountCents: 17500, status: "paid", paidAt: NOW }).returning()
    : [null];
  return { course, client: c, access, payment };
}
type Tpl = { version: string; locale: "et" | "ru"; title: string; body: string };
const TEMPLATE_V1: Tpl = { version: "2026-10-01T00:00:00.000Z", locale: "et", title: "E-koolituse tingimused", body: "Tere {nimi}, hind {hind}." };
const TEMPLATE_V2: Tpl = { ...TEMPLATE_V1, version: "2026-10-10T00:00:00.000Z", body: "Uus tekst, {nimi}." };

/** A contract of the access, as the terms gate or the purchase makes it (the fields in the language of the text it brings). */
async function acceptAccess(a: { access: { id: number; courseId: number; clientId: number } }, over: { template?: Tpl; via?: "purchase" | "terms"; paymentId?: number | null; now?: Date } = {}) {
  return db.transaction(async (tx) => {
    const fields = (await accessContractFields(tx, a.access.id, over.paymentId, (over.template ?? TEMPLATE_V1).locale))!;
    return contractForAccess(tx, {
      accessId: a.access.id, clientId: a.access.clientId, courseId: a.access.courseId, paymentId: over.paymentId, snapshotOrTemplate: over.template ?? TEMPLATE_V1, fields, via: over.via ?? "terms", now: over.now ?? NOW,
    });
  });
}

describe("a registration's contract (D1, D3)", () => {
  test("it freezes the filled text, the parties, the course, the session, the price and the way; a later edit of the course, the price, the session, the registration, Seaded or the text changes none of it", async () => {
    await seller();
    await saveContact();
    const c = await contactCourse(db);
    const k = await client();
    const r = await registrationOn(db, c, { clientId: k.id });
    const made = await accept(r);

    const fields: ContractFields = {
      school: SCHOOL,
      student: { name: "Kati Tamm", email: "kati@example.com" },
      course: "Kulmumeistri baaskoolitus",
      session: "14.11.2026, Pärnu, MS LAB stuudio",
      price: `350,00${NBSP}€`,
      payment: "50% registreerimisel + 50% koolituspäeval",
    };
    expect(made).toMatchObject({
      kind: "contact", registrationId: r.id, accessId: null, paymentId: null, courseId: c.course.id, clientId: k.id,
      version: await readSetting(db, CONTRACT_CONTACT_VERSION_KEY), locale: "et", title: "Kontaktkoolituse leping", fields,
      acceptedAt: NOW, acceptedVia: "form", sentAt: null, supersededAt: null,
    });
    expect(made.body).toBe(
      `Õpilane Kati Tamm (kati@example.com) registreerub koolitusele Kulmumeistri baaskoolitus.\n\nToimumine: 14.11.2026, Pärnu, MS LAB stuudio. Hind 350,00${NBSP}€, ettemaks 175,00${NBSP}€. {tundmatu}`,
    );
    expect(await allContracts()).toEqual([made]);

    // Maria edits everything it was made from
    await db.update(courses).set({ title: { et: "Uus pealkiri" }, priceGroup: 99900 }).where(eq(courses.id, c.course.id));
    await db.update(courseSessions).set({ startsAt: new Date("2027-01-02T08:00:00Z"), city: "Tallinn" }).where(eq(courseSessions.id, c.session.id));
    await db.update(registrations).set({ name: "Kati Kask", email: "kask@example.com", paymentChoice: "full" }).where(eq(registrations.id, r.id));
    await setSetting(db, INVOICE_KEY, { company: "Teine OÜ", registryCode: "1", address: "Mujal 2" });
    await saveContact({ title: { et: "Uus leping" }, body: { et: "Hoopis teine tekst." } }, LATER);
    expect(await allContracts()).toEqual([made]);
  });

  test("no session and no price leave their fields and placeholders empty; the school without Arve andmed is „MS LAB“", async () => {
    await saveContact();
    const [course] = await db
      .insert(courses)
      .values({ slug: "hinnata", type: "contact", level: "basic", title: { et: "Hinnata koolitus" }, summary: { et: "" }, body: { et: "" }, published: true })
      .returning();
    const [r] = await db.insert(registrations).values({ courseId: course.id, kind: "group", name: "Mari Mänd", email: "mari@example.com", paymentChoice: "full" }).returning();
    const f = (await registrationContractFields(db, r.id))!;
    expect(f).toEqual({
      fields: { school: { company: "MS LAB", registryCode: "", address: "" }, student: { name: "Mari Mänd", email: "mari@example.com" }, course: "Hinnata koolitus", session: "", price: "", payment: "100% kohe" },
      prepaymentText: "",
      locale: "et",
      template: { version: NOW.toISOString(), locale: "et", title: CONTACT.title.et, body: CONTACT.body.et },
    });
    expect((await accept(r)).body).toContain("Toimumine: . Hind , ettemaks . {tundmatu}");
  });

  test("the payment choice in words, and „Ettemaks“: half the price rounded up for the half, the whole price for the full", async () => {
    const c = await contactCourse(db);
    await db.update(courses).set({ priceGroup: 12345 }).where(eq(courses.id, c.course.id));
    const half = await registrationOn(db, c, { paymentChoice: "half" });
    const full = await registrationOn(db, c, { paymentChoice: "full", email: "full@example.com" });
    expect(await registrationContractFields(db, half.id)).toMatchObject({ fields: { price: `123,45${NBSP}€`, payment: "50% registreerimisel + 50% koolituspäeval" }, prepaymentText: `61,73${NBSP}€` });
    expect(await registrationContractFields(db, full.id)).toMatchObject({ fields: { price: `123,45${NBSP}€`, payment: "100% kohe" }, prepaymentText: `123,45${NBSP}€` });
  });

  test("an individual registration takes the individual price; a registration without a session has no session text", async () => {
    const c = await contactCourse(db);
    await db.update(courses).set({ priceIndividual: 50000 }).where(eq(courses.id, c.course.id));
    const r = await registrationOn(db, c, { kind: "individual", courseSessionId: null });
    expect(await registrationContractFields(db, r.id)).toMatchObject({ fields: { session: "", price: `500,00${NBSP}€` }, prepaymentText: `250,00${NBSP}€` });
  });

  test("the school is Seaded → Arve andmed as Maria typed it", async () => {
    await seller();
    const r = await registrationOn(db, await contactCourse(db));
    expect((await registrationContractFields(db, r.id))!.fields.school).toEqual(SCHOOL);
  });

  test("an unknown registration has no fields", async () => {
    expect(await registrationContractFields(db, 999)).toBeNull();
  });

  test("D6, M-1: a Russian registration gets the Russian contract, the payment words and the course's name in Russian when the Russian text exists; an Estonian-only text gives an Estonian contract all through", async () => {
    await saveContact(CONTACT);
    const r = await registrationOn(db, await contactCourse(db), { locale: "ru" });
    const ru = (await registrationContractFields(db, r.id))!;
    expect(ru).toMatchObject({
      locale: "ru", fields: { payment: "50% при регистрации + 50% в день обучения", course: "Базовый курс бровиста" }, template: { locale: "ru", title: "Договор очного обучения", body: CONTACT.body.ru },
    });
    const made = await accept(r);
    expect(made).toMatchObject({ locale: "ru", title: "Договор очного обучения", fields: { course: "Базовый курс бровиста" } });
    expect(made.body).toContain("Ученик Kati Tamm (kati@example.com) записывается на курс Базовый курс бровиста.");

    await saveContact(CONTACT_ET, LATER);
    const et = (await registrationContractFields(db, r.id))!;
    expect(et).toMatchObject({ locale: "et", fields: { payment: "50% registreerimisel + 50% koolituspäeval", course: "Kulmumeistri baaskoolitus" } });
    const estonian = await accept(r, { via: "account", now: LATER });
    expect(estonian).toMatchObject({ locale: "et", title: "Kontaktkoolituse leping", fields: { course: "Kulmumeistri baaskoolitus" } });
    expect(estonian.body).toContain("registreerub koolitusele Kulmumeistri baaskoolitus.");
  });

  test("M-1: an Estonian registration, and a Russian contract of a course with no Russian title, name the course in Estonian", async () => {
    await saveContact(CONTACT);
    const c = await contactCourse(db);
    const et = await registrationOn(db, c, { locale: "et" });
    expect((await registrationContractFields(db, et.id))!.fields.course).toBe("Kulmumeistri baaskoolitus");
    await db.update(courses).set({ title: { et: "Kulmumeistri baaskoolitus" } }).where(eq(courses.id, c.course.id));
    const ru = await registrationOn(db, c, { locale: "ru", email: "ru@example.com" });
    expect(await registrationContractFields(db, ru.id)).toMatchObject({ locale: "ru", fields: { course: "Kulmumeistri baaskoolitus" } });
    await db.update(courses).set({ title: { et: "Kulmumeistri baaskoolitus", ru: "  " } }).where(eq(courses.id, c.course.id));
    expect((await registrationContractFields(db, ru.id))!.fields.course).toBe("Kulmumeistri baaskoolitus");
  });
});

describe("asking again and superseding (D4)", () => {
  test("„Saada leping kinnitamiseks“: not found, no account, cancelled — nothing stored; a linked, live registration gets the time of the ask, and a second ask the later time", async () => {
    const c = await contactCourse(db);
    const k = await client();
    expect(await requestContract(db, 999, NOW)).toEqual({ ok: false, error: "notFound" });
    const loose = await registrationOn(db, c);
    expect(await requestContract(db, loose.id, NOW)).toEqual({ ok: false, error: "noAccount" });
    const cancelled = await registrationOn(db, c, { clientId: k.id, status: "cancelled", email: "c@example.com" });
    expect(await requestContract(db, cancelled.id, NOW)).toEqual({ ok: false, error: "cancelled" });
    expect((await registrationRow(loose.id)).contractRequestedAt).toBeNull();
    expect((await registrationRow(cancelled.id)).contractRequestedAt).toBeNull();

    const linked = await registrationOn(db, c, { clientId: k.id, email: "l@example.com" });
    expect(await requestContract(db, linked.id, NOW)).toEqual({ ok: true });
    expect((await registrationRow(linked.id)).contractRequestedAt).toEqual(NOW);
    expect(await requestContract(db, linked.id, LATER)).toEqual({ ok: true });
    expect((await registrationRow(linked.id)).contractRequestedAt).toEqual(LATER);
  });

  test("asking, then accepting again: the old contract is superseded at the new acceptance and untouched otherwise, the new one is current, the flag is cleared; current first, then the superseded", async () => {
    await seller();
    await saveContact();
    const c = await contactCourse(db);
    const k = await client();
    const r = await registrationOn(db, c, { clientId: k.id });
    const first = await accept(r);
    expect(await requestContract(db, r.id, LATER)).toEqual({ ok: true });
    await db.update(courseSessions).set({ city: "Tallinn" }).where(eq(courseSessions.id, c.session.id)); // the session moved
    const second = await accept(r, { via: "account", now: LATEST });

    expect(second).toMatchObject({ acceptedVia: "account", acceptedAt: LATEST, supersededAt: null });
    expect(second.fields.session).toBe("14.11.2026, Tallinn, MS LAB stuudio");
    expect((await registrationRow(r.id)).contractRequestedAt).toBeNull();
    const [old, current] = [await db.select().from(contracts).where(eq(contracts.id, first.id)), await db.select().from(contracts).where(eq(contracts.id, second.id))];
    expect(old[0]).toEqual({ ...first, supersededAt: LATEST });
    expect(current[0]).toEqual(second);
    expect((await contractsOfRegistration(db, r.id)).map((x) => x.id)).toEqual([second.id, first.id]);
    // the current one stays first whatever the superseded one's time says; the superseded ones are newest first
    await db.update(contracts).set({ acceptedAt: new Date("2026-12-31T00:00:00Z") }).where(eq(contracts.id, first.id));
    expect((await contractsOfRegistration(db, r.id)).map((x) => x.id)).toEqual([second.id, first.id]);
  });

  // PGlite runs one transaction at a time, so these run one after the other here and the race itself cannot fail: the locks are proven by the query
  // log ("the registration's row is locked …" below), the final state by the partial unique index (the next test).
  test("Review Focus 4: „Kinnitan“ twice, and Maria asking, started together, leave one current contract; the others are superseded", async () => {
    await saveContact();
    const r = await registrationOn(db, await contactCourse(db), { clientId: (await client()).id });
    await accept(r);
    await requestContract(db, r.id, LATER);
    await Promise.all([accept(r, { via: "account", now: LATEST }), accept(r, { via: "account", now: LATEST }), requestContract(db, r.id, LATEST)]);
    const all = await contractsOfRegistration(db, r.id);
    expect(all).toHaveLength(3);
    expect(all.filter((x) => x.supersededAt === null)).toHaveLength(1);
    expect(all[0].supersededAt).toBeNull();
    expect(all.slice(1).every((x) => x.supersededAt !== null)).toBe(true);
  });

  test("the partial unique index is the backstop: a second current contract of the registration is refused, a superseded one lets a new one in", async () => {
    await saveContact();
    const r = await registrationOn(db, await contactCourse(db));
    const first = await accept(r);
    const copy = again(first);
    await violates(db.insert(contracts).values(copy), "contracts_current_registration");
    await db.update(contracts).set({ supersededAt: LATER }).where(eq(contracts.id, first.id));
    await expect(db.insert(contracts).values(copy)).resolves.toBeDefined();
  });

  test("the registration's row is locked FOR UPDATE before the old contract is superseded, the new one inserted and the flag cleared", async () => {
    const log = await useLoggedDb();
    await saveContact();
    const r = await registrationOn(db, await contactCourse(db), { clientId: (await client()).id });
    await accept(r);
    log.length = 0;
    await accept(r, { via: "account", now: LATER });
    const lock = at(log, /^select 1 from registrations where id = [\s\S]*for update/);
    const supersede = at(log, /^update "contracts"/);
    const insert = at(log, /^insert into "contracts"/);
    const clear = at(log, /^update "registrations"/);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(supersede);
    expect(supersede).toBeLessThan(insert);
    expect(insert).toBeLessThan(clear);
  });

  test("asking takes the registration's lock before it writes", async () => {
    const log = await useLoggedDb();
    const r = await registrationOn(db, await contactCourse(db), { clientId: (await client()).id });
    log.length = 0;
    await requestContract(db, r.id, NOW);
    const lock = at(log, /from "registrations"[\s\S]*for update/);
    const write = at(log, /^update "registrations"/);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(write);
  });

  test("M-5: only a group registration can be asked (D4); an individual one is not found, and nothing is stored", async () => {
    const c = await contactCourse(db);
    const k = await client();
    const individual = await registrationOn(db, c, { clientId: k.id, kind: "individual", courseSessionId: null });
    expect(await requestContract(db, individual.id, NOW)).toEqual({ ok: false, error: "notFound" });
    expect((await registrationRow(individual.id)).contractRequestedAt).toBeNull();
  });
});

describe("an e-course access's contract (D1)", () => {
  test("the terms gate: the text is filled, the student and the course are the account's; the same version again makes none", async () => {
    await seller();
    const e = await ecourse();
    const made = await acceptAccess(e);
    expect(made).toMatchObject({
      kind: "ecourse", accessId: e.access.id, registrationId: null, paymentId: null, courseId: e.course.id, clientId: e.client.id, version: TEMPLATE_V1.version, locale: "et",
      title: "E-koolituse tingimused", body: "Tere Kati Tamm, hind .", acceptedAt: NOW, acceptedVia: "terms", sentAt: null, supersededAt: null,
      fields: { school: SCHOOL, student: { name: "Kati Tamm", email: "kati@example.com" }, course: "Kulmumeistri e-koolitus", session: "", price: "", payment: "" },
    });
    expect(await acceptAccess(e, { now: LATER })).toBeNull();
    expect(await allContracts()).toEqual([made]);
  });

  test("a new version supersedes the old contract at the new acceptance and leaves it otherwise as it was", async () => {
    const e = await ecourse();
    const v1 = await acceptAccess(e);
    const v2 = (await acceptAccess(e, { template: TEMPLATE_V2, now: LATER }))!;
    expect(v2).toMatchObject({ version: TEMPLATE_V2.version, body: "Uus tekst, Kati Tamm.", supersededAt: null, acceptedAt: LATER });
    expect(await allContracts()).toEqual([{ ...v1!, supersededAt: LATER }, v2]);
    expect(await acceptAccess(e, { template: TEMPLATE_V2, now: LATEST })).toBeNull();
  });

  test("a purchase names its payment and carries its paid amount as the price, beside the text the cart showed", async () => {
    const e = await ecourse({ paid: true });
    const fields = (await accessContractFields(db, e.access.id, e.payment!.id))!;
    expect(fields).toMatchObject({ price: `175,00${NBSP}€`, session: "", payment: "", course: "Kulmumeistri e-koolitus", student: { name: "Kati Tamm", email: "kati@example.com" } });
    const shown = { ...TEMPLATE_V1, body: `Tere Kati Tamm, hind 175,00${NBSP}€.` };
    const made = (await acceptAccess(e, { via: "purchase", paymentId: e.payment!.id, template: shown }))!;
    expect(made).toMatchObject({ paymentId: e.payment!.id, acceptedVia: "purchase", fields: { price: `175,00${NBSP}€` }, body: shown.body });
  });

  test("without a payment, and with one that is gone, the price is empty", async () => {
    const e = await ecourse({ paid: true });
    expect((await accessContractFields(db, e.access.id))!.price).toBe("");
    expect((await accessContractFields(db, e.access.id, null))!.price).toBe("");
    expect((await accessContractFields(db, e.access.id, 999))!.price).toBe("");
  });

  test("a purchase stores the snapshot the cart showed exactly as it is (it is filled already: a name that reads {hind} is not filled a second time); the gate's text is filled here", async () => {
    const e = await ecourse({ paid: true });
    const shown = { version: "2026-10-05T00:00:00.000Z", locale: "ru" as const, title: "Условия {nimi}", body: "Ученик {hind}, цена 175,00 €." };
    const made = (await acceptAccess(e, { via: "purchase", paymentId: e.payment!.id, template: shown }))!;
    expect(made).toMatchObject({ version: shown.version, locale: "ru", title: "Условия {nimi}", body: "Ученик {hind}, цена 175,00 €.", acceptedVia: "purchase" });
    const gate = (await acceptAccess(e, { template: { ...TEMPLATE_V2, body: "{nimi} {e-post} {koolitus} {hind}" } }))!;
    expect(gate.body).toBe("Kati Tamm kati@example.com Kulmumeistri e-koolitus ");
  });

  test("R4: a purchase always freezes its own contract with the paid price: after a free grant's gate contract of the same version it supersedes that one", async () => {
    const e = await ecourse({ paid: true });
    const gate = (await acceptAccess(e))!;
    expect(gate).toMatchObject({ acceptedVia: "terms", paymentId: null, fields: { price: "" } });
    const shown = { ...TEMPLATE_V1, body: `Tere Kati Tamm, hind 175,00${NBSP}€.` };
    const bought = (await acceptAccess(e, { via: "purchase", paymentId: e.payment!.id, template: shown, now: LATER }))!;
    expect(bought).toMatchObject({ acceptedVia: "purchase", paymentId: e.payment!.id, version: TEMPLATE_V1.version, body: shown.body, fields: { price: `175,00${NBSP}€` }, acceptedAt: LATER, supersededAt: null });
    expect(await allContracts()).toEqual([{ ...gate, supersededAt: LATER }, bought]);
    // and the gate asks nothing more of her: the purchase is the current contract of that version
    expect(await acceptAccess(e, { now: LATEST })).toBeNull();
  });

  test("R4: a renewal on the same access row, the text unchanged, freezes the second payment's contract and supersedes the first purchase's", async () => {
    const e = await ecourse({ paid: true });
    const [second] = await db
      .insert(payments)
      .values({ reference: "MSLAB-L2", kind: "ecourse", courseId: e.course.id, clientId: e.client.id, email: e.client.email, name: e.client.name, amountCents: 9000, status: "paid", paidAt: LATER })
      .returning();
    const shown = (price: string) => ({ ...TEMPLATE_V1, body: `Hind ${price}.` });
    const first = (await acceptAccess(e, { via: "purchase", paymentId: e.payment!.id, template: shown("175"), now: NOW }))!;
    const renewal = (await acceptAccess(e, { via: "purchase", paymentId: second.id, template: shown("90"), now: LATER }))!;
    expect(renewal).toMatchObject({ paymentId: second.id, fields: { price: `90,00${NBSP}€` }, body: "Hind 90.", supersededAt: null });
    expect(await allContracts()).toEqual([{ ...first, supersededAt: LATER }, renewal]);
  });

  test("M-1: the course's name follows the contract's language: Russian for a Russian contract when the course has a Russian title, else Estonian", async () => {
    const e = await ecourse();
    expect((await accessContractFields(db, e.access.id))!.course).toBe("Kulmumeistri e-koolitus");
    expect((await accessContractFields(db, e.access.id, null, "et"))!.course).toBe("Kulmumeistri e-koolitus");
    expect((await accessContractFields(db, e.access.id, null, "ru"))!.course).toBe("Онлайн-курс бровиста");
    const ru = await acceptAccess(e, { template: { ...TEMPLATE_V1, locale: "ru", body: "{koolitus}" } });
    expect(ru).toMatchObject({ locale: "ru", body: "Онлайн-курс бровиста", fields: { course: "Онлайн-курс бровиста" } });
    await db.update(courses).set({ title: { et: "Kulmumeistri e-koolitus" } }).where(eq(courses.id, e.course.id));
    expect((await accessContractFields(db, e.access.id, null, "ru"))!.course).toBe("Kulmumeistri e-koolitus");
  });

  test("an unknown access has no fields", async () => {
    expect(await accessContractFields(db, 999)).toBeNull();
  });

  test("the access row is locked FOR UPDATE (completion.ts lockAccess) before the old contract is superseded and the new one inserted", async () => {
    const log = await useLoggedDb();
    const e = await ecourse();
    await acceptAccess(e);
    log.length = 0;
    await acceptAccess(e, { template: TEMPLATE_V2, now: LATER });
    const lock = at(log, /from "course_access"[\s\S]*for update/);
    const supersede = at(log, /^update "contracts"/);
    const insert = at(log, /^insert into "contracts"/);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(supersede);
    expect(supersede).toBeLessThan(insert);
  });

  test("M-3: the ids the caller passes must belong together: another client's or another course's access, and an access that is gone, write nothing and throw", async () => {
    const e = await ecourse();
    const other = await client("mari@example.com", "Mari Mänd");
    const [course2] = await db
      .insert(courses)
      .values({ slug: "teine", type: "e_learning", level: "basic", title: { et: "Teine" }, summary: { et: "" }, body: { et: "" }, published: true, price: 9000 })
      .returning();
    const fields = (await accessContractFields(db, e.access.id))!;
    const input = { accessId: e.access.id, clientId: e.client.id, courseId: e.course.id, snapshotOrTemplate: TEMPLATE_V1, fields, via: "terms" as const, now: NOW };
    const refused = (over: Partial<typeof input>) => db.transaction((tx) => contractForAccess(tx, { ...input, ...over }));
    await expect(refused({ clientId: other.id })).rejects.toThrow(`access ${e.access.id} does not belong to client ${other.id} and course ${e.course.id}`);
    await expect(refused({ courseId: course2.id })).rejects.toThrow(`access ${e.access.id} does not belong to client ${e.client.id} and course ${course2.id}`);
    await expect(refused({ accessId: 999 })).rejects.toThrow("access 999 does not belong");
    expect(await allContracts()).toEqual([]);
    await expect(refused({})).resolves.toMatchObject({ accessId: e.access.id });
  });

  test("two accesses are two contracts; the partial unique index is the backstop for one access", async () => {
    const e = await ecourse();
    const made = (await acceptAccess(e))!;
    const copy = again(made);
    await violates(db.insert(contracts).values(copy), "contracts_current_access");
  });
});

describe("the templates (D2)", () => {
  test("the contact text is Maria's page with its version; the Estonian text is shown to Estonian students, the Russian to Russian ones when it exists", async () => {
    await saveContact();
    const version = (await readSetting(db, CONTRACT_CONTACT_VERSION_KEY)) as string;
    expect(version).toBe(NOW.toISOString());
    expect(await contractTemplate(db, "contact", "et")).toEqual({ version, locale: "et", title: CONTACT.title.et, body: CONTACT.body.et });
    expect(await contractTemplate(db, "contact", "ru")).toEqual({ version, locale: "ru", title: CONTACT.title.ru, body: CONTACT.body.ru });
  });

  test("without a Russian text a Russian student is given the Estonian one, in Estonian; a Russian body without a Russian title keeps the Estonian title", async () => {
    await saveContact(CONTACT_ET);
    expect(await contractTemplate(db, "contact", "ru")).toMatchObject({ locale: "et", title: CONTACT.title.et, body: CONTACT.body.et });
    await saveContact({ title: { et: "Leping" }, body: CONTACT.body }, LATER);
    expect(await contractTemplate(db, "contact", "ru")).toMatchObject({ locale: "ru", title: "Leping", body: CONTACT.body.ru });
  });

  test("without Maria's text the public „terms“ page is the contract text; its version is of its text, so an edit of it is a new version and the same text is the same", async () => {
    await writePage("terms", { et: "Õppetingimused", ru: "Условия обучения" }, { et: "Tingimuste tekst.", ru: "Текст условий." });
    const et = await contractTemplate(db, "contact", "et");
    expect(et).toMatchObject({ locale: "et", title: "Õppetingimused", body: "Tingimuste tekst." });
    expect(et.version).toMatch(/^terms:[0-9a-f]{16}$/);
    expect(await contractTemplate(db, "contact", "ru")).toEqual({ version: et.version, locale: "ru", title: "Условия обучения", body: "Текст условий." });
    expect((await contractTemplate(db, "contact", "et")).version).toBe(et.version);
    await writePage("terms", { et: "Õppetingimused", ru: "Условия обучения" }, { et: "Muudetud tekst.", ru: "Текст условий." });
    const edited = await contractTemplate(db, "contact", "et");
    expect(edited.body).toBe("Muudetud tekst.");
    expect(edited.version).not.toBe(et.version);
  });

  test("a contact page with no Estonian text is not a text: the public terms are used", async () => {
    await writePage("terms", { et: "Õppetingimused" }, { et: "Tingimuste tekst." });
    await writePage(CONTRACT_CONTACT_KEY, { et: "Leping" }, { et: "  " });
    expect(await contractTemplate(db, "contact", "et")).toMatchObject({ title: "Õppetingimused", body: "Tingimuste tekst." });
  });

  test("with neither text there is an empty contract and registering is not blocked: the fields still come", async () => {
    const t = await contractTemplate(db, "contact", "et");
    expect(t).toMatchObject({ locale: "et", title: "", body: "" });
    const r = await registrationOn(db, await contactCourse(db));
    const made = await accept(r);
    expect(made).toMatchObject({ title: "", body: "", fields: { course: "Kulmumeistri baaskoolitus" } });
  });

  test("the e-course text is course_terms with the version the terms gate holds, „1“ until the first save", async () => {
    await writePage(TERMS_PAGE_KEY, ECOURSE.title, ECOURSE.body);
    expect(await contractTemplate(db, "ecourse", "et")).toEqual({ version: "1", locale: "et", title: "E-koolituse tingimused", body: "Tere {nimi}, hind {hind}." });
    await setSetting(db, TERMS_VERSION_KEY, "2026-10-12T08:00:00.000Z");
    expect(await contractTemplate(db, "ecourse", "ru")).toEqual({ version: "2026-10-12T08:00:00.000Z", locale: "ru", title: "Условия онлайн-обучения", body: "Здравствуйте, {nimi}, цена {hind}." });
  });

  // client-data.ts: „The version is read BEFORE the text: an admin save that lands in between then pairs the old version with the new text (the next
  // visit shows the notice again), never a new version with text the student did not see.“ The same rule for both texts, read off the query log.
  test("I-1: the contact version is read before the text, each once, in the registration's read too — a save in between can give the old version the new text, never the new version the old text", async () => {
    const log = await useLoggedDb();
    await saveContact();
    const r = await registrationOn(db, await contactCourse(db));
    log.length = 0;

    const f = (await registrationContractFields(db, r.id))!;
    expect(f.template).toEqual({ version: NOW.toISOString(), locale: "et", title: CONTACT.title.et, body: CONTACT.body.et });
    expect(count(log, SETTING, CONTRACT_CONTACT_VERSION_KEY)).toBe(1);
    expect(count(log, PAGE)).toBe(1); // one read of the text for the fields and the template: the caller reads none
    expect(at(log, PAGE, CONTRACT_CONTACT_KEY)).toBeGreaterThan(at(log, SETTING, CONTRACT_CONTACT_VERSION_KEY));
    expect(at(log, SETTING, CONTRACT_CONTACT_VERSION_KEY)).toBeGreaterThanOrEqual(0);

    log.length = 0;
    await contractTemplate(db, "contact", "ru");
    expect(at(log, PAGE, CONTRACT_CONTACT_KEY)).toBeGreaterThan(at(log, SETTING, CONTRACT_CONTACT_VERSION_KEY));
    expect(at(log, SETTING, CONTRACT_CONTACT_VERSION_KEY)).toBeGreaterThanOrEqual(0);
  });

  test("I-1: the public terms as the contract: the contact version, then Maria's page (absent), then the terms page whose version is of its own text; the e-course version before course_terms", async () => {
    const log = await useLoggedDb();
    await writePage("terms", { et: "Õppetingimused" }, { et: "Tingimuste tekst." });
    await writePage(TERMS_PAGE_KEY, ECOURSE.title, ECOURSE.body);
    log.length = 0;
    await contractTemplate(db, "contact", "et");
    const version = at(log, SETTING, CONTRACT_CONTACT_VERSION_KEY);
    const own = at(log, PAGE, CONTRACT_CONTACT_KEY);
    const terms = at(log, PAGE, "terms");
    expect(version).toBeGreaterThanOrEqual(0);
    expect(version).toBeLessThan(own);
    expect(own).toBeLessThan(terms);
    expect(count(log, PAGE, "terms")).toBe(1);

    log.length = 0;
    await contractTemplate(db, "ecourse", "et");
    expect(at(log, SETTING, TERMS_VERSION_KEY)).toBeGreaterThanOrEqual(0);
    expect(at(log, SETTING, TERMS_VERSION_KEY)).toBeLessThan(at(log, PAGE, TERMS_PAGE_KEY));
  });

  test("the e-course text of a stored page that is not a text is an empty one; the contact text never uses course_terms", async () => {
    await db.insert(pages).values({ key: TERMS_PAGE_KEY, title: { et: "x" }, body: { et: 5 } as never });
    expect(await contractTemplate(db, "ecourse", "et")).toMatchObject({ title: "", body: "" });
    expect(await contractTemplate(db, "contact", "et")).toMatchObject({ title: "", body: "" });
  });
});

describe("saveContractTexts (Seaded → Lepingud)", () => {
  const read = async () => (await db.select().from(pages).where(eq(pages.key, CONTRACT_CONTACT_KEY)))[0];

  test("the first save stores the page, trimmed and without a blank Russian text, and sets the version to the time of the save", async () => {
    expect(await saveContractTexts(db, { title: { et: "  Leping ", ru: "  " }, body: { et: "\n Tekst.\n", ru: "" } }, NOW)).toEqual({ ok: true });
    expect(await read()).toEqual({ key: CONTRACT_CONTACT_KEY, title: { et: "Leping" }, body: { et: "Tekst." } });
    expect(await readSetting(db, CONTRACT_CONTACT_VERSION_KEY)).toBe(NOW.toISOString());
  });

  test("the version moves only on a change: the same text again keeps it; a change of the body, of the title or of the Russian text moves it, never to the version already stored", async () => {
    await saveContact();
    const v = (): Promise<unknown> => readSetting(db, CONTRACT_CONTACT_VERSION_KEY);
    expect(await v()).toBe(NOW.toISOString());
    await saveContact(CONTACT, LATER);
    expect(await v()).toBe(NOW.toISOString());
    await saveContact({ ...CONTACT, body: { ...CONTACT.body, et: `${CONTACT.body.et} Lisa.` } }, LATER);
    expect(await v()).toBe(LATER.toISOString());
    await saveContact({ ...CONTACT, body: { ...CONTACT.body, et: `${CONTACT.body.et} Lisa.` }, title: { ...CONTACT.title, et: "Uus pealkiri" } }, LATEST);
    expect(await v()).toBe(LATEST.toISOString());
    await saveContact({ title: { et: "Uus pealkiri" }, body: { et: `${CONTACT.body.et} Lisa.` } }, new Date(LATEST.getTime() + 1000));
    expect(await v()).toBe(new Date(LATEST.getTime() + 1000).toISOString());
    // a change in the very millisecond of the stored version still gives another one
    await saveContact({ title: { et: "Kolmas" }, body: { et: "Kolmas." } }, new Date(LATEST.getTime() + 1000));
    expect(await v()).toBe(new Date(LATEST.getTime() + 1001).toISOString());
  });

  test("a field that is empty or too long is refused by its name and nothing is stored; so is anything that is not a text", async () => {
    await saveContact();
    const before = await read();
    expect(await saveContractTexts(db, { title: { et: "" }, body: { et: "x" } }, LATER)).toEqual({ ok: false, fields: { title: "required" } });
    expect(await saveContractTexts(db, { title: { et: "x" }, body: { et: "  ", ru: "ru" } }, LATER)).toEqual({ ok: false, fields: { body: "required" } });
    expect(await saveContractTexts(db, { title: { et: "x".repeat(121) }, body: { et: "y".repeat(30_001) } }, LATER)).toEqual({ ok: false, fields: { title: "tooLong", body: "tooLong" } });
    for (const raw of [null, "text", 5, [], {}, { title: "x", body: "y" }, { title: { et: 1 }, body: { et: "y" } }]) {
      expect(await saveContractTexts(db, raw, LATER)).toEqual({ ok: false, fields: { form: "invalid" } });
    }
    expect(await read()).toEqual(before);
    expect(await readSetting(db, CONTRACT_CONTACT_VERSION_KEY)).toBe(NOW.toISOString());
  });

  test("M-6: the limits are Seaded's legal texts' (a title of 120, a text of 30 000 stand, one more is „tooLong“ by its field), and a raw string past 40 000, as Seaded's parts cap them, is refused before it is cleaned", async () => {
    expect(await saveContractTexts(db, { title: { et: "t".repeat(120) }, body: { et: "b".repeat(30_000) } }, NOW)).toEqual({ ok: true });
    expect((await read()).body.et).toHaveLength(30_000);
    expect(await saveContractTexts(db, { title: { et: "t".repeat(121) }, body: { et: "b".repeat(30_001), ru: "r".repeat(30_001) } }, LATER)).toEqual({ ok: false, fields: { title: "tooLong", body: "tooLong" } });
    expect(await saveContractTexts(db, { title: { et: "t", ru: "r".repeat(121) }, body: { et: "b" } }, LATER)).toEqual({ ok: false, fields: { title: "tooLong" } });
    const wide = "x".repeat(40_001);
    for (const raw of [{ title: { et: wide }, body: { et: "b" } }, { title: { et: "t" }, body: { et: wide } }, { title: { et: "t" }, body: { et: "b", ru: wide } }, { title: { et: "t", ru: wide }, body: { et: "b" } }]) {
      expect(await saveContractTexts(db, raw, LATER)).toEqual({ ok: false, fields: { form: "invalid" } });
    }
    expect((await read()).body.et).toHaveLength(30_000);
    expect(await readSetting(db, CONTRACT_CONTACT_VERSION_KEY)).toBe(NOW.toISOString());
  });

  test("a text pasted with control characters is stored without them", async () => {
    await saveContractTexts(db, { title: { et: "Le\u0000ping" }, body: { et: "Rida\u000bteine\u0001 rida" } }, NOW);
    expect(await read()).toMatchObject({ title: { et: "Leping" }, body: { et: "Rida\nteine rida" } });
  });
});

describe("the reads", () => {
  test("a student reads her own contracts, the superseded ones too, by id; another's is null, so is an unknown id", async () => {
    await saveContact();
    const c = await contactCourse(db);
    const mine = await client();
    const other = await client("mari@example.com", "Mari Mänd");
    const rMine = await registrationOn(db, c, { clientId: mine.id });
    const rOther = await registrationOn(db, c, { clientId: other.id, email: "mari@example.com", name: "Mari Mänd" });
    const first = await accept(rMine);
    const theirs = await accept(rOther);
    const second = await accept(rMine, { via: "account", now: LATER });

    expect(await contractForStudent(db, mine.id, second.id)).toEqual(second);
    expect(await contractForStudent(db, mine.id, first.id)).toEqual({ ...first, supersededAt: LATER });
    expect(await contractForStudent(db, mine.id, theirs.id)).toBeNull();
    expect(await contractForStudent(db, other.id, first.id)).toBeNull();
    expect(await contractForStudent(db, mine.id, 999)).toBeNull();
    expect((await contractsOfClient(db, mine.id)).map((x) => x.id)).toEqual([second.id, first.id]);
    expect((await contractsOfClient(db, other.id)).map((x) => x.id)).toEqual([theirs.id]);
    expect(await contractsOfClient(db, 999)).toEqual([]);
  });

  test("Maria reads any contract by id; null for an unknown one", async () => {
    await saveContact();
    const made = await accept(await registrationOn(db, await contactCourse(db)));
    expect(await contractForAdmin(db, made.id)).toEqual(made);
    expect(await contractForAdmin(db, 999)).toBeNull();
  });

  test("a contract outlives its registration: Maria no longer finds it through the registration, the student finds it through her account, and it still reads", async () => {
    await saveContact();
    const k = await client();
    const r = await registrationOn(db, await contactCourse(db), { clientId: k.id });
    const made = await accept(r);
    await db.delete(registrations).where(eq(registrations.id, r.id));
    expect(await contractsOfRegistration(db, r.id)).toEqual([]);
    expect(await contractsOfClient(db, k.id)).toEqual([{ ...made, registrationId: null }]);
    expect(await contractForAdmin(db, made.id)).toEqual({ ...made, registrationId: null });
  });

  test("the e-course's contracts are found through the client, not through a registration", async () => {
    const e = await ecourse();
    const made = (await acceptAccess(e))!;
    expect((await contractsOfClient(db, e.client.id)).map((x) => x.id)).toEqual([made.id]);
    expect(await contractsOfRegistration(db, 1)).toEqual([]);
  });

  test("markContractSent sets the time of the last mailed copy and changes nothing else; an unknown id changes nothing", async () => {
    await saveContact();
    const made = await accept(await registrationOn(db, await contactCourse(db)));
    await markContractSent(db, made.id, LATER);
    expect(await contractForAdmin(db, made.id)).toEqual({ ...made, sentAt: LATER });
    await markContractSent(db, made.id, LATEST);
    expect((await contractForAdmin(db, made.id))!.sentAt).toEqual(LATEST);
    await markContractSent(db, 999, LATEST);
    expect(await allContracts()).toHaveLength(1);
  });
});

describe("contractPdf", () => {
  test("a PDF drawn from the frozen row alone: Maria's later edit of the text does not reach it, and the same row gives the same bytes", async () => {
    await seller();
    await saveContact();
    const made = await accept(await registrationOn(db, await contactCourse(db)));
    const bytes = await contractPdf(made);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    await saveContact({ title: { et: "Hoopis uus" }, body: { et: "Hoopis uus tekst." } }, LATER);
    const again = await contractPdf((await contractForAdmin(db, made.id))!);
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
    const { runs } = await readPdf(bytes);
    const text = runs.map((r) => r.text).join("\n");
    expect(text).toContain("Kontaktkoolituse leping");
    expect(text).toContain("Kati Tamm");
    expect(text).toContain("MS LAB OÜ");
    expect(text).not.toContain("Hoopis uus");
  });

  test("a superseded contract says so", async () => {
    await saveContact();
    const r = await registrationOn(db, await contactCourse(db), { clientId: (await client()).id });
    const first = await accept(r);
    await accept(r, { via: "account", now: LATER });
    const { runs } = await readPdf(await contractPdf((await contractForAdmin(db, first.id))!));
    expect(runs.map((x) => x.text).join("\n")).toContain("Asendatud");
  });
});

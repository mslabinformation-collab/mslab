import { desc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { attachOrder, insertPayment } from "@/db/queries/payments";
import { readSetting } from "@/db/queries/public";
import { clients, clientSessions, contracts, courseAccess, courses, pages, payments, registrations, requests, termsAcceptances, type Contract, type Course, type Payment } from "@/db/schema";
import { CONTRACT_CONTACT_VERSION_KEY, contractCourseName, filledContract } from "@/domain/contract";
import { TERMS_PAGE_KEY, TERMS_VERSION_KEY } from "@/domain/course-terms";
import { INVOICE_KEY } from "@/domain/invoice";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { acceptTerms, loadEcourse, termsState } from "@/server/client-data";
import { renderContract } from "@/server/contract-pdf";
import { contractTemplate, mailContract, saveContractTexts } from "@/server/contracts";
import type { Env } from "@/server/notify";
import { settleToken } from "@/server/payments/settle";
import { handleEcoursePurchase, handleIndividual, handleRegistration, handleWaitlist, runSubmission, type Deps } from "@/server/submit";
import { newToken, sha256 } from "@/server/token";
import { fakeKv } from "../fakes";
import { readPdf } from "../pdf-read";
import { makeTestDb } from "./helpers";
import { contactCourse, orderToken, settleDeps, SITE, stubMontonio, TEST_MONTONIO } from "./payments-fixtures";

// The flows that accept a contract (contracts, Task 4; spec D1, D3, D6, D7, §4) against a real (PGlite) database: the registration form's box
// (the contract inserted in the registration's own transaction, and nothing stored when it cannot be: Review Focus 1), the e-course cart's box
// (the filled text kept on the payment when the purchase starts, frozen when it is paid even if Maria edits the text in between: Review Focus 2),
// the terms gate (a purchase's contract of the current version satisfies it; its own acceptance freezes one contract), and the mails that carry
// the PDF with „Leping on lisatud.“ (a PDF that fails to render: the mail goes without it, logged by the contract's id). The PDF renderer is the
// real one, wrapped (to make it fail once).

vi.mock("@/server/contract-pdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/contract-pdf")>();
  return { ...real, renderContract: vi.fn(real.renderContract) };
});

/** 17.10.2026 12:00 in Tallinn. */
const NOW = new Date("2026-10-17T09:00:00Z");
const MIN = 60_000;
const LATER = new Date(NOW.getTime() + 5 * MIN);
const LATEST = new Date(NOW.getTime() + 60 * MIN);
const NBSP = " ";
/** Seaded → Arve andmed: the seller (the school of every contract), VAT off, MSL from 1 in 2026. */
const SELLER = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" };
const SCHOOL = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu" };
/** Maria's contact text: every placeholder and an unknown one, two paragraphs; the Russian text with its own title. */
const CONTACT = {
  title: { et: "Kontaktkoolituse leping", ru: "Договор очного обучения" },
  body: {
    et: "Õpilane {nimi} ({e-post}) registreerub koolitusele {koolitus}.\n\nToimumine: {toimumine}. Hind {hind}, ettemaks {ettemaks}. {tundmatu}",
    ru: "Ученик {nimi} ({e-post}) записывается на курс {koolitus}.\n\nДата и место: {toimumine}. Цена {hind}, предоплата {ettemaks}.",
  },
};
/** When Maria saved it: the contact text's version. */
const CONTACT_SAVED = new Date("2026-10-10T09:00:00Z");
/** The e-course text (course_terms) and its versions. */
const ECOURSE = { title: { et: "E-koolituse tingimused", ru: "Условия онлайн-обучения" }, body: { et: "Tere {nimi}, hind {hind}.", ru: "Здравствуйте, {nimi}, цена {hind}." } };
const V1 = "2026-10-01T00:00:00.000Z";
const V2 = "2026-10-17T09:02:00.000Z";
const SLUG = "kulmumeistri-e-koolitus";

/** A Resend call's body as the fake keeps it (the SDK's own field names). */
type SentMail = { to: string; subject: string; text: string; html?: string; attachments?: { filename: string; content: string; content_type: string }[] };

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  vi.mocked(renderContract).mockClear();
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const logged = (method: "info" | "warn" | "error") => vi.mocked(console[method]).mock.calls.map((c) => c.map(String).join(" "));
const everyLog = () => [...logged("info"), ...logged("warn"), ...logged("error")].join("\n");
const allContracts = () => db.select().from(contracts).orderBy(contracts.id);
const sent = (m: ReturnType<typeof stubMontonio>) => m.mails() as SentMail[];
const hers = (m: ReturnType<typeof stubMontonio>, to = "kati@example.com") => sent(m).filter((x) => x.to === to);

/** Every insert into contracts fails from now (a trigger), as a broken contract step would; allowContracts ends it. */
async function refuseContracts() {
  await db.execute(sql.raw("create or replace function mslab_refuse_contract() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$"));
  await db.execute(sql.raw("create trigger mslab_refuse_contract before insert on contracts for each row execute function mslab_refuse_contract()"));
}
const allowContracts = () => db.execute(sql.raw("drop trigger mslab_refuse_contract on contracts"));

/** The text a PDF attachment draws (its runs, one a line). */
async function pdfText(attachment: { content: string }): Promise<string> {
  const bytes = Buffer.from(attachment.content, "base64");
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  return (await readPdf(new Uint8Array(bytes))).runs.map((r) => r.text).join("\n");
}

/** The forms' dependencies: `mail` sets Resend up; `flush()` runs the work after the answer, one task after the other. */
function formDeps(opts: { montonio?: Deps["montonio"]; mail?: boolean; now?: Date } = {}) {
  const tasks: (() => Promise<unknown>)[] = [];
  const env: Env = { KV: fakeKv({ "tg:chat": "42" }), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, ...(opts.mail ? { RESEND_API_KEY: "re_test" } : {}) };
  const deps: Deps = { db, env, ip: "203.0.113.9", siteUrl: SITE, now: opts.now ?? NOW, later: (task) => void tasks.push(task), changed: () => {}, montonio: opts.montonio ?? null };
  const flush = async () => {
    for (let task = tasks.shift(); task; task = tasks.shift()) await task();
  };
  return { deps, flush };
}
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

// ---------- the registration form ----------

/** Seaded's seller and Maria's contact text, and the contact course (350 €; 14.11.2026 10:00, Pärnu, MS LAB stuudio). */
async function contactReady(opts: { capacity?: number } = {}) {
  await setSetting(db, INVOICE_KEY, SELLER);
  expect(await saveContractTexts(db, CONTACT, CONTACT_SAVED)).toEqual({ ok: true });
  return contactCourse(db, opts);
}
/**
 * The group registration form as she fills it: the name and the address with stray spaces, 50 %, the box ticked, and the version of the contact
 * text its page showed (ruling R6): the one contactReady saved.
 */
const groupForm = (sessionId: number, over: Record<string, string> = {}) =>
  form({ course: "kulmumeistri-baaskoolitus", session: String(sessionId), name: "Kati  Kask", email: " Kati@Example.com ", phone: "+372 5555 0101", payment: "half", terms: "on", locale: "et", contractVersion: CONTACT_SAVED.toISOString(), ...over });
/** The same form from a page cached before the forms sent a version: no `contractVersion` at all. */
const withoutVersion = (fd: FormData) => {
  fd.delete("contractVersion");
  return fd;
};
const CHANGED = { ok: false, errors: { terms: "changed" } };
const euros = (s: string) => s.replace(/ €/g, `${NBSP}€`);

describe("the registration form's box is the contract (D1, §4)", () => {
  test("a submit makes the registration and its contract together: the text the form shows, filled as its preview fills it (Review Focus 3), frozen with the parties and the course", async () => {
    const c = await contactReady();
    const { deps } = formDeps();
    expect(await handleRegistration(deps, groupForm(c.session.id))).toEqual({ ok: true });
    const [r, ...noOther] = await db.select().from(registrations);
    expect(noOther).toEqual([]);
    const [k, ...none] = await allContracts();
    expect(none).toEqual([]);
    expect(k).toMatchObject({
      kind: "contact",
      registrationId: r.id,
      accessId: null,
      courseId: c.course.id,
      clientId: null,
      paymentId: null,
      version: await readSetting(db, CONTRACT_CONTACT_VERSION_KEY),
      locale: "et",
      title: "Kontaktkoolituse leping",
      body: euros("Õpilane Kati Kask (kati@example.com) registreerub koolitusele Kulmumeistri baaskoolitus.\n\nToimumine: 14.11.2026, Pärnu, MS LAB stuudio. Hind 350,00 €, ettemaks 175,00 €. {tundmatu}"),
      fields: {
        school: SCHOOL,
        student: { name: "Kati Kask", email: "kati@example.com" },
        course: "Kulmumeistri baaskoolitus",
        session: "14.11.2026, Pärnu, MS LAB stuudio",
        price: `350,00${NBSP}€`,
        payment: "50% registreerimisel + 50% koolituspäeval",
      },
      acceptedAt: NOW,
      acceptedVia: "form",
      sentAt: null,
      supersededAt: null,
    });
    expect(k.version).toBe(CONTACT_SAVED.toISOString());
    // the form's inline contract, filled in the browser from the very values she typed (before the server trims them), is the frozen text
    const template = await contractTemplate(db, "contact", "et");
    const preview = filledContract(template, {
      name: "Kati  Kask", email: " Kati@Example.com ", course: contractCourseName(c.course.title, template.locale),
      session: { startsAt: c.session.startsAt, city: c.session.city, venue: c.session.venue }, priceCents: c.course.priceGroup, choice: "half", locale: template.locale,
    });
    expect(preview).toEqual({ title: k.title, body: k.body });
  });

  test("an address with an account: the contract is hers; a Russian registration: the Russian text, the course's Russian title and the Russian payment words (D6)", async () => {
    const c = await contactReady();
    const [kati] = await db.insert(clients).values({ email: "kati@example.com", name: "Kati" }).returning();
    const { deps } = formDeps();
    expect(await handleRegistration(deps, groupForm(c.session.id, { locale: "ru", payment: "full" }))).toEqual({ ok: true });
    const [k] = await allContracts();
    expect(k).toMatchObject({
      clientId: kati.id,
      locale: "ru",
      title: "Договор очного обучения",
      body: euros("Ученик Kati Kask (kati@example.com) записывается на курс Базовый курс бровиста.\n\nДата и место: 14.11.2026, Pärnu, MS LAB stuudio. Цена 350,00 €, предоплата 350,00 €."),
      fields: { course: "Базовый курс бровиста", payment: "100% сразу" },
    });
  });

  test("Review Focus 1: a contract that cannot be stored fails the submit — the generic error, and neither the registration nor a contract, no payment, no mail", async () => {
    const m = stubMontonio();
    const c = await contactReady();
    await refuseContracts();
    const { deps, flush } = formDeps({ montonio: m.montonio, mail: true });
    expect(await runSubmission("register", () => deps, handleRegistration, groupForm(c.session.id))).toEqual({ ok: false, errors: { form: "server" } });
    await flush();
    expect(await db.select().from(registrations)).toEqual([]);
    expect(await allContracts()).toEqual([]);
    expect(await db.select().from(payments)).toEqual([]);
    expect(m.state.orders).toEqual([]);
    expect(m.mails()).toEqual([]);
    expect(logged("error")).toContain("[forms] register: not stored: DrizzleQueryError (code P0001)");
    expect(everyLog()).not.toMatch(/kati@example\.com|Kati Kask/i);
    // the seat it would have taken is free: the next submit, with the contract stored, books it
    await allowContracts();
    expect(await handleRegistration(deps, groupForm(c.session.id))).toMatchObject({ ok: true });
    expect(await db.select().from(registrations)).toHaveLength(1);
    expect(await allContracts()).toHaveLength(1);
  });

  test("a submit refused (the date is full) stores no contract; the waitlist and an individual request make none (D1: individual courses are out of scope)", async () => {
    const c = await contactReady({ capacity: 1 });
    await db.update(courses).set({ priceIndividual: 45000 }).where(eq(courses.id, c.course.id));
    // one confirmed registration fills the one seat
    await db.insert(registrations).values({ courseId: c.course.id, courseSessionId: c.session.id, kind: "group", name: "X", email: "x@example.com", paymentChoice: "full", status: "confirmed" });
    const { deps } = formDeps();
    expect(await handleRegistration(deps, groupForm(c.session.id))).toEqual({ ok: false, errors: { session: "full" } });
    expect(await allContracts()).toEqual([]);
    expect(await handleWaitlist(deps, form({ session: String(c.session.id), name: "Mari", email: "mari@example.com", locale: "et" }))).toEqual({ ok: true });
    expect(await handleIndividual(deps, form({ course: "kulmumeistri-baaskoolitus", name: "Mari", email: "mari@example.com", phone: "+372 5555 0102", period: "Detsember", terms: "on", locale: "et" }))).toEqual({ ok: true });
    expect(await db.select().from(requests)).toHaveLength(2);
    expect(await allContracts()).toEqual([]);
  });

  test("the confirmation mail attaches the contract's PDF, „MS-LAB-leping-{id}.pdf“, with „Leping on lisatud.“, and records when it was sent (D7)", async () => {
    const m = stubMontonio();
    const c = await contactReady();
    const { deps, flush } = formDeps({ mail: true });
    expect(await handleRegistration(deps, groupForm(c.session.id))).toEqual({ ok: true });
    const [k] = await allContracts();
    expect(k.sentAt).toBeNull(); // after the answer
    await flush();
    const [mail, ...more] = hers(m);
    expect(more).toEqual([]);
    expect(mail.subject).toBe("Registreering on vastu võetud — Kulmumeistri baaskoolitus");
    expect(mail.attachments!.map((a) => [a.filename, a.content_type])).toEqual([[`MS-LAB-leping-${k.id}.pdf`, "application/pdf"]]);
    const drawn = await pdfText(mail.attachments![0]);
    for (const part of ["Kontaktkoolituse leping", "Kati Kask", "kati@example.com", "Kulmumeistri baaskoolitus", "14.11.2026, Pärnu, MS LAB stuudio", "MS LAB OÜ"]) expect(drawn, part).toContain(part);
    expect(mail.text).toContain("Leping on lisatud.");
    expect(mail.html).toContain("Leping on lisatud.");
    expect((await allContracts())[0].sentAt).toEqual(NOW);
    // Maria's notice carries nothing
    expect(sent(m).find((x) => x.to === "maria@example.test")!.attachments).toBeUndefined();
  });

  test("a PDF that fails to render: the confirmation goes without it and without its line, nothing is recorded as sent, and the log has the contract's id only", async () => {
    const m = stubMontonio();
    const c = await contactReady();
    vi.mocked(renderContract).mockRejectedValueOnce(Object.assign(new Error("boom for kati@example.com"), { name: "Error" }));
    const { deps, flush } = formDeps({ mail: true });
    expect(await handleRegistration(deps, groupForm(c.session.id))).toEqual({ ok: true });
    await flush();
    const [k] = await allContracts();
    const [mail] = hers(m);
    expect(mail.subject).toBe("Registreering on vastu võetud — Kulmumeistri baaskoolitus");
    expect(mail.attachments).toBeUndefined();
    expect(mail.text).not.toContain("Leping on lisatud.");
    expect(k.sentAt).toBeNull();
    expect(logged("error")).toContain(`[contracts] contract ${k.id}: the mail went without its PDF: Error`);
    expect(everyLog()).not.toMatch(/boom|kati@example\.com/);
  });
});

// ---------- the e-course cart ----------

/** The e-course (190 €) with Maria's e-course text of version V1 and Seaded's seller. */
async function ecourseReady(): Promise<Course> {
  await setSetting(db, INVOICE_KEY, SELLER);
  await db.insert(pages).values({ key: TERMS_PAGE_KEY, ...ECOURSE });
  await setSetting(db, TERMS_VERSION_KEY, V1);
  const [course] = await db
    .insert(courses)
    .values({ slug: SLUG, type: "e_learning", level: "basic", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" }, summary: { et: "" }, body: { et: "" }, published: true, price: 19000, accessMonths: 6 })
    .returning();
  return course;
}
/** The cart's purchase as she fills it, with the version of the e-course text the cart showed (R6): V1, the one ecourseReady stores. */
const cartForm = (over: Record<string, string> = {}) => form({ course: SLUG, name: "Kati Kask", email: "kati@example.com", terms: "on", locale: "et", contractVersion: V1, ...over });
const newestPayment = async (): Promise<Payment> => (await db.select().from(payments).orderBy(desc(payments.id)).limit(1))[0];

/** „Maksa“ in the cart at `at` (NOW): the payment row it started. */
async function startPurchase(m: ReturnType<typeof stubMontonio>, over: Record<string, string> = {}, at = NOW): Promise<Payment> {
  expect(await handleEcoursePurchase(formDeps({ montonio: m.montonio, now: at }).deps, cartForm(over))).toMatchObject({ ok: true });
  return newestPayment();
}
/** Montonio's PAID for `p` at `at` (LATER), and the work after the answer done. */
async function pay(m: ReturnType<typeof stubMontonio>, p: Payment, at = LATER) {
  const s = settleDeps(db, m.montonio, at);
  const result = await settleToken(s.deps, m.montonio.verifyOrderToken(orderToken(p)));
  await s.flush();
  return result;
}
const katiClient = async () => (await db.select().from(clients).where(eq(clients.email, "kati@example.com")))[0];

describe("the cart's box is the e-course contract (D1, §4)", () => {
  test("the start keeps the contract the cart showed on the payment: filled with the name, the address, the course and the price, its version and language, and the press (R7); the cart's preview fills it the same", async () => {
    const m = stubMontonio();
    const course = await ecourseReady();
    const p = await startPurchase(m);
    expect(p.contractSnapshot).toEqual({ version: V1, locale: "et", title: "E-koolituse tingimused", body: `Tere Kati Kask, hind 190,00${NBSP}€.`, acceptedAt: NOW.toISOString() });
    const template = await contractTemplate(db, "ecourse", "et");
    expect({ ...template, ...filledContract(template, { name: "Kati Kask", email: "kati@example.com", course: contractCourseName(course.title, "et"), session: null, priceCents: 19000, choice: null, locale: "et" }), acceptedAt: NOW.toISOString() }).toEqual(p.contractSnapshot);
    // pressed again while the order is open (the same row is sent again): what this press showed replaces it, in Russian now, with its time
    await startPurchase(m, { locale: "ru", name: "Katja" }, new Date(NOW.getTime() + MIN));
    const [again, ...none] = await db.select().from(payments);
    expect(none).toEqual([]);
    expect(again.id).toBe(p.id);
    expect(again.contractSnapshot).toEqual({ version: V1, locale: "ru", title: "Условия онлайн-обучения", body: `Здравствуйте, Katja, цена 190,00${NBSP}€.`, acceptedAt: new Date(NOW.getTime() + MIN).toISOString() });
  });

  test("paid: the purchase's contract is frozen beside the grant — the snapshot as it is, the paid price, accepted at the order's start; the gate is satisfied for that version (she is not asked twice)", async () => {
    const m = stubMontonio();
    const course = await ecourseReady();
    const p = await startPurchase(m);
    expect(await pay(m, p)).toMatchObject({ kind: "done", payment: { status: "paid" } });
    const client = await katiClient();
    const [access] = await db.select().from(courseAccess);
    const [k, ...none] = await allContracts();
    expect(none).toEqual([]);
    expect(k).toMatchObject({
      kind: "ecourse",
      accessId: access.id,
      registrationId: null,
      courseId: course.id,
      clientId: client.id,
      paymentId: p.id,
      version: V1,
      locale: "et",
      title: "E-koolituse tingimused",
      body: `Tere Kati Kask, hind 190,00${NBSP}€.`,
      fields: { school: SCHOOL, student: { name: "Kati Kask", email: "kati@example.com" }, course: "Kulmumeistri e-koolitus", session: "", price: `190,00${NBSP}€`, payment: "" },
      acceptedAt: p.createdAt,
      acceptedVia: "purchase",
      supersededAt: null,
    });
    expect(k.acceptedAt).toEqual(NOW);
    expect(await termsState(db, client.id, course.id)).toEqual({ version: V1, accepted: true, text: null });
    expect((await loadEcourse(db, client.id, SLUG, LATER))!.terms).toEqual({ version: V1, accepted: true, text: null });
    expect(await db.select().from(termsAcceptances)).toEqual([]);
  });

  test("Review Focus 2: Maria edits the text between the start and the payment — the contract holds what the cart showed; the gate then asks for the new text, and that acceptance supersedes it", async () => {
    const m = stubMontonio();
    const course = await ecourseReady();
    const p = await startPurchase(m);
    await db.update(pages).set({ body: { et: "Uus tekst, {nimi}." } }).where(eq(pages.key, TERMS_PAGE_KEY));
    await setSetting(db, TERMS_VERSION_KEY, V2);
    await pay(m, p);
    const client = await katiClient();
    const [k] = await allContracts();
    expect([k.version, k.title, k.body, k.acceptedVia]).toEqual([V1, "E-koolituse tingimused", `Tere Kati Kask, hind 190,00${NBSP}€.`, "purchase"]);
    // the new text is another version: the gate asks for it, and its acceptance freezes the new text and supersedes the purchase's
    expect(await termsState(db, client.id, course.id)).toEqual({ version: V2, accepted: false, text: { et: "Uus tekst, {nimi}." } });
    expect(await acceptTerms(db, client.id, SLUG, V2, LATEST, { locale: "et" })).toBe("accepted");
    const [old, now] = await allContracts();
    expect(old).toMatchObject({ id: k.id, supersededAt: LATEST, body: k.body });
    expect(now).toMatchObject({ kind: "ecourse", version: V2, body: "Uus tekst, Kati Kask.", acceptedVia: "terms", paymentId: null, acceptedAt: LATEST, supersededAt: null, fields: { price: "" } });
    expect((await termsState(db, client.id, course.id)).accepted).toBe(true);
  });

  test("the paid mail carries both PDFs — the invoice and the contract — with „Arve on lisatud.“ and „Leping on lisatud.“, and the contract is recorded as sent", async () => {
    const m = stubMontonio();
    await ecourseReady();
    await pay(m, await startPurchase(m));
    const [k] = await allContracts();
    const [mail, ...more] = hers(m);
    expect(more).toEqual([]);
    expect(mail.subject).toBe("E-koolitus on avatud — Kulmumeistri e-koolitus");
    expect(mail.attachments!.map((a) => [a.filename, a.content_type])).toEqual([["MS-LAB-arve-MSL2026-001.pdf", "application/pdf"], [`MS-LAB-leping-${k.id}.pdf`, "application/pdf"]]);
    const drawn = await pdfText(mail.attachments![1]);
    for (const part of ["E-koolituse tingimused", "Kati Kask", "Kulmumeistri e-koolitus", `190,00${NBSP}€`]) expect(drawn, part).toContain(part);
    for (const line of ["Arve on lisatud.", "Leping on lisatud."]) {
      expect(mail.text, line).toContain(line);
      expect(mail.html, line).toContain(line);
    }
    expect((await allContracts())[0].sentAt).toEqual(LATER);
  });

  test("a contract step that fails: the payment is paid and the course open, the error is logged by the payment's id, no contract and no line; the gate asks her later and freezes one then", async () => {
    const m = stubMontonio();
    const course = await ecourseReady();
    const p = await startPurchase(m);
    await refuseContracts();
    expect(await pay(m, p)).toMatchObject({ kind: "done", payment: { status: "paid" } });
    const client = await katiClient();
    expect(await db.select().from(courseAccess)).toHaveLength(1);
    expect(await allContracts()).toEqual([]);
    expect(logged("error")).toContain(`[contracts] payment ${p.id}: no contract: DrizzleQueryError (code P0001)`);
    const [mail] = hers(m);
    expect(mail.attachments!.map((a) => a.filename)).toEqual(["MS-LAB-arve-MSL2026-001.pdf"]);
    expect(mail.text).not.toContain("Leping on lisatud.");
    expect(everyLog()).not.toMatch(/Kati Kask/);
    await allowContracts();
    expect(await termsState(db, client.id, course.id)).toMatchObject({ version: V1, accepted: false });
    expect(await acceptTerms(db, client.id, SLUG, V1, LATEST, { locale: "et" })).toBe("accepted");
    expect((await allContracts()).map((c) => [c.acceptedVia, c.paymentId, c.body])).toEqual([["terms", null, "Tere Kati Kask, hind ."]]);
  });

  test("a payment that showed no contract (started before this version): paid and opened, no contract; the gate asks", async () => {
    const m = stubMontonio();
    const course = await ecourseReady();
    const row = await insertPayment(db, { kind: "ecourse", registrationId: null, courseId: course.id, clientId: null, email: "kati@example.com", name: "Kati Kask", locale: "et", amountCents: 19000 }, NOW, TEST_MONTONIO.referencePrefix);
    await attachOrder(db, row.id, "uuid-old", NOW);
    expect(row.contractSnapshot).toBeNull();
    await pay(m, { ...row, providerUuid: "uuid-old" });
    expect(await db.select().from(courseAccess)).toHaveLength(1);
    expect(await allContracts()).toEqual([]);
    expect((await termsState(db, (await katiClient()).id, course.id)).accepted).toBe(false);
  });
});

// ---------- the terms gate ----------

/** Kati (an account) with a free grant of the e-course („Ava ligipääs“): no purchase, no contract. */
async function freeGrant() {
  const course = await ecourseReady();
  const [kati] = await db.insert(clients).values({ email: "kati@example.com", name: "Kati Tamm" }).returning();
  const [access] = await db.insert(courseAccess).values({ clientId: kati.id, courseId: course.id, grantedBy: "maria@example.test", grantedAt: NOW, expiresAt: new Date("2027-04-17T00:00:00Z") }).returning();
  return { course, kati, access };
}

describe("the terms gate freezes the contract (D1: a free grant, a newer text)", () => {
  test("an acceptance freezes one contract: the current text filled for her, by the gate, no price; accepting the same version again makes none", async () => {
    const { course, kati, access } = await freeGrant();
    expect(await termsState(db, kati.id, course.id)).toMatchObject({ version: V1, accepted: false });
    const made: Contract[] = [];
    expect(await acceptTerms(db, kati.id, SLUG, V1, NOW, { locale: "et", onContract: (c) => void made.push(c) })).toBe("accepted");
    const [k, ...none] = await allContracts();
    expect(none).toEqual([]);
    expect(k).toMatchObject({
      kind: "ecourse", accessId: access.id, clientId: kati.id, courseId: course.id, paymentId: null, version: V1, locale: "et",
      title: "E-koolituse tingimused", body: "Tere Kati Tamm, hind .", acceptedVia: "terms", acceptedAt: NOW,
      fields: { school: SCHOOL, student: { name: "Kati Tamm", email: "kati@example.com" }, course: "Kulmumeistri e-koolitus", session: "", price: "", payment: "" },
    });
    expect(made).toEqual([k]);
    expect(await db.select().from(termsAcceptances)).toEqual([{ clientId: kati.id, courseId: course.id, termsVersion: V1, acceptedAt: NOW }]);
    expect((await termsState(db, kati.id, course.id)).accepted).toBe(true);
    expect(await acceptTerms(db, kati.id, SLUG, V1, LATER, { locale: "et", onContract: (c) => void made.push(c) })).toBe("accepted");
    expect(await allContracts()).toEqual([k]);
    expect(made).toHaveLength(1);
  });

  test("the language she read: the page's Russian gives the Russian text and the course's Russian title; without the page's language, her account's", async () => {
    const { kati } = await freeGrant();
    expect(await acceptTerms(db, kati.id, SLUG, V1, NOW, { locale: "ru" })).toBe("accepted");
    expect(await allContracts()).toEqual([expect.objectContaining({ locale: "ru", title: "Условия онлайн-обучения", body: "Здравствуйте, Kati Tamm, цена .", fields: expect.objectContaining({ course: "Онлайн-курс бровиста" }) })]);
    // another client with a Russian account, accepting without a language: her account's
    const [mari] = await db.insert(clients).values({ email: "mari@example.com", name: "Mari", locale: "ru" }).returning();
    const [course] = await db.select().from(courses);
    await db.insert(courseAccess).values({ clientId: mari.id, courseId: course.id, grantedBy: "maria@example.test", expiresAt: new Date("2027-04-17T00:00:00Z") });
    expect(await acceptTerms(db, mari.id, SLUG, V1, NOW)).toBe("accepted");
    expect((await allContracts()).map((c) => [c.clientId, c.locale])).toEqual([[kati.id, "ru"], [mari.id, "ru"]]);
  });

  test("a stale version or no access: nothing is stored, no contract", async () => {
    const { kati } = await freeGrant();
    await setSetting(db, TERMS_VERSION_KEY, V2);
    expect(await acceptTerms(db, kati.id, SLUG, V1, NOW, { locale: "et" })).toBe("stale");
    expect(await acceptTerms(db, kati.id, "olematu", V2, NOW, { locale: "et" })).toBe("noAccess");
    expect(await allContracts()).toEqual([]);
    expect(await db.select().from(termsAcceptances)).toEqual([]);
  });

  /** POST /api/konto/tingimused as Kati, signed in; `dev`: a local development request (nothing is mailed). */
  async function postTerms(kati: { id: number }, body: Record<string, unknown>, opts: { dev?: boolean } = {}) {
    const raw = newToken();
    await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: kati.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
    const tasks: (() => Promise<unknown>)[] = [];
    const deps: AccountDeps = {
      db, env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test" },
      now: NOW, siteUrl: SITE, later: (task) => void tasks.push(task), dev: opts.dev ?? false,
    };
    const res = (await handleAccountApi(
      new Request(`${SITE}/api/konto/tingimused`, { method: "POST", headers: { cookie: `__Host-mslab_client=${raw}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify(body) }),
      deps,
    ))!;
    for (let task = tasks.shift(); task; task = tasks.shift()) await task();
    return res;
  }

  test("POST /tingimused mails her the contract: „MS LAB leping“ in the page's language with the PDF and its line, and records it as sent (D7)", async () => {
    const m = stubMontonio();
    const { kati } = await freeGrant();
    const res = await postTerms(kati, { slug: SLUG, version: V1, locale: "ru" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [k] = await allContracts();
    expect(k).toMatchObject({ locale: "ru", acceptedVia: "terms", sentAt: NOW });
    const [mail, ...more] = hers(m);
    expect(more).toEqual([]);
    expect(mail.subject).toBe("Договор MS LAB");
    expect(mail.attachments!.map((a) => [a.filename, a.content_type])).toEqual([[`MS-LAB-leping-${k.id}.pdf`, "application/pdf"]]);
    expect(await pdfText(mail.attachments![0])).toContain("Условия онлайн-обучения");
    expect(mail.text).toContain(`Договор во${NBSP}вложении.`);
    // accepted again (the same version): no second contract, no second mail
    expect((await postTerms(kati, { slug: SLUG, version: V1, locale: "ru" })).status).toBe(200);
    expect(await allContracts()).toHaveLength(1);
    expect(hers(m)).toHaveLength(1);
  });

  test("POST /tingimused from an older page (no language): her account's; in local development nothing is mailed and nothing recorded as sent", async () => {
    const m = stubMontonio();
    const { kati } = await freeGrant();
    expect((await postTerms(kati, { slug: SLUG, version: V1 }, { dev: true })).status).toBe(200);
    const [k] = await allContracts();
    expect([k.locale, k.sentAt]).toEqual(["et", null]);
    expect(m.mails()).toEqual([]);
  });
});

// ---------- fix round 1 (rulings R6, R7, R8; minors M-4, M-5, M-6) ----------

describe("R6: the forms freeze only the text their page showed", () => {
  test("the registration form: Maria saves another text between the page and the submit — refused, and nothing is made (no registration, contract, payment or order); a page without a version too; the new version books", async () => {
    const m = stubMontonio();
    const c = await contactReady(); // the page is loaded with this version (CONTACT_SAVED)
    expect(await saveContractTexts(db, { title: CONTACT.title, body: { et: "Uus tekst, {nimi}." } }, LATER)).toEqual({ ok: true }); // Maria saves meanwhile
    const { deps, flush } = formDeps({ montonio: m.montonio, mail: true });
    expect(await handleRegistration(deps, groupForm(c.session.id))).toEqual(CHANGED);
    expect(await handleRegistration(deps, withoutVersion(groupForm(c.session.id)))).toEqual(CHANGED); // a page cached before the forms sent one
    expect(await handleRegistration(deps, groupForm(c.session.id, { contractVersion: "x".repeat(201) }))).toEqual(CHANGED); // no version can be that
    await flush();
    expect(await db.select().from(registrations)).toEqual([]);
    expect(await allContracts()).toEqual([]);
    expect(await db.select().from(payments)).toEqual([]);
    expect(m.state.orders).toEqual([]);
    expect(m.mails()).toEqual([]);
    expect(logged("info")).toContain("[forms] register: the contract's text changed since the page was loaded: nothing stored");
    // the page loaded again shows the new text and sends its version: booked, with that text frozen
    expect(await handleRegistration(deps, groupForm(c.session.id, { contractVersion: LATER.toISOString() }))).toMatchObject({ ok: true });
    const [k] = await allContracts();
    expect([k.version, k.body]).toEqual([LATER.toISOString(), "Uus tekst, Kati Kask."]);
  });

  test("the registration form: the same version still books (and the contract is the text of that version)", async () => {
    const c = await contactReady();
    expect(await handleRegistration(formDeps().deps, groupForm(c.session.id))).toEqual({ ok: true });
    expect((await allContracts()).map((k) => k.version)).toEqual([CONTACT_SAVED.toISOString()]);
  });

  test("the cart: Maria saves another e-course text between the cart and „Maksa“ — refused before anything is filled or started (no payment, no order); a cart without a version too; the new version starts", async () => {
    const m = stubMontonio();
    await ecourseReady(); // the cart is loaded with V1
    await db.update(pages).set({ body: { et: "Uus tekst, {nimi}." } }).where(eq(pages.key, TERMS_PAGE_KEY));
    await setSetting(db, TERMS_VERSION_KEY, V2); // Maria saves meanwhile
    const deps = formDeps({ montonio: m.montonio }).deps;
    expect(await handleEcoursePurchase(deps, cartForm())).toEqual(CHANGED);
    expect(await handleEcoursePurchase(deps, withoutVersion(cartForm()))).toEqual(CHANGED);
    expect(await db.select().from(payments)).toEqual([]);
    expect(m.state.orders).toEqual([]);
    expect(logged("info")).toContain("[forms] ecourse: the contract's text changed since the cart was loaded: nothing started");
    // the cart loaded again: the new version starts, and its text is what the payment keeps
    expect(await handleEcoursePurchase(deps, cartForm({ contractVersion: V2 }))).toMatchObject({ ok: true });
    const [p] = await db.select().from(payments);
    expect(p.contractSnapshot).toMatchObject({ version: V2, body: "Uus tekst, Kati Kask." });
  });

  test("M-4: payments off — nothing is read for the contract, and the answer stays „unavailable“", async () => {
    await ecourseReady();
    await db.execute(sql`alter table pages rename to pages_away`);
    try {
      expect(await handleEcoursePurchase(formDeps({ montonio: null }).deps, cartForm())).toEqual({ ok: false, errors: { form: "unavailable" } });
    } finally {
      await db.execute(sql`alter table pages_away rename to pages`);
    }
    expect(await db.select().from(payments)).toEqual([]);
  });
});

describe("R7, R8, M-6: the purchase's contract — its times, its student, once", () => {
  test("R7: a gate acceptance inside an open payment window, then settle — the purchase is accepted at the press that filled its snapshot (a re-send's), and the gate's contract is superseded at the settlement, after it was accepted", async () => {
    const m = stubMontonio();
    const { kati, access } = await freeGrant();
    const pressed = new Date(NOW.getTime() + MIN);
    await startPurchase(m); // at NOW
    const p = await startPurchase(m, {}, pressed); // „Maksa“ again: the same open attempt, its snapshot filled again
    expect(p.contractSnapshot!.acceptedAt).toBe(pressed.toISOString());
    expect(await acceptTerms(db, kati.id, SLUG, V1, LATER, { locale: "et" })).toBe("accepted"); // the gate, while the payment is open
    await pay(m, p, LATEST);
    const [gate, bought, ...none] = await allContracts();
    expect(none).toEqual([]);
    expect(gate).toMatchObject({ acceptedVia: "terms", accessId: access.id, acceptedAt: LATER, supersededAt: LATEST });
    expect(bought).toMatchObject({ acceptedVia: "purchase", accessId: access.id, paymentId: p.id, acceptedAt: pressed, supersededAt: null });
    // superseded at the settlement (deps.now), never before the contract that replaced it was accepted or made
    expect(gate.supersededAt!.getTime()).toBeGreaterThanOrEqual(gate.acceptedAt.getTime());
    expect(gate.supersededAt!.getTime()).toBeGreaterThanOrEqual(bought.acceptedAt.getTime());
  });

  test("R7: a snapshot kept before it carried its press is accepted at the payment's start", async () => {
    const m = stubMontonio();
    await ecourseReady();
    const p = await startPurchase(m);
    const { acceptedAt: _pressed, ...older } = p.contractSnapshot!;
    void _pressed;
    await db.update(payments).set({ contractSnapshot: older }).where(eq(payments.id, p.id));
    await pay(m, p);
    expect((await allContracts())[0].acceptedAt).toEqual(p.createdAt);
  });

  test("R8: an existing client types another name in the cart — the contract names her one way: its {nimi} and its „Pooled“ are the name she typed", async () => {
    const m = stubMontonio();
    await ecourseReady();
    await db.insert(clients).values({ email: "kati@example.com", name: "Katrin", locale: "et" });
    await pay(m, await startPurchase(m, { name: "  Kati   Kask " }));
    expect((await katiClient()).name).toBe("Katrin"); // her account keeps its name
    const [k] = await allContracts();
    expect(k.body).toBe(`Tere Kati Kask, hind 190,00${NBSP}€.`);
    expect(k.fields.student).toEqual({ name: "Kati Kask", email: "kati@example.com" });
  });

  test("M-6: the same PAID twice (the webhook's retry, the return) leaves one contract and one mail with it", async () => {
    const m = stubMontonio();
    await ecourseReady();
    const p = await startPurchase(m);
    await pay(m, p);
    await pay(m, p, LATEST);
    expect(await allContracts()).toHaveLength(1);
    expect(hers(m).filter((x) => x.attachments?.some((a) => a.filename.startsWith("MS-LAB-leping-")))).toHaveLength(1);
  });
});

describe("M-5: mailContract once Resend took the mail", () => {
  test("a failure to record the send is logged on its own, and the mail still counts as sent", async () => {
    const m = stubMontonio();
    const { kati } = await freeGrant();
    const made: Contract[] = [];
    await acceptTerms(db, kati.id, SLUG, V1, NOW, { locale: "et", onContract: (c) => void made.push(c) });
    await db.execute(sql.raw("create or replace function mslab_refuse_contract_update() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$"));
    await db.execute(sql.raw("create trigger mslab_refuse_contract_update before update on contracts for each row execute function mslab_refuse_contract_update()"));
    const env: Env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test" };
    expect(await mailContract({ db, env, siteUrl: SITE, now: LATER }, made[0])).toBe(true);
    expect(hers(m)).toHaveLength(1);
    expect((await allContracts())[0].sentAt).toBeNull();
    expect(logged("error")).toContain(`[contracts] contract ${made[0].id}: mailed, but the send was not recorded: DrizzleQueryError (code P0001)`);
    expect(logged("error").join("\n")).not.toContain("the mail failed");
  });
});

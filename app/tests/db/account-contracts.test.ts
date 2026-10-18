import { eq, sql } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import * as schema from "@/db/schema";
import { clients, clientSessions, contracts, courseAccess, courses, registrations, type Contract, type Registration } from "@/db/schema";
import type { AccountCard, ContactCard, EcourseCard, IndividualCard } from "@/domain/account-cards";
import { INVOICE_KEY } from "@/domain/invoice";
import { ru } from "@/i18n/dict/ru";
import { handleAccountApi, sessionCookies, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS, linkClientRecords } from "@/server/client-auth";
import { loadDashboard } from "@/server/client-data";
import { renderContract } from "@/server/contract-pdf";
import { requestContract, saveContractTexts } from "@/server/contracts";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, stubFetch } from "../fakes";
import { readPdf } from "../pdf-read";
import { makeTestDb } from "./helpers";
import { contactCourse, registrationOn } from "./payments-fixtures";

// The student's side of the contracts (contracts Task 6; spec D4, D6, D7, §4 Account) against a real (PGlite) database:
// - the dashboard carries the contract of each contact and e-course card in ONE query (ruling R14: the owner is the registration's or the
//   access's live client, else the one the contract froze, so a contract made before she had an account is on her card once she is linked),
//   and `contractRequested` where Maria has asked and the registration is not cancelled;
// - GET /api/konto/leping/<id>: the PDF as a download, hers only (404 for any other id), 10 an hour (a 404 counts), a render that fails is 500;
// - GET /api/konto/leping-tekst/<registrationId>: the current filled text for „Kinnita leping“, only while Maria's ask is open on her own,
//   not cancelled, group registration; 404 for everything else;
// - POST /api/konto/leping { registrationId, version, locale? }: „Kinnitan“ (ruling R3) in one transaction under the registration's lock:
//   it needs the ask still open inside the lock (a double tap makes one contract; the second answers 409 nothing), refuses a version that is
//   not the current one (409 version, R6), supersedes the old contract, clears the ask, and mails the new contract after the response in the
//   page's language (ruling R1; not in development). A contract that cannot be inserted leaves the ask and the old contract as they were.
// The PDF renderer is the real one, wrapped so a test can make a render fail.

vi.mock("@/server/contract-pdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/contract-pdf")>();
  return { ...real, renderContract: vi.fn(real.renderContract) };
});

/** 18.10.2026 12:00 in Tallinn. */
const NOW = new Date("2026-10-18T09:00:00Z");
const EARLIER = new Date("2026-10-10T09:00:00Z");
const DAY = 86_400_000;
const SITE = "https://mslab.example";
const NBSP = " ";
const SELLER = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" };
const SCHOOL = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu" };
/** Maria's contact text: placeholders and an unknown one; the Russian text with its own title. */
const CONTACT = {
  title: { et: "Kontaktkoolituse leping", ru: "Договор очного обучения" },
  body: {
    et: "Õpilane {nimi} ({e-post}) registreerub koolitusele {koolitus}.\n\nToimumine: {toimumine}. Hind {hind}, ettemaks {ettemaks}. {tundmatu}",
    ru: "Ученик {nimi} ({e-post}) записывается на курс {koolitus}.\n\nДата и место: {toimumine}. Цена {hind}, предоплата {ettemaks}.",
  },
};
const CONTACT_SAVED = new Date("2026-10-12T09:00:00Z");
const LATER_SAVE = new Date("2026-10-17T09:00:00Z");

type SentMail = { to: string; subject: string; text: string; html?: string; attachments?: { filename: string; content: string; content_type: string }[] };

let db: Db;
let kv: ReturnType<typeof fakeKv>;
let tasks: (() => Promise<unknown>)[];
beforeEach(async () => {
  db = await makeTestDb();
  kv = fakeKv();
  tasks = [];
  vi.mocked(renderContract).mockClear();
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const logs = () => (["info", "warn", "error"] as const).flatMap((m) => vi.mocked(console[m]).mock.calls.map((c) => c.map(String).join(" "))).join("\n");

const deps = (over: Partial<AccountDeps> = {}): AccountDeps => ({
  db,
  env: { KV: kv, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test" },
  now: NOW,
  siteUrl: SITE,
  later: (task) => void tasks.push(task),
  dev: false,
  ...over,
});
/** Runs the work queued after the responses, one task after the other. */
async function flush() {
  for (let task = tasks.shift(); task; task = tasks.shift()) await task();
}
/** Resend behind a stubbed fetch: the mails it was given. */
function resend() {
  const f = stubFetch((url) => (url.includes("resend") ? Response.json({ id: "email_1" }) : Response.json({})));
  return { mails: () => f.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as SentMail) };
}

/** A client with one live session. */
async function student(email: string, name: string, locale: "et" | "ru" = "et") {
  const [client] = await db.insert(clients).values({ email, name, locale }).returning();
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: client.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return { id: client.id, email, cookie: `__Host-mslab_client=${raw}` };
}

const call = async (cookie: string | null, method: string, path: string, body?: unknown, d: AccountDeps = deps()) =>
  (await handleAccountApi(
    new Request(`${SITE}/api/konto${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    d,
  ))!;
const post = (cookie: string | null, body: unknown, d?: AccountDeps) => call(cookie, "POST", "/leping", body, d);

/** Seaded's seller and Maria's contact text (saved 12.10.), and the contact course (350 €; 14.11.2026 10:00, Pärnu, MS LAB stuudio). */
async function ready() {
  await setSetting(db, INVOICE_KEY, SELLER);
  expect(await saveContractTexts(db, CONTACT, CONTACT_SAVED)).toEqual({ ok: true });
  return contactCourse(db);
}
/** The fields of a contract row made by hand. */
const fieldsOf = (r: Pick<Registration, "name" | "email">, course = "Kulmumeistri baaskoolitus") => ({ school: SCHOOL, student: { name: r.name, email: r.email }, course, session: "14.11.2026, Pärnu, MS LAB stuudio", price: `350,00${NBSP}€`, payment: "50% registreerimisel + 50% koolituspäeval" });
/** A contract of `r`'s accepted at `acceptedAt`, current unless `supersededAt` says otherwise. */
async function contractOf(r: Registration, over: Partial<typeof contracts.$inferInsert> = {}): Promise<Contract> {
  const [row] = await db
    .insert(contracts)
    .values({ kind: "contact", registrationId: r.id, courseId: r.courseId, clientId: r.clientId, version: "1", locale: "et", title: "Kontaktkoolituse leping", body: "Tekst.", fields: fieldsOf(r), acceptedAt: EARLIER, acceptedVia: "form", ...over })
    .returning();
  return row;
}
const allContracts = () => db.select().from(contracts).orderBy(contracts.id);
/** Maria's „Saada leping kinnitamiseks“ on `r`. */
async function ask(r: Registration, at = new Date("2026-10-15T09:00:00Z")) {
  expect(await requestContract(db, r.id, at)).toEqual({ ok: true });
}
const askedAt = async (r: Registration) => (await db.select({ at: registrations.contractRequestedAt }).from(registrations).where(eq(registrations.id, r.id)))[0].at;

const cards = async (clientId: number) => (await loadDashboard(db, clientId, NOW))!.cards;
const contactCard = (all: AccountCard[], registrationId: number) => all.find((c): c is ContactCard => c.kind === "contact" && c.registrationId === registrationId)!;
const ecourseCard = (all: AccountCard[], slug: string) => all.find((c): c is EcourseCard => c.kind === "ecourse" && c.course.slug === slug)!;

/** An e-course and an access of `clientId` to it. */
async function ecourseAccess(clientId: number, slug = "kulmud-e") {
  const [course] = await db.insert(courses).values({ slug, type: "e_learning", level: "basic", title: { et: "Kulmude e-kursus", ru: "Онлайн-курс бровей" }, summary: { et: "" }, body: { et: "" }, price: 9500, published: true }).returning();
  const [access] = await db.insert(courseAccess).values({ clientId, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 180 * DAY) }).returning();
  return { course, access };
}

describe("loadDashboard: her contract on the card it belongs to", () => {
  test("a contact card carries its current contract { id, acceptedAt } and contractRequested false; the superseded one is not on the card", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    const old = await contractOf(r, { acceptedAt: EARLIER, supersededAt: new Date("2026-10-14T09:00:00Z") });
    const current = await contractOf(r, { acceptedAt: new Date("2026-10-14T09:00:00Z"), acceptedVia: "account" });
    const card = contactCard(await cards(kati.id), r.id);
    expect(card.contract).toEqual({ id: current.id, acceptedAt: "2026-10-14T09:00:00.000Z" });
    expect(card.contract!.id).not.toBe(old.id);
    expect(card.contractRequested).toBe(false);
  });

  test("a card with no contract has contract null (not absent); an individual registration's card has none of the two", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    expect(contactCard(await cards(kati.id), r.id)).toMatchObject({ contract: null, contractRequested: false });
    await db.update(courses).set({ priceIndividual: 45000 }).where(eq(courses.id, c.course.id));
    await registrationOn(db, c, { clientId: kati.id, kind: "individual", courseSessionId: null, paymentChoice: "full" });
    const individual = (await cards(kati.id)).find((x): x is IndividualCard => x.kind === "individual")!;
    expect("contract" in individual || "contractRequested" in individual).toBe(false);
  });

  test("contractRequested is Maria's open ask on a registration that is not cancelled; her ask on a cancelled one does not show", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const asked = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    const quiet = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    const cancelled = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    await ask(asked);
    await ask(cancelled);
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, cancelled.id));
    const all = await cards(kati.id);
    expect(contactCard(all, asked.id).contractRequested).toBe(true);
    expect(contactCard(all, quiet.id).contractRequested).toBe(false);
    expect(contactCard(all, cancelled.id).contractRequested).toBe(false);
  });

  test("an e-course card carries its access's contract (a purchase's or the gate's); contractRequested is always false there", async () => {
    const kati = await student("kati@example.test", "Kati Kask");
    const bought = await ecourseAccess(kati.id);
    const none = await ecourseAccess(kati.id, "varvid-e");
    const made = { kind: "ecourse" as const, accessId: bought.access.id, courseId: bought.course.id, clientId: kati.id, version: "1", locale: "et" as const, title: "E-koolituse leping", body: "Tekst.", fields: { ...fieldsOf({ name: "Kati Kask", email: kati.email }), session: "", payment: "" } };
    await db.insert(contracts).values({ ...made, acceptedAt: EARLIER, acceptedVia: "terms", supersededAt: new Date("2026-10-11T09:00:00Z") });
    const [current] = await db.insert(contracts).values({ ...made, acceptedAt: new Date("2026-10-11T09:00:00Z"), acceptedVia: "purchase" }).returning();
    const all = await cards(kati.id);
    expect(ecourseCard(all, "kulmud-e")).toMatchObject({ contract: { id: current.id, acceptedAt: "2026-10-11T09:00:00.000Z" }, contractRequested: false });
    expect(ecourseCard(all, "varvid-e")).toMatchObject({ contract: null, contractRequested: false });
    expect(none.access.id).not.toBe(bought.access.id);
  });

  test("R14: a contract she accepted before her account existed (client_id null) is on her card once her registration is linked; the frozen row is untouched", async () => {
    const c = await ready();
    const r = await registrationOn(db, c, { clientId: null, email: "kati@example.test" });
    const frozen = await contractOf(r, { clientId: null });
    const [account] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati" }).returning();
    expect((await cards(account.id)).filter((x) => x.kind === "contact")).toEqual([]);
    await linkClientRecords(db, account.id, account.email);
    expect(contactCard(await cards(account.id), r.id).contract).toMatchObject({ id: frozen.id });
    expect((await allContracts())[0].clientId).toBeNull();
  });

  test("R14: another client's contract is on none of her cards, and a registration Maria re-links takes its contract to the new student's card only", async () => {
    const c = await ready();
    const a = await student("a@example.test", "Anu Aas");
    const b = await student("b@example.test", "Bert Bergmann");
    const r = await registrationOn(db, c, { clientId: a.id, email: a.email, name: "Anu Aas" });
    const mine = await contractOf(r);
    expect(contactCard(await cards(a.id), r.id).contract).toMatchObject({ id: mine.id });
    expect((await cards(b.id)).filter((x) => x.kind === "contact")).toEqual([]);
    await db.update(registrations).set({ clientId: b.id }).where(eq(registrations.id, r.id));
    expect((await cards(a.id)).filter((x) => x.kind === "contact")).toEqual([]);
    expect(contactCard(await cards(b.id), r.id).contract).toMatchObject({ id: mine.id });
  });

  test("one query for all the contracts, however many cards there are (no N+1)", async () => {
    const log: string[] = [];
    const logged = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string) => void log.push(query) } });
    await migrate(logged, { migrationsFolder: "./drizzle" });
    db = logged as unknown as Db;
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    for (let i = 0; i < 4; i++) {
      const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
      await contractOf(r);
    }
    await ecourseAccess(kati.id);
    log.length = 0;
    const dash = (await loadDashboard(db, kati.id, NOW))!;
    expect(dash.cards.filter((x) => x.kind === "contact")).toHaveLength(4);
    expect(log.filter((q) => /from "contracts"/.test(q))).toHaveLength(1);
  });
});

describe("GET /api/konto/leping/<id>: her contract as a PDF", () => {
  test("the PDF of her contract as a download: its type, file name by id, nosniff, private no-store; drawn from the frozen row", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    const k = await contractOf(r, { title: "Lepingu pealkiri", body: "Esimene lõik.\n\nTeine lõik." });
    const res = await call(kati.cookie, "GET", `/leping/${k.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="MS-LAB-leping-${k.id}.pdf"`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const text = (await readPdf(bytes)).runs.map((run) => run.text).join("\n");
    expect(text).toContain("Lepingu pealkiri");
    expect(text).toContain("Teine lõik.");
  });

  test("her superseded contract can be downloaded too", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    const old = await contractOf(r, { supersededAt: new Date("2026-10-14T09:00:00Z") });
    await contractOf(r, { acceptedAt: new Date("2026-10-14T09:00:00Z") });
    expect((await call(kati.cookie, "GET", `/leping/${old.id}`)).status).toBe(200);
  });

  test("another client's contract, an unknown id and an id that cannot be one are all the same 404; the session comes first (401)", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const mari = await student("mari@example.test", "Mari Maasikas");
    const r = await registrationOn(db, c, { clientId: mari.id, email: mari.email, name: "Mari Maasikas" });
    const hers = await contractOf(r);
    const orphan = await contractOf(r, { registrationId: null, clientId: mari.id });
    for (const id of [String(hers.id), String(orphan.id), "99999", "0", "-1", "abc", "1.5", "007"]) {
      const res = await call(kati.cookie, "GET", `/leping/${id}`);
      expect(res.status, id).toBe(404);
      expect(await res.json(), id).toEqual({ ok: false });
    }
    const anon = await call(null, "GET", `/leping/${hers.id}`);
    expect(anon.status).toBe(401);
    expect(renderContract).not.toHaveBeenCalled();
  });

  test("R14: a contract accepted before her account existed downloads once her registration is linked, and not before", async () => {
    const c = await ready();
    const r = await registrationOn(db, c, { clientId: null, email: "kati@example.test" });
    const frozen = await contractOf(r, { clientId: null });
    const kati = await student("kati@example.test", "Kati Kask");
    expect((await call(kati.cookie, "GET", `/leping/${frozen.id}`)).status).toBe(404);
    await linkClientRecords(db, kati.id, kati.email);
    expect((await call(kati.cookie, "GET", `/leping/${frozen.id}`)).status).toBe(200);
  });

  test("10 an hour, a 404 counts too (so ids cannot be probed); the limit is hers, not the address's", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const mari = await student("mari@example.test", "Mari Maasikas");
    const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    const k = await contractOf(r);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await call(kati.cookie, "GET", `/leping/${i % 2 ? 99999 : k.id}`)).status);
    expect(statuses).toEqual([200, 404, 200, 404, 200, 404, 200, 404, 200, 404, 429, 429]);
    expect((await call(kati.cookie, "GET", `/leping/${k.id}`)).headers.get("content-type")).toContain("application/json");
    expect((await call(mari.cookie, "GET", "/leping/99999")).status).toBe(404);
    expect([...kv.store.keys()].some((key) => key.includes("client-contract-pdf"))).toBe(true);
  });

  test("a PDF that fails to render is 500 { error: \"server\" }, logged by the contract's id and the error's class only", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email, name: "Kati Salajane" });
    const k = await contractOf(r);
    vi.mocked(renderContract).mockRejectedValueOnce(new Error("boom: kati@example.test Kati Salajane"));
    const res = await call(kati.cookie, "GET", `/leping/${k.id}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "server" });
    expect(logs()).toContain(`${k.id}`);
    expect(logs()).not.toContain("kati@example.test");
    expect(logs()).not.toContain("Salajane");
  });
});

describe("GET /api/konto/leping-tekst/<registrationId>: the text „Kinnita leping“ shows", () => {
  test("the current text filled with her registration, in the page's language: Estonian by default, Russian on the Russian page", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email, name: "Kati Kask" });
    await ask(r);
    const et = await call(kati.cookie, "GET", `/leping-tekst/${r.id}`);
    expect(et.status).toBe(200);
    expect(et.headers.get("cache-control")).toBe("private, no-store");
    expect(await et.json()).toEqual({
      ok: true,
      title: "Kontaktkoolituse leping",
      body: `Õpilane Kati Kask (kati@example.test) registreerub koolitusele Kulmumeistri baaskoolitus.\n\nToimumine: 14.11.2026, Pärnu, MS LAB stuudio. Hind 350,00${NBSP}€, ettemaks 175,00${NBSP}€. {tundmatu}`,
      version: CONTACT_SAVED.toISOString(),
      locale: "et",
    });
    const ruRes = await (await call(kati.cookie, "GET", `/leping-tekst/${r.id}?l=ru`)).json();
    expect(ruRes).toMatchObject({ ok: true, title: "Договор очного обучения", version: CONTACT_SAVED.toISOString(), locale: "ru" });
    expect(ruRes.body).toContain("Ученик Kati Kask (kati@example.test) записывается на курс Базовый курс бровиста.");
    expect(ruRes.body).toContain("Дата и место: 14.11.2026, Pärnu, MS LAB stuudio. Цена");
  });

  test("a Russian page with no Russian text gets the Estonian one (the language the contract would be made in, D6)", async () => {
    const c = await ready();
    expect(await saveContractTexts(db, { title: { et: "Ainult eesti leping" }, body: { et: "Tekst {nimi}." } }, LATER_SAVE)).toEqual({ ok: true });
    const kati = await student("kati@example.test", "Kati Kask", "ru");
    const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email, name: "Kati Kask", locale: "ru" });
    await ask(r);
    expect(await (await call(kati.cookie, "GET", `/leping-tekst/${r.id}?l=ru`)).json()).toMatchObject({ ok: true, title: "Ainult eesti leping", body: "Tekst Kati Kask.", locale: "et" });
  });

  test("a text Maria edits after the page was loaded is another version (what „Kinnitan“ compares)", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    await ask(r);
    const before = await (await call(kati.cookie, "GET", `/leping-tekst/${r.id}`)).json();
    expect(await saveContractTexts(db, { title: { et: "Uus pealkiri" }, body: { et: "Uus tekst." } }, LATER_SAVE)).toEqual({ ok: true });
    const after = await (await call(kati.cookie, "GET", `/leping-tekst/${r.id}`)).json();
    expect(after).toMatchObject({ title: "Uus pealkiri", body: "Uus tekst.", version: LATER_SAVE.toISOString() });
    expect(after.version).not.toBe(before.version);
  });

  test("404 unless the registration is hers, a group one, not cancelled, and Maria's ask is open; 401 without a session", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const mari = await student("mari@example.test", "Mari Maasikas");
    const quiet = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    const maris = await registrationOn(db, c, { clientId: mari.id, email: mari.email, name: "Mari Maasikas" });
    await ask(maris);
    const cancelled = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    await ask(cancelled);
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, cancelled.id));
    const unlinked = await registrationOn(db, c, { clientId: null, email: kati.email });
    await db.update(registrations).set({ contractRequestedAt: NOW }).where(eq(registrations.id, unlinked.id));
    for (const id of [quiet.id, maris.id, cancelled.id, unlinked.id, 99999]) {
      const res = await call(kati.cookie, "GET", `/leping-tekst/${id}`);
      expect(res.status, String(id)).toBe(404);
      expect(await res.json()).toEqual({ ok: false });
    }
    for (const id of ["abc", "0", "-1", "1.5"]) expect((await call(kati.cookie, "GET", `/leping-tekst/${id}`)).status, id).toBe(404);
    expect((await call(null, "GET", `/leping-tekst/${maris.id}`)).status).toBe(401);
  });

  test("a registration that is not a group one (an individual course's) is 404 even with the flag set by hand", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    await db.update(courses).set({ priceIndividual: 45000 }).where(eq(courses.id, c.course.id));
    const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email, kind: "individual", courseSessionId: null, paymentChoice: "full", contractRequestedAt: NOW });
    expect((await call(kati.cookie, "GET", `/leping-tekst/${r.id}`)).status).toBe(404);
  });
});

describe("POST /api/konto/leping: „Kinnitan“", () => {
  /** A registration of Kati's with a contract from the form and Maria's ask open; her page showed the text of `version`. */
  async function asked(over: { email?: string; locale?: "et" | "ru" } = {}) {
    const c = await ready();
    const kati = await student(over.email ?? "kati@example.com", "Kati Kask", over.locale ?? "et");
    const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email, name: "Kati Kask", locale: over.locale ?? "et" });
    const old = await contractOf(r, { version: "0" });
    await ask(r);
    return { c, kati, r, old };
  }

  test("accepts the current text: a new contract via „account“ with the text filled, the old one superseded, the ask cleared; the answer is { ok: true }", async () => {
    const { c, kati, r, old } = await asked();
    const res = await post(kati.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString(), locale: "et" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ ok: true });
    const [first, made, ...rest] = await allContracts();
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ id: old.id, supersededAt: NOW });
    expect(made).toMatchObject({
      kind: "contact",
      registrationId: r.id,
      accessId: null,
      courseId: c.course.id,
      clientId: kati.id,
      paymentId: null,
      version: CONTACT_SAVED.toISOString(),
      locale: "et",
      title: "Kontaktkoolituse leping",
      body: `Õpilane Kati Kask (kati@example.com) registreerub koolitusele Kulmumeistri baaskoolitus.\n\nToimumine: 14.11.2026, Pärnu, MS LAB stuudio. Hind 350,00${NBSP}€, ettemaks 175,00${NBSP}€. {tundmatu}`,
      acceptedAt: NOW,
      acceptedVia: "account",
      supersededAt: null,
      sentAt: null,
      fields: { school: SCHOOL, student: { name: "Kati Kask", email: "kati@example.com" }, course: "Kulmumeistri baaskoolitus", session: "14.11.2026, Pärnu, MS LAB stuudio", price: `350,00${NBSP}€`, payment: "50% registreerimisel + 50% koolituspäeval" },
    });
    expect(await askedAt(r)).toBeNull();
    // the card now shows the line, not „Kinnita leping“
    expect(contactCard(await cards(kati.id), r.id)).toMatchObject({ contract: { id: made.id, acceptedAt: NOW.toISOString() }, contractRequested: false });
  });

  test("the new contract is mailed after the response, with its PDF, in the page's language; sent_at is recorded; nothing is mailed before the work after the response runs", async () => {
    const { kati, r } = await asked();
    const sent = resend();
    expect((await post(kati.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString(), locale: "et" })).status).toBe(200);
    expect(sent.mails()).toEqual([]);
    expect(tasks).toHaveLength(1);
    await flush();
    const [mail, ...none] = sent.mails();
    expect(none).toEqual([]);
    const made = (await allContracts())[1];
    expect(mail).toMatchObject({ to: "kati@example.com", subject: "MS LAB leping" });
    expect(mail.attachments).toEqual([expect.objectContaining({ filename: `MS-LAB-leping-${made.id}.pdf`, content_type: "application/pdf" })]);
    expect(Buffer.from(mail.attachments![0].content, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect(mail.text).toContain("Leping on lisatud.");
    expect((await allContracts())[1].sentAt).toEqual(NOW);
  });

  test("the mail is in the language of the page she accepted on: a Russian page with a Russian text", async () => {
    const { kati, r } = await asked({ locale: "ru" });
    const sent = resend();
    expect((await post(kati.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString(), locale: "ru" })).status).toBe(200);
    await flush();
    const made = (await allContracts())[1];
    expect(made).toMatchObject({ locale: "ru", title: "Договор очного обучения", acceptedVia: "account" });
    expect(made.fields.course).toBe("Базовый курс бровиста");
    expect(made.fields.payment).toBe("50% при регистрации + 50% в день обучения");
    expect(sent.mails()).toHaveLength(1);
    expect(sent.mails()[0].subject).toBe(ru.account.contractMail.subject);
  });

  test("the contract's language is the page's, not the registration's: an Estonian registration accepted on the Russian page is made in Russian (D6, as the gate does), and with no `locale` it is her account's", async () => {
    const { kati, r } = await asked({ locale: "et" });
    expect((await post(kati.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString(), locale: "ru" })).status).toBe(200);
    expect((await allContracts())[1]).toMatchObject({ locale: "ru", title: "Договор очного обучения" });
    await ask(r);
    expect((await post(kati.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString() }, deps({ now: new Date(NOW.getTime() + 60_000) }))).status).toBe(200);
    expect((await allContracts())[2]).toMatchObject({ locale: "et", title: "Kontaktkoolituse leping" });
  });

  test("review M-1: with no language sent, the text route and „Kinnitan“ fall back to the same one — her account's — so the text shown is the text frozen", async () => {
    const c = await ready();
    for (const locale of ["ru", "et"] as const) {
      const kati = await student(`kati-${locale}@example.com`, "Kati Kask", locale);
      const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email, name: "Kati Kask" });
      // none sent, one that is not a language (`l=en`) and an empty one: her account's, for the text and for the acceptance alike
      for (const [n, query] of ["", "?l=en", "?l="].entries()) {
        await ask(r);
        const shown = (await (await call(kati.cookie, "GET", `/leping-tekst/${r.id}${query}`)).json()) as { title: string; body: string; version: string; locale: string };
        expect(shown, `${locale} ${query}`).toMatchObject({ ok: true, locale, title: locale === "ru" ? "Договор очного обучения" : "Kontaktkoolituse leping" });
        const res = await post(kati.cookie, { registrationId: r.id, version: shown.version }, deps({ now: new Date(NOW.getTime() + n * 60_000) }));
        expect(res.status, `${locale} ${query}`).toBe(200);
        const [frozen] = (await allContracts()).filter((x) => x.registrationId === r.id && x.supersededAt === null);
        expect([frozen.locale, frozen.title, frozen.body, frozen.version], `${locale} ${query}`).toEqual([shown.locale, shown.title, shown.body, shown.version]);
      }
    }
  });

  test("a Russian page with no Russian text makes an Estonian contract (the Estonian text is the one the others fall back to)", async () => {
    const { kati, r } = await asked({ locale: "ru" });
    expect(await saveContractTexts(db, { title: { et: "Ainult eesti" }, body: { et: "Tekst {nimi}." } }, LATER_SAVE)).toEqual({ ok: true });
    expect((await post(kati.cookie, { registrationId: r.id, version: LATER_SAVE.toISOString(), locale: "ru" })).status).toBe(200);
    expect((await allContracts())[1]).toMatchObject({ locale: "et", title: "Ainult eesti", body: "Tekst Kati Kask." });
  });

  test("development mails nothing (the terms POST's rule), the contract is made all the same; a sample address is not mailed either", async () => {
    const { kati, r } = await asked();
    const sent = resend();
    expect((await post(kati.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString() }, deps({ dev: true }))).status).toBe(200);
    expect(tasks).toHaveLength(0);
    expect(sent.mails()).toEqual([]);
    expect(await allContracts()).toHaveLength(2);
  });

  test("a version that is not the current one is 409 { error: \"version\" } and nothing changes: the ask stays, the old contract stays current", async () => {
    const { kati, r, old } = await asked();
    const sent = resend();
    for (const body of [
      { registrationId: r.id, version: "2026-01-01T00:00:00.000Z" },
      { registrationId: r.id, version: "" },
      { registrationId: r.id },
    ]) {
      const res = await post(kati.cookie, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: "version" });
    }
    expect(await allContracts()).toHaveLength(1);
    expect((await allContracts())[0]).toMatchObject({ id: old.id, supersededAt: null });
    expect(await askedAt(r)).not.toBeNull();
    await flush();
    expect(sent.mails()).toEqual([]);
  });

  test("a text Maria saves between the card's text and „Kinnitan“ is a 409; the text read again carries the new version and then it is accepted", async () => {
    const { kati, r } = await asked();
    const shown = (await (await call(kati.cookie, "GET", `/leping-tekst/${r.id}`)).json()) as { version: string };
    expect(await saveContractTexts(db, { title: { et: "Uus pealkiri" }, body: { et: "Uus tekst, {nimi}." } }, LATER_SAVE)).toEqual({ ok: true });
    expect((await post(kati.cookie, { registrationId: r.id, version: shown.version })).status).toBe(409);
    expect(await allContracts()).toHaveLength(1);
    const fresh = (await (await call(kati.cookie, "GET", `/leping-tekst/${r.id}`)).json()) as { version: string; title: string };
    expect(fresh).toMatchObject({ title: "Uus pealkiri", version: LATER_SAVE.toISOString() });
    expect((await post(kati.cookie, { registrationId: r.id, version: fresh.version })).status).toBe(200);
    expect((await allContracts())[1]).toMatchObject({ title: "Uus pealkiri", body: "Uus tekst, Kati Kask.", version: LATER_SAVE.toISOString() });
  });

  test("without Maria's open ask it is 409 { error: \"nothing\" }, nothing is made (a registration she never asked about, or a second tap)", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const r = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    const res = await post(kati.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString() });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "nothing" });
    expect(await allContracts()).toEqual([]);
  });

  test("ruling R3: a double tap makes ONE contract — the second tap, in the same instant, finds the ask answered inside the lock: 409 nothing, no second mail", async () => {
    const { kati, r, old } = await asked();
    const sent = resend();
    const body = { registrationId: r.id, version: CONTACT_SAVED.toISOString(), locale: "et" };
    const answers = await Promise.all([post(kati.cookie, body), post(kati.cookie, body)]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(await Promise.all(answers.map((a) => a.json()))).toEqual(expect.arrayContaining([{ ok: true }, { ok: false, error: "nothing" }]));
    const rows = await allContracts();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.supersededAt === null)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: old.id, supersededAt: NOW });
    await flush();
    expect(sent.mails()).toHaveLength(1);
    // and a third tap, long after
    expect((await post(kati.cookie, body)).status).toBe(409);
    expect(await allContracts()).toHaveLength(2);
  });

  test("another client's registration, a cancelled one, an individual one and an unknown id are all 404 { error: \"registration\" }, and nothing is written", async () => {
    const c = await ready();
    const kati = await student("kati@example.test", "Kati Kask");
    const mari = await student("mari@example.test", "Mari Maasikas");
    const maris = await registrationOn(db, c, { clientId: mari.id, email: mari.email, name: "Mari Maasikas" });
    await ask(maris);
    const cancelled = await registrationOn(db, c, { clientId: kati.id, email: kati.email });
    await ask(cancelled);
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, cancelled.id));
    await db.update(courses).set({ priceIndividual: 45000 }).where(eq(courses.id, c.course.id));
    const individual = await registrationOn(db, c, { clientId: kati.id, email: kati.email, kind: "individual", courseSessionId: null, paymentChoice: "full", contractRequestedAt: NOW });
    const unlinked = await registrationOn(db, c, { clientId: null, email: kati.email, contractRequestedAt: NOW });
    for (const id of [maris.id, cancelled.id, individual.id, unlinked.id, 99999]) {
      const res = await post(kati.cookie, { registrationId: id, version: CONTACT_SAVED.toISOString() });
      expect(res.status, String(id)).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "registration" });
    }
    expect(await allContracts()).toEqual([]);
    expect(await askedAt(maris)).not.toBeNull();
  });

  test("a registration re-linked to another student is that student's to accept, not the first one's (the live link decides, R14)", async () => {
    const { kati, r } = await asked();
    const mari = await student("mari@example.test", "Mari Maasikas");
    await db.update(registrations).set({ clientId: mari.id }).where(eq(registrations.id, r.id));
    expect((await post(kati.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString() })).status).toBe(404);
    expect((await post(mari.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString() })).status).toBe(200);
    expect((await allContracts())[1]).toMatchObject({ clientId: mari.id, acceptedVia: "account" });
  });

  test("a contract that cannot be inserted undoes the whole act: the ask stays, the old contract stays current, no mail, a 500 the card can retry", async () => {
    const { kati, r, old } = await asked();
    await db.execute(sql.raw("create or replace function mslab_refuse_contract() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$"));
    await db.execute(sql.raw("create trigger mslab_refuse_contract before insert on contracts for each row execute function mslab_refuse_contract()"));
    const res = await post(kati.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString() });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "server" });
    expect(await allContracts()).toHaveLength(1);
    expect((await allContracts())[0]).toMatchObject({ id: old.id, supersededAt: null });
    expect(await askedAt(r)).not.toBeNull();
    expect(tasks).toHaveLength(0);
    await db.execute(sql.raw("drop trigger mslab_refuse_contract on contracts"));
    expect((await post(kati.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString() })).status).toBe(200);
  });

  test("a body that is not { registrationId, version?, locale? } is 400 { error: <field> }; no session is 401; a request from another site is 403 — nothing is made", async () => {
    const { kati, r } = await asked();
    const cases: [unknown, string][] = [
      [{ version: CONTACT_SAVED.toISOString() }, "registrationId"],
      [{ registrationId: "7", version: "1" }, "registrationId"],
      [{ registrationId: 0, version: "1" }, "registrationId"],
      [{ registrationId: 1.5, version: "1" }, "registrationId"],
      [{ registrationId: r.id, version: 5 }, "version"],
      [{ registrationId: r.id, version: "v".repeat(65) }, "version"],
      [{ registrationId: r.id, version: "1", locale: "en" }, "locale"],
      ["[]", "body"],
      ["{", "body"],
    ];
    for (const [body, error] of cases) {
      const res = await post(kati.cookie, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error });
    }
    const anon = await post(null, { registrationId: r.id, version: CONTACT_SAVED.toISOString() });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ ok: false, reason: "none" });
    const cross = await handleAccountApi(
      new Request(`${SITE}/api/konto/leping`, { method: "POST", headers: { cookie: kati.cookie, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ registrationId: r.id, version: CONTACT_SAVED.toISOString() }) }),
      deps(),
    );
    expect(cross!.status).toBe(403);
    expect(await allContracts()).toHaveLength(1);
    expect(await askedAt(r)).not.toBeNull();
  });

  test("the answers carry a renewed session's cookies, on success and on a refusal alike", async () => {
    const { kati, r } = await asked();
    const raw = kati.cookie.slice(kati.cookie.indexOf("=") + 1);
    const later = deps({ now: new Date(NOW.getTime() + 2 * DAY) });
    const refused = await post(kati.cookie, { registrationId: r.id, version: "nope" }, later);
    expect(refused.status).toBe(409);
    expect(refused.headers.getSetCookie()).toEqual(sessionCookies(raw));
    const accepted = await post(kati.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString() }, later);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.getSetCookie()).toEqual([]);
  });

  test("the logs carry ids only: no address, name or contract text", async () => {
    const { kati, r } = await asked();
    resend();
    await post(kati.cookie, { registrationId: r.id, version: CONTACT_SAVED.toISOString() });
    await flush();
    for (const secret of ["kati@example.com", "Kati Kask", "registreerub"]) expect(logs()).not.toContain(secret);
  });
});

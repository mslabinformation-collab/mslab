import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import { clients, contracts, pages, registrations, type Contract } from "@/db/schema";
import { CONTRACT_CONTACT_KEY, CONTRACT_CONTACT_VERSION_KEY } from "@/domain/contract";
import { INVOICE_KEY } from "@/domain/invoice";
import { adminEt } from "@/i18n/dict/admin";
import { linkClientRecords } from "@/server/client-auth";
import { renderContract } from "@/server/contract-pdf";
import { contractForRegistration, mailContractRequest, registrationContractFields, saveContractTexts } from "@/server/contracts";
import type { Env } from "@/server/notify";
import { fakeKv, stubFetch } from "../fakes";
import { readPdf } from "../pdf-read";
import { makeTestDb } from "./helpers";
import { contactCourse, registrationOn, SITE } from "./payments-fixtures";

// Maria's contract actions on a real (PGlite) database (contracts Task 5; spec D2, D4, D7; rulings R1 and R9): Seaded's save (the text stored, its
// version bumped by a change only, the course pages revalidated through the settings' path), „Saada leping kinnitamiseks“ (recorded; the mail to the
// registration's address in its language with a plain link to the account, best effort), „Saada koopia õpilasele“ (the PDF to the address the contract
// froze, `sent_at` recorded). Resend is a recording fake, the renderer and fonts are the real ones; the admin session, the cache and the request's
// headers are stand-ins (the guard is tests/unit/admin-guards.test.ts's, the routes' is admin-contract-routes.test.ts's).

const state = vi.hoisted(() => ({ db: null as unknown, mail: true }));
vi.mock("@/server/contract-pdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/contract-pdf")>();
  return { ...real, renderContract: vi.fn(real.renderContract) };
});
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => cache);
vi.mock("@/server/public-cache", () => pub);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));
vi.mock("@/server/send-deps", () => ({
  adminSendDeps: async () => ({
    db: state.db,
    env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, ...(state.mail ? { RESEND_API_KEY: "re_test" } : {}) } satisfies Env,
    siteUrl: SITE,
    now: new Date("2026-10-17T09:00:00Z"),
    later: () => {},
  }),
}));

const actions = await import("@/server/actions/admin-contracts");
const E = adminEt.contracts.errors;

const NOW = new Date("2026-10-17T09:00:00Z");
const CARD = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" };
const CONTACT = {
  title: { et: "Kontaktkoolituse leping", ru: "Договор очного обучения" },
  body: { et: "Õpilane {nimi} registreerub koolitusele {koolitus}.", ru: "Ученик {nimi} записывается на курс {koolitus}." },
};

type SentMail = { to: string; subject: string; text: string; html?: string; attachments?: { filename: string; content: string; content_type: string }[] };

let db: Db;
let fixture: Awaited<ReturnType<typeof contactCourse>>;
let fetches: ReturnType<typeof stubFetch>;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.mail = true;
  cache.refresh.mockReset();
  pub.revalidatePublic.mockReset();
  vi.mocked(renderContract).mockClear();
  fetches = stubFetch((url) => (url.includes("resend") ? Response.json({ id: "email_1" }) : Response.json({})));
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  await setSetting(db, INVOICE_KEY, CARD);
  fixture = await contactCourse(db, { capacity: 20 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mails = (): SentMail[] => fetches.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as SentMail);
const logged = () => (["info", "warn", "error"] as const).flatMap((m) => vi.mocked(console[m]).mock.calls.map((c) => c.map(String).join(" "))).join("\n");
const registration = async (over: Partial<typeof registrations.$inferInsert> = {}) => {
  const email = over.email ?? "kati@example.com";
  const [client] = await db.insert(clients).values({ email, name: "Kati Tamm" }).returning();
  return registrationOn(db, fixture, { email, name: "Kati Tamm", clientId: client.id, ...over });
};
const row = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0];
const accept = async (r: { id: number; clientId: number | null; courseId: number }, now: Date = NOW): Promise<Contract> =>
  db.transaction(async (tx) => {
    const f = (await registrationContractFields(tx, r.id))!;
    return contractForRegistration(tx, { registrationId: r.id, clientId: r.clientId, courseId: r.courseId, template: f.template, fields: f.fields, prepaymentText: f.prepaymentText, via: "form", now });
  });

describe("saveContractTextsAction: Seaded → Lepingud → „Salvesta lepingud“", () => {
  test("the texts are stored as Maria's page, the version is the save's time, the card comes back as stored, and the course pages are revalidated through the settings' path", async () => {
    const result = await actions.saveContractTextsAction({ title: { et: "  Kontaktkoolituse leping ", ru: " Договор очного обучения " }, body: { et: " Õpilane {nimi}. ", ru: " Ученик {nimi}. " } });
    expect(result).toEqual({ ok: true, card: { title: { et: "Kontaktkoolituse leping", ru: "Договор очного обучения" }, body: { et: "Õpilane {nimi}.", ru: "Ученик {nimi}." } } });
    const [page] = await db.select().from(pages).where(eq(pages.key, CONTRACT_CONTACT_KEY));
    expect(page).toMatchObject({ title: { et: "Kontaktkoolituse leping", ru: "Договор очного обучения" }, body: { et: "Õpilane {nimi}.", ru: "Ученик {nimi}." } });
    const version = await readSetting(db, CONTRACT_CONTACT_VERSION_KEY);
    expect(new Date(version as string).toISOString()).toBe(version);
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "settings", parts: ["contract_contact"] });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("the same texts again keep the version (nobody is asked again), and still revalidate; a changed text is a new version", async () => {
    const texts = { title: { et: "Leping" }, body: { et: "Tekst." } };
    await actions.saveContractTextsAction(texts);
    const first = await readSetting(db, CONTRACT_CONTACT_VERSION_KEY);
    await actions.saveContractTextsAction(texts);
    expect(await readSetting(db, CONTRACT_CONTACT_VERSION_KEY)).toBe(first);
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(2);
    await actions.saveContractTextsAction({ title: { et: "Leping" }, body: { et: "Teine tekst." } });
    expect(await readSetting(db, CONTRACT_CONTACT_VERSION_KEY)).not.toBe(first);
  });

  test("a refused field comes back by name; nothing is stored, nothing revalidated, the page not refreshed", async () => {
    expect(await actions.saveContractTextsAction({ title: { et: " " }, body: { et: "x".repeat(30_001) } })).toEqual({ ok: false, fields: { title: "required", body: "tooLong" } });
    expect(await actions.saveContractTextsAction({ title: { et: "Leping" }, body: { et: "Tekst.", ru: "Текст." }, extra: 1 } as never)).toMatchObject({ ok: true }); // an unknown key is ignored
    expect(await actions.saveContractTextsAction("not an object")).toEqual({ ok: false, fields: { form: "invalid" } });
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1); // the one good save
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("a save that is refused writes nothing at all", async () => {
    await actions.saveContractTextsAction({ title: { et: "" }, body: { et: "Tekst." } });
    expect(await db.select().from(pages).where(eq(pages.key, CONTRACT_CONTACT_KEY))).toEqual([]);
    expect(await readSetting(db, CONTRACT_CONTACT_VERSION_KEY)).toBeNull();
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });
});

describe("requestContractAction: „Saada leping kinnitamiseks“ (ruling R9)", () => {
  test("recorded, and the student is mailed: „MS LAB leping kinnitamiseks“ to the registration's address, with the course and a plain link to /konto — no login in it, no attachment", async () => {
    const r = await registration();
    expect(await actions.requestContractAction({ registrationId: r.id })).toEqual({ ok: true, mailed: true });
    expect((await row(r.id)).contractRequestedAt).toBeInstanceOf(Date);
    const [mail, ...more] = mails();
    expect(more).toEqual([]);
    expect([mail.to, mail.subject]).toEqual(["kati@example.com", "MS LAB leping kinnitamiseks"]);
    expect(mail.text).toContain("Tere, Kati!");
    expect(mail.text).toContain("Maria palub sul kinnitada lepingu koolituse „Kulmumeistri baaskoolitus“ jaoks.");
    expect(mail.text).toContain(`${SITE}/konto`);
    expect(mail.text).not.toMatch(/verify|token|#email|\?t=/);
    expect(mail.html).toContain(`href="${SITE}/konto"`);
    expect(mail.attachments).toBeUndefined();
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("a Russian registration: the Russian mail, the Russian course name, /ru/konto", async () => {
    const r = await registration({ locale: "ru" });
    await actions.requestContractAction({ registrationId: r.id });
    const [mail] = mails();
    expect(mail.subject).toBe("Договор MS LAB — подтвердите");
    expect(mail.text).toContain("«Базовый курс бровиста»");
    expect(mail.text).toContain(`${SITE}/ru/konto`);
  });

  test("it is offered with a current contract or without (D4): the contract stays as it is, only the ask is recorded; asking again moves the day and mails again", async () => {
    const r = await registration();
    const c = await accept(r);
    expect(await actions.requestContractAction({ registrationId: r.id })).toEqual({ ok: true, mailed: true });
    const first = (await row(r.id)).contractRequestedAt!;
    expect((await db.select().from(contracts).where(eq(contracts.id, c.id)))[0]).toEqual(c);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await actions.requestContractAction({ registrationId: r.id })).toEqual({ ok: true, mailed: true });
    expect((await row(r.id)).contractRequestedAt!.getTime()).toBeGreaterThan(first.getTime());
    expect(mails()).toHaveLength(2);
  });

  test("a sample address (@example.test) is recorded and not mailed — the account shows the ask all the same", async () => {
    const [client] = await db.insert(clients).values({ email: "proov@example.test", name: "Proov" }).returning();
    const r = await registrationOn(db, fixture, { email: "proov@example.test", name: "Proov", clientId: client.id });
    expect(await actions.requestContractAction({ registrationId: r.id })).toEqual({ ok: true, mailed: false });
    expect((await row(r.id)).contractRequestedAt).toBeInstanceOf(Date);
    expect(mails()).toEqual([]);
    expect(logged()).toContain(`[contracts] registration ${r.id}: the ask was not mailed (sample address)`);
  });

  test("without Resend (local development) it is recorded and nothing is mailed", async () => {
    state.mail = false;
    const r = await registration();
    expect(await actions.requestContractAction({ registrationId: r.id })).toEqual({ ok: true, mailed: false });
    expect((await row(r.id)).contractRequestedAt).toBeInstanceOf(Date);
    expect(mails()).toEqual([]);
  });

  test("best effort: Resend refusing the mail never fails the action; the ask stands", async () => {
    fetches.restore();
    fetches = stubFetch((url) => (url.includes("resend") ? new Response(JSON.stringify({ name: "application_error", message: "down", statusCode: 500 }), { status: 500 }) : Response.json({})));
    const r = await registration();
    expect(await actions.requestContractAction({ registrationId: r.id })).toEqual({ ok: true, mailed: false });
    expect((await row(r.id)).contractRequestedAt).toBeInstanceOf(Date);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("the logs carry ids, never the address or the name", async () => {
    const r = await registration();
    await actions.requestContractAction({ registrationId: r.id });
    expect(logged()).toContain(`[contracts] registration ${r.id}: the ask was mailed: true`);
    expect(logged()).not.toMatch(/kati|Tamm/i);
  });

  test("refused, in words, with nothing recorded and nothing mailed: no account, cancelled, an individual registration, an unknown one", async () => {
    const noAccount = await registrationOn(db, fixture, { email: "mari@example.com", name: "Mari" });
    expect(await actions.requestContractAction({ registrationId: noAccount.id })).toEqual({ ok: false, error: "noAccount", text: "Õpilasel pole kontot — lisa ta Õpilased lehel." });
    const cancelled = await registration({ status: "cancelled", email: "liis@example.com" });
    expect(await actions.requestContractAction({ registrationId: cancelled.id })).toEqual({ ok: false, error: "cancelled", text: E.cancelled });
    const individual = await registration({ kind: "individual", courseSessionId: null, email: "juhan@example.com" });
    expect(await actions.requestContractAction({ registrationId: individual.id })).toEqual({ ok: false, error: "notFound", text: E.notFound });
    expect(await actions.requestContractAction({ registrationId: 999_999 })).toEqual({ ok: false, error: "notFound", text: E.notFound });
    for (const id of [noAccount.id, cancelled.id, individual.id]) expect((await row(id)).contractRequestedAt).toBeNull();
    expect(mails()).toEqual([]);
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("mailContractRequest: the mail alone", () => {
  const deps = () => ({ db, env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test" } satisfies Env, siteUrl: SITE });

  test("an unknown registration is not mailed and does not throw", async () => {
    expect(await mailContractRequest(deps(), 999_999)).toBe(false);
    expect(mails()).toEqual([]);
  });

  test("a failing database never throws: false, logged by the id and the class", async () => {
    const r = await registration();
    const broken = { ...deps(), db: { select: () => { throw new TypeError("boom: kati@example.com"); } } as unknown as Db };
    expect(await mailContractRequest(broken, r.id)).toBe(false);
    expect(logged()).toContain(`[contracts] registration ${r.id}: the ask's mail failed: TypeError`);
    expect(logged()).not.toContain("kati");
  });
});

describe("sendContractCopyAction: „Saada koopia õpilasele“ (ruling R1)", () => {
  test("the contract's PDF goes to the address it froze, in its language, with „Leping on lisatud.“; the send is recorded", async () => {
    await saveContractTexts(db, CONTACT, NOW);
    const r = await registration({ locale: "ru" });
    const c = await accept(r);
    // the registration's address changes later: the copy goes to the one the contract froze
    await db.update(registrations).set({ email: "uus@example.com" }).where(eq(registrations.id, r.id));
    expect(await actions.sendContractCopyAction({ id: c.id })).toEqual({ ok: true });
    const [mail, ...more] = mails();
    expect(more).toEqual([]);
    expect([mail.to, mail.subject]).toEqual(["kati@example.com", "Договор MS LAB"]);
    expect(mail.attachments!.map((a) => [a.filename, a.content_type])).toEqual([[`MS-LAB-leping-${c.id}.pdf`, "application/pdf"]]);
    const text = (await readPdf(new Uint8Array(Buffer.from(mail.attachments![0].content, "base64")))).runs.map((x) => x.text).join("\n");
    expect(text).toContain("Договор очного обучения");
    expect(text).toContain("Kati Tamm");
    expect((await db.select().from(contracts).where(eq(contracts.id, c.id)))[0].sentAt).toBeInstanceOf(Date);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(mail.html).toContain(`${SITE}/ru/konto`);
  });

  test("ruling R14: a student whose account came after her form still gets the button — the copy decides on the registration's live link, not on the client the contract froze", async () => {
    const r = await registrationOn(db, fixture, { email: "mari@example.com", name: "Mari Maasikas" });
    const c = await accept(r);
    expect(c.clientId).toBeNull();
    // her account is made later and her registration linked to it; the contract row is not touched
    const [client] = await db.insert(clients).values({ email: "mari@example.com", name: "Mari Maasikas" }).returning();
    await linkClientRecords(db, client.id, client.email);
    expect((await db.select().from(contracts).where(eq(contracts.id, c.id)))[0].clientId).toBeNull();
    expect(await actions.sendContractCopyAction({ id: c.id })).toEqual({ ok: true });
    const [mail] = mails();
    expect(mail.text).toContain("Ava minu konto");
    expect(mail.html).toContain(`${SITE}/konto/sisene#email=mari%40example.com`);
    expect(mail.attachments).toHaveLength(1);
  });

  test("ruling R15: the PDF is drawn first and once; when it cannot be drawn nothing is sent, nothing is recorded, and Maria is told in words", async () => {
    const c = await accept(await registration());
    vi.mocked(renderContract).mockRejectedValueOnce(new TypeError("boom: Kati Tamm, kati@example.com"));
    expect(await actions.sendContractCopyAction({ id: c.id })).toEqual({ ok: false, error: "pdfFailed", text: "Lepingu PDF-i ei õnnestunud koostada — proovi uuesti." });
    expect(E.pdfFailed).toBe("Lepingu PDF-i ei õnnestunud koostada — proovi uuesti.");
    expect(mails()).toEqual([]); // not even a mail without the contract
    expect((await db.select().from(contracts).where(eq(contracts.id, c.id)))[0].sentAt).toBeNull();
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(logged()).toContain(`[contracts] contract ${c.id}: the copy's PDF could not be drawn: TypeError`);
    expect(logged()).not.toMatch(/kati|Tamm/i);
    // the next press draws it again, sends it once with its PDF, and only then says so
    expect(await actions.sendContractCopyAction({ id: c.id })).toEqual({ ok: true });
    expect(mails()).toHaveLength(1);
    expect(mails()[0].attachments).toHaveLength(1);
    expect(vi.mocked(renderContract)).toHaveBeenCalledTimes(2); // the failed draw and the one that went (not a third inside the mail)
    expect((await db.select().from(contracts).where(eq(contracts.id, c.id)))[0].sentAt).toBeInstanceOf(Date);
  });

  test("a contract with no account behind it gets the copy without a link to an account", async () => {
    const r = await registrationOn(db, fixture, { email: "mari@example.com", name: "Mari Maasikas" });
    const c = await accept(r);
    expect(c.clientId).toBeNull();
    expect(await actions.sendContractCopyAction({ id: c.id })).toEqual({ ok: true });
    const [mail] = mails();
    expect(mail.html).not.toContain("konto");
    expect(mail.text).not.toContain("konto");
    expect(mail.attachments).toHaveLength(1);
  });

  test("Minor 9: a copy that can never go — a sample address, no Resend — is refused in its own words before the PDF is drawn, and records no send", async () => {
    const [client] = await db.insert(clients).values({ email: "proov@example.test" }).returning();
    const sample = await accept(await registrationOn(db, fixture, { email: "proov@example.test", name: "Proov", clientId: client.id }));
    expect(await actions.sendContractCopyAction({ id: sample.id })).toEqual({ ok: false, error: "sampleAddress", text: "Sellele aadressile kirja ei saadeta." });
    state.mail = false;
    const real = await accept(await registration());
    expect(await actions.sendContractCopyAction({ id: real.id })).toEqual({ ok: false, error: "mailOff", text: "Kirjade saatmine pole siin seadistatud." });
    expect(vi.mocked(renderContract)).not.toHaveBeenCalled(); // no PDF drawn for a copy that cannot go
    expect((await db.select().from(contracts)).map((c) => c.sentAt)).toEqual([null, null]);
    expect(mails()).toEqual([]);
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("an unknown contract is `contractNotFound` in words; nothing is mailed", async () => {
    expect(await actions.sendContractCopyAction({ id: 999_999 })).toEqual({ ok: false, error: "contractNotFound", text: E.contractNotFound });
    expect(mails()).toEqual([]);
  });
});

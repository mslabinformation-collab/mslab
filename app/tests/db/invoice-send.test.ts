import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { invoices, registrations } from "@/db/schema";
import { cancelInvoice, createInvoice, markInvoicePaid } from "@/server/invoices";
import { sendInvoice } from "@/server/invoice-send";
import type { Env } from "@/server/notify";
import { fakeKv, stubFetch } from "../fakes";
import { readPdf } from "../pdf-read";
import { makeTestDb } from "./helpers";
import { contactCourse, registrationOn } from "./payments-fixtures";

// Maria's „Saada õpilasele“ (invoices Task 5, spec §4, D11, ruling R1: server/invoice-send.ts) against a real (PGlite) database, the real
// PDF and a stubbed Resend: the invoice goes to the registration's address in her language with its PDF attached; the optional second
// address gets its own copy, for this send only, and is kept as the note of the last send; nothing goes to a sample address; a mail that is
// not accepted records nothing; it is not counted in the daily caps; and the logs carry the invoice's id and counts only.

const SITE = "https://mslab.example";
const NOW = new Date("2026-10-16T09:00:00Z");
const CARD = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" };
const BANK = { receiver: "MS LAB Koolituskeskus OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };

type SentMail = { to: string; subject: string; text: string; html?: string; reply_to?: string; attachments?: { filename: string; content: string; content_type: string }[] };

let db: Db;
let fixture: Awaited<ReturnType<typeof contactCourse>>;
let kv: ReturnType<typeof fakeKv>;
beforeEach(async () => {
  db = await makeTestDb();
  await setSetting(db, "invoice", CARD);
  await setSetting(db, "prepayment", BANK);
  fixture = await contactCourse(db, { capacity: 20 });
  kv = fakeKv();
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const env = (over: Partial<Env> = {}): Env => ({ KV: kv, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test", ...over });
const deps = (over: Partial<Env> = {}) => ({ db, env: env(over), siteUrl: SITE, now: NOW });
/** Resend behind a stubbed fetch: the mails it was asked to send; `refuse(to)` makes it answer an error for that address. */
function resend(refuse: (to: string) => boolean = () => false) {
  const f = stubFetch((url, init) => {
    const to = (JSON.parse(String(init?.body)) as { to: string }).to;
    return url.includes("resend") ? (refuse(to) ? Response.json({ name: "validation_error", message: "no", statusCode: 422 }, { status: 422 }) : Response.json({ id: "email_1" })) : Response.json({});
  });
  return { mails: () => f.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as SentMail) };
}
async function request(email: string, over: Partial<typeof registrations.$inferInsert> = {}) {
  const r = await registrationOn(db, fixture, { email, name: "Kati Tamm", ...over });
  const made = await createInvoice(db, r.id, { kind: "prepayment", mode: "request" }, NOW);
  if (!made.ok) throw new Error(made.error);
  return made.invoice;
}
const row = async (id: number) => (await db.select().from(invoices).where(eq(invoices.id, id)))[0];
const infoLog = () => vi.mocked(console.info).mock.calls.flat().join("\n");
const errorLog = () => vi.mocked(console.error).mock.calls.flat().join("\n");

describe("sendInvoice: the student's mail", () => {
  test("goes to the address of the registration with the invoice's PDF attached, in Estonian; the send is recorded", async () => {
    const inv = await request("kati@school.example");
    const sent = resend();
    expect(await sendInvoice(deps(), inv.id, "")).toEqual({ ok: true });
    const [mail] = sent.mails();
    expect(sent.mails()).toHaveLength(1);
    expect([mail.to, mail.subject]).toEqual(["kati@school.example", "MS LAB arve MSL2026-001"]);
    expect(mail.text).toContain("Tere, Kati!");
    expect(mail.text).toContain("Tasumise tähtaeg: 23.10.2026");
    expect(mail.text).toContain("Selgitus: MSLAB-");
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments![0]).toMatchObject({ filename: "MS-LAB-arve-MSL2026-001.pdf", content_type: "application/pdf" });
    const pdf = await readPdf(new Uint8Array(Buffer.from(mail.attachments![0].content, "base64")));
    expect(pdf.runs.map((r) => r.text).join("\n")).toContain("MSL2026-001");
    const after = await row(inv.id);
    expect([after.sentAt, after.sentNote]).toEqual([NOW, ""]);
    expect(infoLog()).toContain(`[invoices] invoice ${inv.id}: sent to 1 address`);
  });

  test("a Russian-speaking registration gets the Russian mail", async () => {
    const inv = await request("mari@school.example", { locale: "ru", name: "Мария Иванова" });
    const sent = resend();
    expect(await sendInvoice(deps(), inv.id, undefined)).toEqual({ ok: true });
    expect(sent.mails()[0].subject).toBe("Счёт MS LAB MSL2026-001");
    expect(sent.mails()[0].text).toContain("Здравствуйте, Мария!");
  });

  test("a paid invoice may be sent too: it asks for no money (no bank details, no due date)", async () => {
    const inv = await request("kati@school.example");
    expect((await markInvoicePaid(db, inv.id, { paidAt: NOW, method: "bank" }, NOW)).ok).toBe(true);
    const sent = resend();
    expect(await sendInvoice(deps(), inv.id, "")).toEqual({ ok: true });
    expect(sent.mails()[0].text).toContain("Tasutud: 16.10.2026");
    expect(sent.mails()[0].text).not.toContain("IBAN");
  });

  test("it is not counted in the daily caps (no counter is touched) and Maria's inbox is the reply-to", async () => {
    const inv = await request("kati@school.example");
    const sent = resend();
    await sendInvoice(deps(), inv.id, "");
    expect([...kv.store.keys()]).toEqual([]);
    expect(sent.mails()[0].reply_to).toBe("maria@example.test");
  });
});

describe("sendInvoice: „Saada ka aadressile“", () => {
  test("the second address gets its own copy, for this send only; it is kept as the note of the last send, nowhere else", async () => {
    const inv = await request("kati@school.example");
    const sent = resend();
    expect(await sendInvoice(deps(), inv.id, "  Raamatupidaja@Firma.Example ")).toEqual({ ok: true });
    expect(sent.mails().map((m) => [m.to, m.subject])).toEqual([["kati@school.example", "MS LAB arve MSL2026-001"], ["raamatupidaja@firma.example", "MS LAB arve MSL2026-001"]]);
    expect(sent.mails().every((m) => m.attachments?.length === 1)).toBe(true);
    const after = await row(inv.id);
    expect([after.sentAt, after.sentNote]).toEqual([NOW, "raamatupidaja@firma.example"]);
    expect(after.buyer.email).toBe("kati@school.example"); // the buyer is untouched
    expect(infoLog()).toContain(`[invoices] invoice ${inv.id}: sent to 2 addresses`);
    expect(infoLog() + errorLog()).not.toContain("firma.example");
    // the next send without one clears the note: it is the last send's
    resend();
    await sendInvoice(deps(), inv.id, "");
    expect((await row(inv.id)).sentNote).toBe("");
  });

  test("the student's own address typed again is sent once; a blank one is none", async () => {
    const inv = await request("kati@school.example");
    const sent = resend();
    expect(await sendInvoice(deps(), inv.id, "KATI@school.example")).toEqual({ ok: true });
    expect(sent.mails()).toHaveLength(1);
    expect((await row(inv.id)).sentNote).toBe("");
  });

  test("a second address that is no address is `email`: nothing sent, nothing recorded", async () => {
    const inv = await request("kati@school.example");
    const sent = resend();
    for (const bad of ["not an address", "a@b", "x@y@z.ee", 5, {}]) expect(await sendInvoice(deps(), inv.id, bad), String(bad)).toEqual({ ok: false, error: "email" });
    expect(sent.mails()).toHaveLength(0);
    expect((await row(inv.id)).sentAt).toBeNull();
  });

  test("the second address refused after the student's went: told (`secondFailed`), the send recorded without the note", async () => {
    const inv = await request("kati@school.example");
    const sent = resend((to) => to.startsWith("raamatupidaja"));
    expect(await sendInvoice(deps(), inv.id, "raamatupidaja@firma.example")).toEqual({ ok: true, secondFailed: true });
    expect(sent.mails()).toHaveLength(2);
    const after = await row(inv.id);
    expect([after.sentAt, after.sentNote]).toEqual([NOW, ""]);
  });
});

describe("sendInvoice: when it does not go", () => {
  test("the student's mail refused: `mailFailed`, the second address is not tried, nothing is recorded", async () => {
    const inv = await request("kati@school.example");
    const sent = resend(() => true);
    expect(await sendInvoice(deps(), inv.id, "raamatupidaja@firma.example")).toEqual({ ok: false, error: "mailFailed" });
    expect(sent.mails()).toHaveLength(1);
    expect((await row(inv.id)).sentAt).toBeNull();
    expect(errorLog()).toContain(`[invoices] invoice ${inv.id}: the mail was not sent`);
    expect(errorLog()).not.toContain("kati@");
  });

  test("a mail that is not set up here (no Resend key) is `mailFailed` before any PDF is drawn", async () => {
    const inv = await request("kati@school.example");
    const sent = resend();
    expect(await sendInvoice(deps({ RESEND_API_KEY: undefined }), inv.id, "")).toEqual({ ok: false, error: "mailFailed" });
    expect(sent.mails()).toHaveLength(0);
    expect((await row(inv.id)).sentAt).toBeNull();
  });

  test("a sample address (…@example.test) is never mailed: it counts as sent, so the flow can be tried; a real second address is still mailed", async () => {
    const inv = await request("e2e-kati@example.test");
    const sent = resend();
    expect(await sendInvoice(deps({ RESEND_API_KEY: undefined }), inv.id, "")).toEqual({ ok: true });
    expect(sent.mails()).toHaveLength(0);
    expect((await row(inv.id)).sentAt).toEqual(NOW);
    expect(await sendInvoice(deps(), inv.id, "raamatupidaja@firma.example")).toEqual({ ok: true });
    expect(sent.mails().map((m) => m.to)).toEqual(["raamatupidaja@firma.example"]);
    expect((await row(inv.id)).sentNote).toBe("raamatupidaja@firma.example");
  });

  test("a cancelled invoice is never mailed (`cancelled`); an unknown id is `notFound`", async () => {
    const inv = await request("kati@school.example");
    await cancelInvoice(db, inv.id, NOW);
    const sent = resend();
    expect(await sendInvoice(deps(), inv.id, "")).toEqual({ ok: false, error: "cancelled" });
    expect(await sendInvoice(deps(), 99999, "")).toEqual({ ok: false, error: "notFound" });
    expect(sent.mails()).toHaveLength(0);
    expect((await row(inv.id)).sentAt).toBeNull();
  });
});

import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { invoices, settings } from "@/db/schema";
import { tallinnFormParts } from "@/domain/calendar";
import { tallinnYear } from "@/domain/certificate";
import { createSession } from "@/server/auth";
import { sampleInvoicePdf } from "@/server/invoice-sample";
import { cancelInvoice, createInvoice, invoicePdf, markInvoicePaid } from "@/server/invoices";
import { readPdf } from "../pdf-read";
import { makeTestDb } from "./helpers";
import { contactCourse, registrationOn } from "./payments-fixtures";

// Maria's invoice downloads (invoices Task 5, spec §5, §6.5): GET /api/admin/arve/<id> (any invoice as a PDF), GET /api/admin/arved?kuu=… (the
// month's CSV for the accountant) and GET /api/admin/naidisarve (Seaded's sample from the card's values). Signed-in admins only; every answer
// is private, never kept, nosniff. The database is PGlite, the real renderer and fonts are used (wrapped, so a test can make a render fail), and the
// session cookie (next/headers) is faked, as in tests/db/admin-certificate-route.test.ts.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/invoices", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/invoices")>();
  return { ...real, invoicePdf: vi.fn(real.invoicePdf) };
});
vi.mock("@/server/invoice-sample", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/invoice-sample")>();
  return { ...real, sampleInvoicePdf: vi.fn(real.sampleInvoicePdf) };
});

import { GET as downloadInvoice, maxDuration } from "@/app/api/admin/arve/[id]/route";
import { GET as downloadCsv } from "@/app/api/admin/arved/route";
import { GET as downloadSample, maxDuration as sampleMaxDuration } from "@/app/api/admin/naidisarve/route";

const ORIGIN = "https://mslab.example";
const NBSP = " ";
const CARD = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" };
const BANK = { receiver: "MS LAB Koolituskeskus OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
const SEPTEMBER = new Date("2026-09-15T09:00:00Z");
const OCTOBER = new Date("2026-10-16T09:00:00Z");
/** The Tallinn year the sample is drawn in (it reads the clock): the suite does not depend on the year it runs in. */
const YEAR = tallinnYear(new Date());

let db: Db;
let fixture: Awaited<ReturnType<typeof contactCourse>>;
/** September's (MSL2026-001, cancelled), October's paid one (MSL2026-002) and October's unpaid one (MSL2026-003). */
let cancelled: number;
let paid: number;
let unpaid: number;

async function invoiceFor(email: string, name: string, at: Date, kind: "prepayment" | "full" = "prepayment") {
  const r = await registrationOn(db, fixture, { email, name });
  const made = await createInvoice(db, r.id, { kind, mode: "request" }, at);
  if (!made.ok) throw new Error(`the invoice was not made: ${made.error}`);
  return made.invoice;
}

beforeAll(async () => {
  db = await makeTestDb();
  await setSetting(db, "invoice", CARD);
  await setSetting(db, "prepayment", BANK);
  fixture = await contactCourse(db, { capacity: 20 });
  cancelled = (await invoiceFor("kati@example.test", "Kätlin Õun", SEPTEMBER)).id;
  paid = (await invoiceFor("mari@example.test", "Mari Maasikas", OCTOBER)).id;
  unpaid = (await invoiceFor("liis@example.test", "Liis Lill", OCTOBER)).id;
  expect((await cancelInvoice(db, cancelled, OCTOBER)).ok).toBe(true);
  expect((await markInvoicePaid(db, paid, { paidAt: OCTOBER, method: "bank" }, OCTOBER)).ok).toBe(true);
});
beforeEach(() => {
  state.db = db;
  state.cookie = undefined;
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.mocked(invoicePdf).mockClear();
  vi.mocked(sampleInvoicePdf).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const pdf = (id: string) => downloadInvoice(new Request(`${ORIGIN}/api/admin/arve/${id}`), { params: Promise.resolve({ id }) });
const csv = (query = "") => downloadCsv(new Request(`${ORIGIN}/api/admin/arved${query}`), undefined);
const sample = (query = "") => downloadSample(new Request(`${ORIGIN}/api/admin/naidisarve${query}`), undefined);
const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};
const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());
const textOf = async (bytes: Buffer) => (await readPdf(new Uint8Array(bytes))).runs.map((r) => r.text).join("\n");
/** The CSV's rows (header first) without the BOM. */
const rowsOf = async (res: Response) => (await bytesOf(res)).toString("utf8").slice(1).split("\r\n").filter(Boolean);

describe("without an admin's session", () => {
  test("every route answers 401 { ok: false, error: 'unauthorized' } and renders nothing", async () => {
    for (const res of [await pdf(String(paid)), await csv("?kuu=2026-10"), await sample("?company=X")]) {
      expect([res.status, await res.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
    }
    expect(invoicePdf).not.toHaveBeenCalled();
    expect(sampleInvoicePdf).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/arve/<id>: an invoice as a PDF", () => {
  test("the PDF as a download named after its number, private and never kept, nosniff", async () => {
    await signIn();
    const res = await pdf(String(unpaid));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="MS-LAB-arve-MSL2026-003.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = await bytesOf(res);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeLessThan(100 * 1024);
    const text = await textOf(bytes);
    for (const part of ["MSL2026-003", "Liis Lill", "EE382200221020145685", `175,00${NBSP}€`]) expect(text, part).toContain(part);
  });

  test("a paid and a cancelled invoice are Maria's to download too, each under its own number", async () => {
    await signIn();
    const marked = await pdf(String(paid));
    expect([marked.status, marked.headers.get("content-disposition")]).toEqual([200, 'attachment; filename="MS-LAB-arve-MSL2026-002.pdf"']);
    expect(await textOf(await bytesOf(marked))).toContain("Tasutud");
    const void_ = await pdf(String(cancelled));
    expect([void_.status, void_.headers.get("content-disposition")]).toEqual([200, 'attachment; filename="MS-LAB-arve-MSL2026-001.pdf"']);
    expect(await textOf(await bytesOf(void_))).toContain("MSL2026-001");
  });

  test("a render that fails answers 500 { ok: false, error: 'server' } and no PDF, and logs the invoice's id and the error's class only", async () => {
    await signIn();
    vi.mocked(invoicePdf).mockRejectedValueOnce(new TypeError("boom: Kätlin Õun, kati@example.test"));
    const res = await pdf(String(paid));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.json()).toEqual({ ok: false, error: "server" });
    expect(vi.mocked(console.error).mock.calls.map((call) => call.join(" "))).toEqual([`[invoices] invoice ${paid}: the admin's download failed: TypeError`]);
    expect((await pdf(String(paid))).status).toBe(200);
  });

  test("404: an id that is no invoice, or no id at all", async () => {
    await signIn();
    for (const id of ["999999", "abc", "0", "007", "2147483648", "-1", "1.5"]) {
      const res = await pdf(id);
      expect([res.status, await res.json()], id).toEqual([404, { ok: false, error: "notFound" }]);
    }
    expect(invoicePdf).not.toHaveBeenCalled();
  });

  test("a hung call does not hold the function: maxDuration 30, the sample's too", () => {
    expect(maxDuration).toBe(30);
    expect(sampleMaxDuration).toBe(30);
  });
});

describe("GET /api/admin/arved?kuu=: the month's CSV", () => {
  test("named after the month, a BOM first, `;`-separated, private, nosniff; the month's invoices in the order they were issued", async () => {
    await signIn();
    const res = await csv("?kuu=2026-10");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="MS-LAB-arved-2026-10.csv"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = await bytesOf(res.clone());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const rows = await rowsOf(res);
    expect(rows[0].split(";").slice(0, 3)).toEqual(["Arve nr", "Kuupäev", "Tasumise tähtaeg"]);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('"MSL2026-002"');
    expect(rows[1]).toContain("16.10.2026");
    expect(rows[1]).toContain('"Mari Maasikas"');
    expect(rows[1]).toContain(";175,00;Tasutud;");
    expect(rows[2]).toContain('"MSL2026-003"');
    expect(rows[2]).toContain(";Tasumata;");
  });

  test("another month holds its own, a cancelled one marked with zero sums; a month without any is the header alone", async () => {
    await signIn();
    const september = await rowsOf(await csv("?kuu=2026-09"));
    expect(september).toHaveLength(2);
    expect(september[1]).toContain('"MSL2026-001"');
    expect(september[1]).toContain(";0,00;0,00;0,00;Tühistatud;");
    const none = await csv("?kuu=2026-08");
    expect(await rowsOf(none)).toHaveLength(1);
    expect(none.headers.get("content-disposition")).toBe('attachment; filename="MS-LAB-arved-2026-08.csv"');
  });

  test("without ?kuu= it is this month (Tallinn's): an invoice made now is in it", async () => {
    await signIn();
    const now = new Date();
    const made = await invoiceFor("juhan@example.test", "Juhan Juur", now, "full");
    const res = await csv();
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="MS-LAB-arved-${tallinnFormParts(now).date.slice(0, 7)}.csv"`);
    expect((await rowsOf(res)).some((row) => row.includes(`"${made.number}"`))).toBe(true);
  });

  test("a month that is not YYYY-MM is 400 { ok: false, error: 'month' }, nothing read", async () => {
    await signIn();
    for (const q of ["?kuu=2026-13", "?kuu=2026-00", "?kuu=", "?kuu=oktoober", "?kuu=2026-10-01", "?kuu=2026-1"]) {
      const res = await csv(q);
      expect([res.status, await res.json()], q).toEqual([400, { ok: false, error: "month" }]);
    }
  });
});

describe("GET /api/admin/naidisarve: the sample from the card's values", () => {
  const countInvoices = async () => (await db.select().from(invoices)).length;
  const cardRow = () => db.select().from(settings).where(eq(settings.key, "invoice"));

  test("an inline PDF, private, never kept, nosniff, that reads the card's values from the query — saved or not", async () => {
    await signIn();
    const query = new URLSearchParams({
      company: "Uus Ettevõte OÜ", registryCode: "99887766", address: "Tartu mnt 5, Tartu", vatNumber: "EE100200300", vatOn: "1", vatRate: "22", prefix: "abc", nextSeq: "7", termDays: "14", footer: "Aitäh, et valisid meid!",
    });
    const res = await sample(`?${query}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="MS-LAB-naidisarve.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = await bytesOf(res);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeLessThan(100 * 1024);
    const text = await textOf(bytes);
    // the card's values, not the stored ones (MS LAB OÜ, MSL, 1)
    for (const part of ["Uus Ettevõte OÜ", "99887766", "Tartu mnt 5, Tartu", "EE100200300", `ABC${YEAR}-007`, "Aitäh, et valisid meid!", `175,00${NBSP}€`, "22%"]) expect(text, part).toContain(part);
    expect(text).not.toContain("MS LAB OÜ");
    // the bank details are the ones Ettemaksu juhised holds
    for (const part of ["MS LAB Koolituskeskus OÜ", "EE382200221020145685", "Swedbank"]) expect(text, part).toContain(part);
  });

  test("B21: the card has no year; a nextYear in the query is ignored, the number is this Tallinn year's with the card's next number", async () => {
    await signIn();
    const text = await textOf(await bytesOf(await sample("?company=A&registryCode=1&address=B&prefix=abc&nextYear=2031&nextSeq=7")));
    expect(text).toContain(`ABC${YEAR}-007`);
    expect(text).not.toContain("ABC2031");
  });

  test("VAT off on the card: the VAT-off sentence and no VAT lines", async () => {
    await signIn();
    const text = await textOf(await bytesOf(await sample("?company=A&registryCode=1&address=B&vatOn=0&vatNumber=EE1")));
    expect(text).toContain("Arve ei sisalda käibemaksu (müüja ei ole käibemaksukohustuslane).");
    expect(text).not.toContain("Käibemaks 24%");
  });

  test("nothing is stored and no number is used: the invoices, the stored card and the next number are as they were", async () => {
    await signIn();
    const before = { invoices: await countInvoices(), card: await cardRow() };
    expect((await sample("?company=Muu&registryCode=1&address=A&prefix=ZZ&nextSeq=500")).status).toBe(200);
    expect({ invoices: await countInvoices(), card: await cardRow() }).toEqual(before);
  });

  test("the card empty or the values wild: a sample all the same, in brackets for what is missing; a prefix that is no prefix is MSL; a long value is no value", async () => {
    await signIn();
    const empty = await sample();
    expect(empty.status).toBe(200);
    const text = await textOf(await bytesOf(empty));
    for (const part of ["(ettevõtte nimi)", "(registrikood)", "(aadress)"]) expect(text, part).toContain(part);
    const wild = await sample(`?company=${"X".repeat(5000)}&prefix=%3Cscript%3E&vatRate=abc&nextSeq=-4&vatOn=on&vatNumber=`);
    expect(wild.status).toBe(200);
    const wildText = await textOf(await bytesOf(wild));
    expect(wildText).toContain(`MSL${YEAR}-001`);
    expect(wildText).not.toContain("script");
  });

  test("a render that fails answers 500 and logs nothing of the values", async () => {
    await signIn();
    vi.mocked(sampleInvoicePdf).mockRejectedValueOnce(new TypeError("boom: Uus Ettevõte OÜ"));
    const res = await sample("?company=Uus%20Ettev%C3%B5te%20O%C3%9C");
    expect([res.status, await res.json()]).toEqual([500, { ok: false, error: "server" }]);
    expect(vi.mocked(console.error).mock.calls.map((call) => call.join(" "))).toEqual(["[invoices] the sample invoice failed: TypeError"]);
  });
});

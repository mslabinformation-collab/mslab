import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { invoices, payments, registrations } from "@/db/schema";
import { tallinnFormParts } from "@/domain/calendar";
import { adminEt } from "@/i18n/dict/admin";
import { cancelInvoice, catchUpInvoice, createInvoice, markInvoicePaid } from "@/server/invoices";
import { makeTestDb } from "./helpers";
import { contactCourse, pendingPayment, registrationOn } from "./payments-fixtures";

// Maria's invoice screens rendered from a real (PGlite) database to HTML (invoices Task 5, spec §5): the „Arved“ page (the list newest first,
// 50 a page, by month and state, „Arveta maksed“ on top with the invoice each row will pay, the month's CSV link), the registration drawer's
// „Arved“ block (the invoices and the amounts „Koosta arve“ offers), and the link from Maksed. The drawer's dialog and the server
// actions are stand-ins (they need a browser or a request); everything else is the real page.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/components/admin/Drawer", async () => {
  const { createElement } = await import("react");
  return { Drawer: ({ children }: { children: React.ReactNode }) => createElement("div", { "data-drawer-stand-in": "" }, children), useUnsavedInDrawer: () => {} };
});
vi.mock("@/server/actions/admin", () => ({ cancelRegistration: vi.fn(), addManualPaymentAction: vi.fn(), saveRegistrationStatus: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => ({
  createInvoiceAction: vi.fn(), sendInvoiceAction: vi.fn(), markInvoicePaidAction: vi.fn(), undoInvoicePaidAction: vi.fn(), cancelInvoiceAction: vi.fn(),
  updateInvoiceBuyerAction: vi.fn(), catchUpInvoiceAction: vi.fn(), saveInvoiceSettingsAction: vi.fn(),
}));
vi.mock("@/server/actions/admin-contracts", () => ({ saveContractTextsAction: vi.fn(), requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));

import InvoicesPage from "@/app/admin/(panel)/arved/page";
import PaymentsPage from "@/app/admin/(panel)/maksed/page";
import RegistrationsPage from "@/app/admin/(panel)/registreerimised/page";

const NBSP = " ";
const SELLER = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu" };
const CARD = { ...SELLER, vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" };
const BANK = { receiver: "MS LAB Koolituskeskus OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
const SEPTEMBER = new Date("2026-09-15T09:00:00Z");
const OCTOBER = new Date("2026-10-16T09:00:00Z");

const render = async (page: (p: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement>, search: Record<string, string> = {}) =>
  renderToStaticMarkup(await page({ searchParams: Promise.resolve(search) }));
/** The invoice numbers of a rendered list, in the order shown. */
const numbers = (html: string) => [...html.matchAll(/data-invoice="(MSL\d{4}-\d+)"/g)].map((m) => m[1]);

let db: Db;
let fixture: Awaited<ReturnType<typeof contactCourse>>;

async function seed() {
  db = await makeTestDb();
  state.db = db;
  vi.spyOn(console, "info").mockImplementation(() => {});
  fixture = await contactCourse(db, { capacity: 100 });
}
async function ready() {
  await setSetting(db, "invoice", CARD);
  await setSetting(db, "prepayment", BANK);
}
async function request(email: string, name: string, at: Date, kind: "prepayment" | "full" = "prepayment") {
  const r = await registrationOn(db, fixture, { email, name });
  const made = await createInvoice(db, r.id, { kind, mode: "request" }, at);
  if (!made.ok) throw new Error(made.error);
  return { registration: r, invoice: made.invoice };
}

describe("the „Arved“ page", () => {
  let kati: Awaited<ReturnType<typeof request>>;
  let mari: Awaited<ReturnType<typeof request>>;
  let liis: Awaited<ReturnType<typeof request>>;
  beforeAll(async () => {
    await seed();
    await ready();
    kati = await request("kati@example.com", "Kati Tamm", SEPTEMBER);
    mari = await request("mari@example.com", "Mari Kask", OCTOBER);
    liis = await request("liis@example.com", "Liis Mets", OCTOBER);
    await markInvoicePaid(db, mari.invoice.id, { paidAt: OCTOBER, method: "bank" }, OCTOBER);
    await cancelInvoice(db, kati.invoice.id, OCTOBER);
  });

  test("every invoice, newest first, with its buyer, its course and a link to its registration; a way back to Maksed", async () => {
    const html = await render(InvoicesPage);
    expect(numbers(html)).toEqual(["MSL2026-003", "MSL2026-002", "MSL2026-001"]);
    expect(html).toContain("<h1");
    expect(html).toContain(">Arved</h1>");
    expect(html).toContain('href="/admin/maksed"');
    expect(html).toContain("Arveid: 3");
    const liisRow = html.slice(html.indexOf('data-invoice="MSL2026-003"'), html.indexOf('data-invoice="MSL2026-002"'));
    expect(liisRow).toContain("Liis Mets");
    expect(liisRow).toContain("Kulmumeistri baaskoolitus");
    expect(liisRow).toContain(`href="/admin/registreerimised?id=${liis.registration.id}"`);
    expect(liisRow).toContain(`175,00${NBSP}€`);
    expect(liisRow).toContain(">Tasumata<");
    expect(html).toContain(">Tasutud<");
    expect(html).toContain(">Tühistatud<");
  });

  test("the state filter: ?staatus=unpaid|paid|cancelled; a value it does not know shows everything; its pills are links with the state in the address", async () => {
    expect(numbers(await render(InvoicesPage, { staatus: "paid" }))).toEqual(["MSL2026-002"]);
    expect(numbers(await render(InvoicesPage, { staatus: "unpaid" }))).toEqual(["MSL2026-003"]);
    expect(numbers(await render(InvoicesPage, { staatus: "cancelled" }))).toEqual(["MSL2026-001"]);
    expect(numbers(await render(InvoicesPage, { staatus: "makstud" }))).toHaveLength(3);
    const html = await render(InvoicesPage, { staatus: "paid" });
    expect(html).toContain('href="/admin/arved?staatus=unpaid"');
    expect(html).toMatch(/aria-current="true" href="\/admin\/arved\?staatus=paid"/);
  });

  test("the month filter: ?kuu=YYYY-MM is the month of the issue in Tallinn; anything else is no filter; combined with the state; the form keeps the state", async () => {
    expect(numbers(await render(InvoicesPage, { kuu: "2026-09" }))).toEqual(["MSL2026-001"]);
    expect(numbers(await render(InvoicesPage, { kuu: "2026-10" }))).toEqual(["MSL2026-003", "MSL2026-002"]);
    expect(numbers(await render(InvoicesPage, { kuu: "2026-10", staatus: "paid" }))).toEqual(["MSL2026-002"]);
    expect(numbers(await render(InvoicesPage, { kuu: "2026-08" }))).toEqual([]);
    expect(numbers(await render(InvoicesPage, { kuu: "oktoober" }))).toHaveLength(3);
    const html = await render(InvoicesPage, { kuu: "2026-10", staatus: "paid" });
    expect(html).toContain('name="kuu"');
    expect(html).toMatch(/<input[^>]*name="kuu"[^>]*value="2026-10"|<input[^>]*value="2026-10"[^>]*name="kuu"/);
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="staatus"[^>]*value="paid"|<input[^>]*name="staatus"[^>]*type="hidden"[^>]*value="paid"/);
    expect(html).toContain(">Kõik kuud<");
    expect(await render(InvoicesPage)).not.toContain(">Kõik kuud<");
    expect(await render(InvoicesPage, { kuu: "2026-08" })).toContain("Selle valikuga arveid pole.");
  });

  test("„Laadi alla (CSV)“ is the chosen month's file; without a month, this month's", async () => {
    expect(await render(InvoicesPage, { kuu: "2026-09" })).toContain('href="/api/admin/arved?kuu=2026-09"');
    expect(await render(InvoicesPage, { kuu: "2026-09" })).toContain("09.2026");
    const html = await render(InvoicesPage);
    expect(html).toContain(`href="/api/admin/arved?kuu=${tallinnFormParts(new Date()).date.slice(0, 7)}"`);
    expect(html).toContain(">Laadi alla (CSV)<");
  });

  test("Maksed links to it", async () => {
    const html = await render(PaymentsPage);
    expect(html).toMatch(/<a[^>]*href="\/admin\/arved"[^>]*>Arved<\/a>/);
  });
});

describe("the „Arved“ page: 50 a page", () => {
  test("the 51st is on page 2, newest first; a page past the end is the last; the pager links keep the filters", async () => {
    await seed();
    await ready();
    const { registration } = await request("kati@example.com", "Kati Tamm", SEPTEMBER);
    const template = (await db.select().from(invoices))[0];
    const { id: _id, ...rest } = template;
    void _id;
    await db.insert(invoices).values(
      Array.from({ length: 50 }, (_, i) => ({ ...rest, number: `MSL2026-${String(i + 2).padStart(3, "0")}`, seq: i + 2, registrationId: registration.id, issuedAt: new Date(OCTOBER.getTime() + i * 60_000) })),
    );
    const first = await render(InvoicesPage);
    expect(numbers(first)).toHaveLength(50);
    expect(numbers(first)[0]).toBe("MSL2026-051");
    expect(first).toContain("Arveid: 51");
    expect(first).toContain("data-pager");
    expect(first).toContain('href="/admin/arved?leht=2"');
    const second = await render(InvoicesPage, { leht: "2" });
    expect(numbers(second)).toEqual(["MSL2026-001"]);
    expect(numbers(await render(InvoicesPage, { leht: "9" }))).toEqual(["MSL2026-001"]);
    expect(await render(InvoicesPage, { kuu: "2026-10", leht: "2" })).toContain('href="/admin/arved?kuu=2026-10"');
  });
});

describe("„Arveta maksed“", () => {
  beforeEach(seed);
  const paid = async (email: string, name: string, at: Date, over: Partial<typeof payments.$inferInsert> = {}) => {
    const r = await registrationOn(db, fixture, { email, name });
    const p = await pendingPayment(db, r, {}, at);
    await db.update(payments).set({ status: "paid", paidAt: at, ...over }).where(eq(payments.id, p.id));
    return { r, p };
  };

  test("nothing paid without an invoice: no section, no heading", async () => {
    await ready();
    const html = await render(InvoicesPage);
    expect(html).not.toContain("data-uninvoiced");
    expect(html).not.toContain("Arveta maksed");
  });

  test("a paid payment with no invoice is listed oldest first, with its course, the day it was paid and its own „Koosta arve“", async () => {
    await ready();
    await paid("mari@example.com", "Mari Kask", OCTOBER);
    await paid("kati@example.com", "Kati Tamm", SEPTEMBER);
    const html = await render(InvoicesPage);
    expect(html).toContain("data-uninvoiced");
    expect(html).toContain(">Arveta maksed</h2>");
    const ids = [...html.matchAll(/data-uninvoiced-payment="(\d+)"/g)].map((m) => Number(m[1]));
    expect(ids).toHaveLength(2);
    const [first, second] = ids.map((id) => html.slice(html.indexOf(`data-uninvoiced-payment="${id}"`)));
    expect(first).toContain("Kati Tamm");
    expect(first).toContain(`175,00${NBSP}€`);
    expect(first).toContain("Kulmumeistri baaskoolitus");
    expect(first).toContain("Makstud 15.09.2026");
    expect(second).toContain("Mari Kask");
    expect(first).toContain("Koostab uue arve");
    expect([...html.matchAll(/data-uninvoiced-create="(\d+)"/g)].map((m) => Number(m[1]))).toEqual(ids);
    expect(html).not.toContain("data-uninvoiced-need-seller");
  });

  test("a payment started for an invoice that is still unpaid says which invoice it will pay; one whose invoice was cancelled will make a new one", async () => {
    await ready();
    const a = await request("kati@example.com", "Kati Tamm", SEPTEMBER);
    const b = await request("mari@example.com", "Mari Kask", OCTOBER);
    for (const [r, inv, at] of [[a.registration, a.invoice, SEPTEMBER], [b.registration, b.invoice, OCTOBER]] as const) {
      const p = await pendingPayment(db, r, {}, at);
      await db.update(payments).set({ status: "paid", paidAt: at, invoiceId: inv.id }).where(eq(payments.id, p.id));
    }
    await cancelInvoice(db, b.invoice.id, OCTOBER);
    const html = await render(InvoicesPage);
    const rows = [...html.matchAll(/data-uninvoiced-pays="">([^<]*)</g)].map((m) => m[1]);
    expect(rows).toEqual(["Tasub arve MSL2026-001", "Koostab uue arve"]);
  });

  test("without a seller the rows are listed but cannot be made: a link to Seaded → Arve andmed, no buttons", async () => {
    await paid("mari@example.com", "Mari Kask", OCTOBER);
    const html = await render(InvoicesPage);
    expect(html).toContain("data-uninvoiced-payment");
    expect(html).not.toContain("data-uninvoiced-create");
    expect(html).toMatch(/<a[^>]*href="\/admin\/seaded#arve"[^>]*>Täida Seaded → Arve andmed<\/a>/);
  });

  test("a payment that has its invoice is not listed", async () => {
    await ready();
    const a = await request("kati@example.com", "Kati Tamm", SEPTEMBER);
    const p = await pendingPayment(db, a.registration, {}, SEPTEMBER);
    await db.update(payments).set({ status: "paid", paidAt: SEPTEMBER }).where(eq(payments.id, p.id));
    await db.update(invoices).set({ paymentId: p.id }).where(eq(invoices.id, a.invoice.id));
    expect(await render(InvoicesPage)).not.toContain("data-uninvoiced-payment");
  });
});

describe("the registration drawer's „Arved“", () => {
  beforeEach(seed);
  const drawer = async (id: number) => {
    const html = await render(RegistrationsPage, { id: String(id) });
    const from = html.indexOf("data-registration-invoices");
    expect(from, "the block is there").toBeGreaterThan(-1);
    return { html, block: html.slice(from, html.indexOf("</section>", from)) };
  };

  test("the registration's invoices with their numbers, states and actions, between the money and the forms", async () => {
    await ready();
    const a = await request("kati@example.com", "Kati Tamm", OCTOBER);
    const { html, block } = await drawer(a.registration.id);
    expect(block).toContain(">Arved</h3>");
    expect(numbers(block)).toEqual(["MSL2026-001"]);
    expect(block).toContain(">Tasumata<");
    expect(block).toContain(">Märgi tasutuks<");
    expect(block).toContain(`href="/api/admin/arve/${a.invoice.id}"`);
    expect(html.indexOf("data-registration-invoices")).toBeGreaterThan(html.indexOf("data-paid=")); // after the money block
    expect(html.indexOf("data-registration-invoices")).toBeLessThan(html.indexOf("data-status-form")); // before the forms
  });

  test("with the 50% invoiced the rest is what is left to offer; „Koosta arve“ is there while an amount is open", async () => {
    await ready();
    const a = await request("kati@example.com", "Kati Tamm", OCTOBER);
    const { block } = await drawer(a.registration.id);
    expect(block).toContain('data-invoice-create=""');
    expect(block).not.toContain("data-invoice-all-covered");
  });

  test("everything invoiced: the line says so and there is no „Koosta arve“; a whole-sum invoice covers a half-choice registration", async () => {
    await ready();
    const a = await request("kati@example.com", "Kati Tamm", OCTOBER, "full");
    const { block } = await drawer(a.registration.id);
    expect(block).toContain("Kõik summad on juba arvega kaetud.");
    expect(block).not.toContain('data-invoice-create=""');
  });

  test("a registration with no invoice and no seller: a link to Seaded → Arve andmed in place of „Koosta arve“", async () => {
    const r = await registrationOn(db, fixture);
    const { block } = await drawer(r.id);
    expect(block).toContain("Sellele registreeringule pole arveid koostatud.");
    expect(block).not.toContain('data-invoice-create=""');
    expect(block).toMatch(/<a[^>]*href="\/admin\/seaded#arve"[^>]*>Täida Seaded → Arve andmed<\/a>/);
  });

  test("with a seller and nothing invoiced yet, „Koosta arve“", async () => {
    await ready();
    const r = await registrationOn(db, fixture);
    const { block } = await drawer(r.id);
    expect(block).toContain('data-invoice-create=""');
    expect(block).toContain(">Koosta arve<");
  });

  test("I1: a paid online payment of the registration with no invoice yet is on the block with its own „Koosta arve“ (the catch-up); the money is covered, so „Koosta arve“ stays for the rest", async () => {
    const r = await registrationOn(db, fixture);
    const p = await pendingPayment(db, r, {}, SEPTEMBER);
    await db.update(payments).set({ status: "paid", paidAt: SEPTEMBER }).where(eq(payments.id, p.id));
    await db.update(registrations).set({ paidCents: 17500, status: "confirmed" }).where(eq(registrations.id, r.id));
    // no seller yet: the payment is listed, without its button
    let { block } = await drawer(r.id);
    expect(block).toContain(`data-uninvoiced-payment="${p.id}"`);
    expect(block).toContain(`Veebimakse 175,00${NBSP}€ (15.09.2026) on veel arveta.`);
    expect(block).not.toContain("data-uninvoiced-create");
    await ready();
    ({ block } = await drawer(r.id));
    expect(block).toContain(`data-uninvoiced-create="${p.id}"`);
    expect(block).toContain("Koostab uue arve");
    expect(block).toContain('data-invoice-create=""'); // the rest is still open
    // its catch-up made, the row leaves the block and its invoice is in the list
    await catchUpInvoice(db, p.id, OCTOBER);
    ({ block } = await drawer(r.id));
    expect(block).not.toContain("data-uninvoiced-payment");
    expect(numbers(block)).toEqual(["MSL2026-001"]);
  });

  test("m2 and I3 through the real reads: an invoice paid online that waits for its catch-up says so (no „Märgi tasutuks“); a refunded one reads „Tagastatud“ in the drawer and on the list", async () => {
    await ready();
    const a = await request("kati@example.com", "Kati Tamm", OCTOBER);
    const p = await pendingPayment(db, a.registration, {}, OCTOBER);
    await db.update(payments).set({ status: "paid", paidAt: OCTOBER, invoiceId: a.invoice.id }).where(eq(payments.id, p.id));
    const { block } = await drawer(a.registration.id);
    expect(block).toContain("Veebis tasutud — ootab „Arveta maksed“ alt arvet.");
    expect(block).not.toContain(">Märgi tasutuks<");
    expect(block).toContain("Tasub arve MSL2026-001"); // (its payment on the block, whose catch-up pays it)
    await catchUpInvoice(db, p.id, OCTOBER);
    await db.update(payments).set({ status: "refunded" }).where(eq(payments.id, p.id));
    expect((await drawer(a.registration.id)).block).toContain(">Tagastatud<");
    const list = await render(InvoicesPage);
    expect(list).toContain(">Tagastatud<");
    expect(numbers(await render(InvoicesPage, { staatus: "paid" }))).toEqual(["MSL2026-001"]); // (the stored state is paid)
  });

  test("the text of the page's own dictionary is the one shown", () => {
    expect(adminEt.invoices.fromPayments).toBe("Arved");
  });
});

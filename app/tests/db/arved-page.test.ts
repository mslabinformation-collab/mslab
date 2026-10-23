import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { invoices, payments, registrations } from "@/db/schema";
import { adminEt } from "@/i18n/dict/admin";
import { addManualPayment } from "@/server/registration-money";
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
// (the list's toolbar is a client component that reads the router and the address, which a page rendered to HTML here has not got)
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/admin/registreerimised",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/admin/Drawer", async () => {
  const { createElement } = await import("react");
  return { Drawer: ({ children }: { children: React.ReactNode }) => createElement("div", { "data-drawer-stand-in": "" }, children), useUnsavedInDrawer: () => {} };
});
vi.mock("@/server/actions/admin", () => ({ cancelRegistration: vi.fn(), addManualPaymentAction: vi.fn(), saveRegistrationStatus: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => ({
  createInvoiceAction: vi.fn(), sendInvoiceAction: vi.fn(), markInvoicePaidAction: vi.fn(), undoInvoicePaidAction: vi.fn(), cancelInvoiceAction: vi.fn(),
  updateInvoiceBuyerAction: vi.fn(), catchUpInvoiceAction: vi.fn(), createInvoicesForUnbilledAction: vi.fn(), saveInvoiceSettingsAction: vi.fn(),
}));
const rows = vi.hoisted(() => ({ seen: [] as { number: string; takeBack: { cents: number; backToAwaiting: boolean } | null }[] }));
// (the row is the real one; what the page hands it is written down on the way)
vi.mock("@/components/admin/InvoiceRow", async (original) => {
  const real = await original<typeof import("@/components/admin/InvoiceRow")>();
  return {
    ...real,
    InvoiceRow: (props: Parameters<typeof real.InvoiceRow>[0]) => {
      rows.seen.push({ number: props.invoice.number, takeBack: props.invoice.takeBack });
      return real.InvoiceRow(props);
    },
  };
});
vi.mock("@/server/actions/admin-contracts", () => ({ saveContractTextsAction: vi.fn(), requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));

import InvoicesPage from "@/app/admin/(panel)/arved/page";
import PaymentsPage from "@/app/admin/(panel)/maksed/page";
import RegistrationsPage from "@/app/admin/(panel)/registreerimised/page";

const NBSP = " ";
/** Today, for the page: the list shows this month when none is chosen, so the tests fix the clock (the dates of the rows are October and September 2026). */
const TODAY = new Date("2026-10-23T09:00:00Z");
const SELLER = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu" };
const CARD = { ...SELLER, vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" };
const BANK = { receiver: "MS LAB Koolituskeskus OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
const SEPTEMBER = new Date("2026-09-15T09:00:00Z");
const OCTOBER = new Date("2026-10-16T09:00:00Z");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
});
afterAll(() => {
  vi.useRealTimers();
});

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

  test("without a month the list shows this month (the CSV always has a month to name): the invoices of October, newest first, with the buyer, the course and a link to the registration; the tabs Maksed | Arved", async () => {
    const html = await render(InvoicesPage);
    expect(numbers(html)).toEqual(["MSL2026-003", "MSL2026-002"]);
    expect(html).toContain("<h1");
    // the heading both tabs share (A6), and the tabs: Maksed is a link back, Arved is the current one
    expect(html).toContain(">Maksed ja arved</h1>");
    expect(html).toContain("Montonio ja raamatupidamine");
    const tabs = /<nav[^>]*aria-label="Maksed ja arved"[^>]*data-tab-pills[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1];
    expect([...tabs.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[2], m[1], /aria-current="page"/.test(m[0])])).toEqual([
      ["Maksed", "/admin/maksed", false],
      ["Arved", "/admin/arved", true],
    ]);
    expect(html).toContain("Arveid: 2");
    const liisRow = html.slice(html.indexOf('data-invoice="MSL2026-003"'), html.indexOf('data-invoice="MSL2026-002"'));
    expect(liisRow).toContain("Liis Mets");
    expect(liisRow).toContain("Kulmumeistri baaskoolitus");
    expect(liisRow).toContain(`href="/admin/registreerimised?id=${liis.registration.id}"`);
    expect(liisRow).toContain(`175,00${NBSP}€`);
    expect(liisRow).toContain(">Tasumata<");
    // the prototype's meta line: the part, and „maksta kuni“ in short form
    expect(liisRow).toMatch(/data-invoice-facts="">Ettemaks 50% · maksta kuni 23\.10</);
    expect(html).toContain(">Tasutud<");
    // (September's, cancelled, is another month)
    expect(html).not.toContain("MSL2026-001");
  });

  test("„Kõik kuud“ (?kuu=koik) lists every invoice, September's cancelled one too; a month that is no month is no choice: it is this month", async () => {
    const all = await render(InvoicesPage, { kuu: "koik" });
    expect(numbers(all)).toEqual(["MSL2026-003", "MSL2026-002", "MSL2026-001"]);
    expect(all).toContain("Arveid: 3");
    expect(all).toContain(">Tühistatud<");
    for (const kuu of ["oktoober", "2026-13", "2026-1", "all", ""]) expect(numbers(await render(InvoicesPage, { kuu })), kuu).toEqual(["MSL2026-003", "MSL2026-002"]);
  });

  test("the month select is the toolbar's scope: „Kõik kuud“ and each month that has invoices (and this month), newest first, applying on change — no „Näita“", async () => {
    const html = await render(InvoicesPage);
    const select = /<select[^>]*aria-label="Kuu"[^>]*>([\s\S]*?)<\/select>/.exec(html);
    expect(select, "the select named Kuu").not.toBeNull();
    const options = [...select![1].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([["koik", "Kõik kuud"], ["2026-10", "Oktoober 2026"], ["2026-09", "September 2026"]]);
    expect(select![0]).toMatch(/<option value="2026-10" selected/);
    expect(html).not.toContain(">Näita<");
    expect(html).not.toContain('type="month"');
    expect(html).not.toContain("data-invoice-month-form");
    // a month with no invoice that is asked for is there to show what the list is
    const empty = await render(InvoicesPage, { kuu: "2026-08" });
    expect(empty).toMatch(/<option value="2026-08" selected[^>]*>August 2026</);
    expect(await render(InvoicesPage, { kuu: "koik" })).toMatch(/<option value="koik" selected[^>]*>Kõik kuud</);
  });

  test("the pills carry counts under the month and the search, and links that keep them; a value the pills do not know shows everything", async () => {
    const pills = (html: string) => {
      const nav = /<nav[^>]*aria-label="Staatus"[^>]*data-list-pill-row[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1];
      return [...nav.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<span[^>]*>(\d+)<\/span><\/a>/g)].map((m) => [m[2], Number(m[3]), m[1].replace(/&amp;/g, "&")]);
    };
    expect(pills(await render(InvoicesPage))).toEqual([
      ["Kõik", 2, "/admin/arved"],
      ["Tasumata", 1, "/admin/arved?staatus=unpaid"],
      ["Tasutud", 1, "/admin/arved?staatus=paid"],
      ["Tühistatud", 0, "/admin/arved?staatus=cancelled"],
    ]);
    expect(pills(await render(InvoicesPage, { kuu: "koik", staatus: "paid", otsi: "kask" }))).toEqual([
      ["Kõik", 1, "/admin/arved?otsi=kask&kuu=koik"],
      ["Tasumata", 0, "/admin/arved?otsi=kask&kuu=koik&staatus=unpaid"],
      ["Tasutud", 1, "/admin/arved?otsi=kask&kuu=koik&staatus=paid"],
      ["Tühistatud", 0, "/admin/arved?otsi=kask&kuu=koik&staatus=cancelled"],
    ]);
    const html = await render(InvoicesPage, { staatus: "paid" });
    expect(/<a [^>]*href="\/admin\/arved\?staatus=paid"[^>]*>/.exec(html)![0]).toContain('aria-current="true"');
    expect(numbers(await render(InvoicesPage, { staatus: "makstud", kuu: "koik" }))).toHaveLength(3);
    // a pill's count is the rows it then shows
    expect(numbers(await render(InvoicesPage, { staatus: "paid", kuu: "koik" }))).toEqual(["MSL2026-002"]);
    expect(numbers(await render(InvoicesPage, { staatus: "unpaid", kuu: "koik" }))).toEqual(["MSL2026-003"]);
    expect(numbers(await render(InvoicesPage, { staatus: "cancelled", kuu: "koik" }))).toEqual(["MSL2026-001"]);
  });

  test("the month filter: ?kuu=YYYY-MM is the month of the issue in Tallinn; combined with the state and the search", async () => {
    expect(numbers(await render(InvoicesPage, { kuu: "2026-09" }))).toEqual(["MSL2026-001"]);
    expect(numbers(await render(InvoicesPage, { kuu: "2026-10" }))).toEqual(["MSL2026-003", "MSL2026-002"]);
    expect(numbers(await render(InvoicesPage, { kuu: "2026-10", staatus: "paid" }))).toEqual(["MSL2026-002"]);
    expect(numbers(await render(InvoicesPage, { kuu: "2026-08" }))).toEqual([]);
    expect(await render(InvoicesPage, { kuu: "2026-08" })).toContain("Selle valikuga arveid pole.");
    expect(numbers(await render(InvoicesPage, { kuu: "2026-10", otsi: "liis" }))).toEqual(["MSL2026-003"]);
    expect(numbers(await render(InvoicesPage, { kuu: "2026-09", otsi: "liis" }))).toEqual([]);
  });

  test("the search (B7): the invoice's number, the buyer's name or e-mail; it keeps the month; nothing found says so and offers to clear", async () => {
    expect(numbers(await render(InvoicesPage, { kuu: "koik", otsi: "MSL2026-001" }))).toEqual(["MSL2026-001"]);
    expect(numbers(await render(InvoicesPage, { kuu: "koik", otsi: "msl2026-00" }))).toEqual(["MSL2026-003", "MSL2026-002", "MSL2026-001"]);
    expect(numbers(await render(InvoicesPage, { otsi: "002" }))).toEqual(["MSL2026-002"]);
    expect(numbers(await render(InvoicesPage, { otsi: "MARI KASK" }))).toEqual(["MSL2026-002"]);
    expect(numbers(await render(InvoicesPage, { otsi: "liis@example" }))).toEqual(["MSL2026-003"]);
    expect(numbers(await render(InvoicesPage, { otsi: "%" }))).toEqual([]);
    const none = await render(InvoicesPage, { otsi: "nobody" });
    expect(none).toContain("„nobody“ järgi arveid ei leitud.");
    expect(none).toMatch(/<a[^>]*href="\/admin\/arved"[^>]*>Tühjenda otsing ja filtrid<\/a>/);
    expect(none).toContain('placeholder="Otsi nime, e-posti või arve numbri järgi"');
  });

  test("„Laadi alla (CSV) · {kuu aasta}“ is the file of the month on the screen, and says which; while „Kõik kuud“ is chosen it is this month's", async () => {
    const sept = await render(InvoicesPage, { kuu: "2026-09" });
    expect(sept).toContain('href="/api/admin/arved?kuu=2026-09"');
    expect(sept).toContain("Laadi alla (CSV) · september 2026");
    const now = await render(InvoicesPage);
    expect(now).toContain('href="/api/admin/arved?kuu=2026-10"');
    expect(now).toContain("Laadi alla (CSV) · oktoober 2026");
    const all = await render(InvoicesPage, { kuu: "koik" });
    expect(all).toContain('href="/api/admin/arved?kuu=2026-10"');
    expect(all).toContain("Laadi alla (CSV) · oktoober 2026");
    // (the old hint under the button, which named the month in numbers, is gone with the label naming it)
    expect(now).not.toContain("Raamatupidajale");
  });

  test("Maksed links to it", async () => {
    const html = await render(PaymentsPage);
    expect(html).toMatch(/<a[^>]*href="\/admin\/arved"[^>]*>Arved<\/a>/);
  });
});

describe("the „Arved“ page: „Võta tasumine tagasi“ of a receipt says what the drawer's says (S3-f)", () => {
  test("the list reads the receipt's registration: the sum the server will take back and the line „läheb tagasi“ when the place then falls under 50 %", async () => {
    await seed();
    await ready();
    const r = await registrationOn(db, fixture, { email: "kati@example.com", name: "Kati Tamm" });
    const added = await addManualPayment(db, { registrationId: r.id, cents: 17500, paidOn: "2026-10-16", method: "cash", receipt: true, expectedPaidCents: 0 }, OCTOBER);
    expect(added).toMatchObject({ ok: true, receiptNumber: "MSL2026-001" });
    rows.seen.length = 0;
    const html = await render(InvoicesPage);
    expect(numbers(html)).toEqual(["MSL2026-001"]);
    // (the panel is drawn when it is asked for; the page hands the row what it says: 175 € off, and the place goes back, the receipt being all the registration has paid)
    expect(rows.seen).toEqual([{ number: "MSL2026-001", takeBack: { cents: 17500, backToAwaiting: true } }]);
    expect(html).toContain('aria-label="Veel: MSL2026-001"');
    expect(html).toMatch(/data-invoice-facts="">Ettemaks 50% · tasutud 16\.10 · sularaha</);
    // an invoice that is no receipt is handed none
    const other = await request("mari@example.com", "Mari Kask", OCTOBER);
    rows.seen.length = 0;
    await render(InvoicesPage);
    expect(rows.seen.find((x) => x.number === other.invoice.number)).toEqual({ number: other.invoice.number, takeBack: null });
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
    // every month: the 51 invoices
    const first = await render(InvoicesPage, { kuu: "koik" });
    expect(numbers(first)).toHaveLength(50);
    expect(numbers(first)[0]).toBe("MSL2026-051");
    expect(first).toContain("Arveid: 51");
    expect(first).toContain("data-pager");
    expect(first).toContain('href="/admin/arved?kuu=koik&amp;leht=2"');
    const second = await render(InvoicesPage, { kuu: "koik", leht: "2" });
    expect(numbers(second)).toEqual(["MSL2026-001"]);
    expect(numbers(await render(InvoicesPage, { kuu: "koik", leht: "9" }))).toEqual(["MSL2026-001"]);
    // this month: the 50 of October, one page
    const october = await render(InvoicesPage);
    expect(numbers(october)).toHaveLength(50);
    expect(october).toContain("Arveid: 50");
    expect(october).not.toContain("data-pager");
    expect(await render(InvoicesPage, { kuu: "2026-10", leht: "2", otsi: "msl" })).not.toContain('href="/admin/arved?kuu=2026-10&amp;leht=2"');
    expect(await render(InvoicesPage, { kuu: "koik", leht: "2", otsi: "msl" })).toContain('href="/admin/arved?otsi=msl&amp;kuu=koik"');
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
  /** The strip's own markup, from its section to the end of it. */
  const strip = (html: string) => {
    const from = html.indexOf('data-uninvoiced=""');
    return from === -1 ? "" : html.slice(html.lastIndexOf("<section", from), html.indexOf("</section>", from));
  };

  test("nothing paid without an invoice: no strip, no heading", async () => {
    await ready();
    const html = await render(InvoicesPage);
    expect(html).not.toContain("data-uninvoiced");
    expect(html).not.toContain("Arveta maksed");
  });

  test("the strip (README A6): the anchor #arveta, „Arveta maksed: {n}“, the summary (what they are, the total, the payers), „Näita ▸“ and „Koosta {n} arvet“; the list is in it, folded away", async () => {
    await ready();
    await paid("mari@example.com", "Mari Kask", OCTOBER);
    await paid("kati@example.com", "Kati Tamm", SEPTEMBER);
    const html = await render(InvoicesPage);
    const s = strip(html);
    expect(s).toContain('id="arveta"');
    expect(s).toMatch(/<h2[^>]*>Arveta maksed: 2<\/h2>/);
    expect(s).toContain(`Tasutud, aga arve puudub · 350,00${NBSP}€ · Kati Tamm, Mari Kask`);
    expect(s).toMatch(/aria-expanded="false"[^>]*>Näita ▸</);
    expect(s).toMatch(/data-uninvoiced-bulk=""[^>]*>Koosta 2 arvet</);
    expect(s).toMatch(/<div[^>]*id="[^"]*"[^>]*hidden=""[^>]*data-uninvoiced-list=""|<div[^>]*hidden=""[^>]*data-uninvoiced-list=""/);
    // the old always-open block, with its explanation that the invoices are made one by one, is gone
    expect(html).not.toContain("ükshaaval");
    expect(html).not.toContain("uninvoiced-title");
    // one payment: the n = 1 forms (S3-l)
    await db.update(payments).set({ status: "failed" }).where(eq(payments.name, "Mari Kask"));
    const one = strip(await render(InvoicesPage));
    expect(one).toMatch(/<h2[^>]*>Arveta maksed: 1<\/h2>/);
    expect(one).toMatch(/data-uninvoiced-bulk=""[^>]*>Koosta 1 arve</);
  });

  test("a paid payment with no invoice is listed oldest first, with its course, the day it was paid and its own „Koosta arve“", async () => {
    await ready();
    await paid("mari@example.com", "Mari Kask", OCTOBER);
    await paid("kati@example.com", "Kati Tamm", SEPTEMBER);
    const html = await render(InvoicesPage);
    expect(html).toContain("data-uninvoiced");
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

  test("without a seller the rows are listed but cannot be made: the link to Seaded → Arve andmed stands in place of the button, and the rows have none", async () => {
    await paid("mari@example.com", "Mari Kask", OCTOBER);
    const html = await render(InvoicesPage);
    expect(html).toContain("data-uninvoiced-payment");
    expect(html).not.toContain("data-uninvoiced-create");
    expect(html).not.toContain("data-uninvoiced-bulk");
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

  test("the registration's invoices with their numbers, states and actions, after the money and „Staatus ja märkus“ (README A2 drawer order)", async () => {
    await ready();
    const a = await request("kati@example.com", "Kati Tamm", OCTOBER);
    const { html, block } = await drawer(a.registration.id);
    expect(block).toContain(">Arved</h3>");
    expect(numbers(block)).toEqual(["MSL2026-001"]);
    expect(block).toContain(">Tasumata<");
    // (README A2 drawer 4: „Saada õpilasele“ and „Laadi alla (PDF)“ in view; the rest is under „Veel ▾“, whose items are drawn when it is opened)
    expect(block).toContain(">Saada õpilasele<");
    expect(block).toContain('aria-label="Veel: MSL2026-001"');
    expect(block).not.toContain(">Märgi tasutuks<");
    expect(block).toContain(`href="/api/admin/arve/${a.invoice.id}"`);
    // the drawer's order (README A2 drawer 1–6): the header, Raha, „Staatus ja märkus“, Arved, the folded rows Leping, Tagasiside and Registreerimise andmed,
    // then „Tühista registreerimine“
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = ["data-registration-line", "data-money-card", "data-status-form", "data-registration-invoices", ">Leping<", ">Tagasiside<", ">Registreerimise andmed<", ">Tühista registreerimine<"];
    expect(order.map(at), "the drawer's order").toEqual(order.map(at).sort((x, y) => x - y));
    // (the folded rows are folds: closed, each with its one-line summary)
    expect(html.match(/<details[^>]*data-fold=""[^>]*>/g)).toHaveLength(3);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain("1 tasumata"); // (the block's folded row on a phone, P-3)
    expect(html).toContain("11 rida");
    expect(html).toContain("pole antud");
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
    expect(block).not.toContain('data-invoice-create=""'); // only one „Koosta arve“ (README A2 drawer 4): the payment's own, while it waits
    // its catch-up made, the row leaves the block, its invoice is in the list, and the generic „Koosta arve“ is back for the rest that is still open
    await catchUpInvoice(db, p.id, OCTOBER);
    ({ block } = await drawer(r.id));
    expect(block).not.toContain("data-uninvoiced-payment");
    expect(block).toContain('data-invoice-create=""');
    expect(numbers(block)).toEqual(["MSL2026-001"]);
  });

  test("m2 and I3 through the real reads: an invoice paid online that waits for its catch-up says so (no „Märgi tasutuks“); a refunded one reads „Tagastatud“ in the drawer and on the list", async () => {
    await ready();
    const a = await request("kati@example.com", "Kati Tamm", OCTOBER);
    const p = await pendingPayment(db, a.registration, {}, OCTOBER);
    await db.update(payments).set({ status: "paid", paidAt: OCTOBER, invoiceId: a.invoice.id }).where(eq(payments.id, p.id));
    const { block } = await drawer(a.registration.id);
    expect(block).toContain("Veebis tasutud — ootab „Arveta maksed“ alt arvet.");
    expect(block).not.toContain("data-invoice-send"); // (no „Saada õpilasele“ for a request for money already in)
    expect(block).toContain("Tasub arve MSL2026-001"); // (its payment on the block, whose catch-up pays it)
    await catchUpInvoice(db, p.id, OCTOBER);
    await db.update(payments).set({ status: "refunded" }).where(eq(payments.id, p.id));
    const refunded = (await drawer(a.registration.id)).block;
    expect(refunded).toContain(">Tagastatud<");
    expect(refunded).not.toContain("data-invoice-send"); // (README A2 drawer 4: not sent again)
    const list = await render(InvoicesPage);
    expect(list).toContain(">Tagastatud<");
    expect(numbers(await render(InvoicesPage, { staatus: "paid" }))).toEqual(["MSL2026-001"]); // (the stored state is paid)
  });

  test("the text of the page's own dictionary is the one shown", () => {
    expect(adminEt.payments.tabs.invoices).toBe("Arved");
  });
});

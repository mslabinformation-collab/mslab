import type { Locator, Page } from "@playwright/test";
import { holdLocalLock, LOCK_WAIT_MS, onLocalDb, snapshotRows } from "./fixtures";
import { expect } from "./test";

// What the invoice specs share (invoices Tasks 5 and 7): the seller card and the bank details a test writes into the shared settings, the
// registration drawer's „Arved" block and the checks of a screen's width. admin-invoices.spec.ts (Maria's screens one by one), invoices.spec.ts
// (the whole path, Maria → the student → Maria) and invoices-race.spec.ts (real Postgres) use them.

/** The seller of every test invoice: `seller->>'company'` finds the invoices of a test that died before its clean-up. */
export const INVOICE_COMPANY = "E2E Arvete OÜ";
/** The numbers the tests' seller card gives (prefix E2E: the tests' own series, never MSL; three digits or more: the account specs write high ones). */
export const INVOICE_NUMBER = /^E2E\d{4}-\d{3,}$/;
/** The bank details of Ettemaksu juhised a test writes. */
export const INVOICE_BANK = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
/** The widths the specs look at: a phone, a tablet, an iPad and a desktop. */
export const WIDTHS = [390, 834, 1194, 1440] as const;

/** The lock every test that writes the shared prepayment or invoice setting holds (the dashboard tests hold the same one for the prepayment). */
const SETTINGS_LOCK = "e2e-prepayment-setting";

/** Today on Tallinn's calendar, "YYYY-MM-DD" (the server reads the month and the year there). */
export const today = (): string => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Tallinn" }).format(new Date());

/** The seller card a test writes: prefix E2E, so the numbers are the test's own; this Tallinn year, number 1. */
export const invoiceCard = (extra: Record<string, unknown> = {}) => ({
  company: INVOICE_COMPANY,
  registryCode: "12345678",
  address: "Testi 1, Pärnu",
  vatNumber: "",
  vatOn: false,
  vatRate: 24,
  prefix: "E2E",
  nextYear: Number(today().slice(0, 4)),
  nextSeq: 1,
  termDays: 7,
  footer: "",
  ...extra,
});

/**
 * Takes the shared settings for a test: the lock, the stored `invoice` and `prepayment` rows saved for putting back, then Ettemaksu juhised
 * (INVOICE_BANK) and Arve andmed (`seller`; null: no card, as on a site where Maria has not filled it in yet) written. The timeout is
 * lengthened by the wait for the lock. Returns the function that puts the rows back and lets the lock go: call it after the test, also when it failed.
 */
export async function holdInvoiceSettings(
  info: { setTimeout(ms: number): void; timeout: number },
  seller: Record<string, unknown> | null = invoiceCard(),
): Promise<() => Promise<void>> {
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  const unlock = await holdLocalLock(SETTINGS_LOCK);
  const restores: (() => Promise<void>)[] = [];
  const giveBack = async () => {
    try {
      for (const restore of restores.splice(0)) await restore();
    } finally {
      await unlock();
    }
  };
  try {
    restores.push(await snapshotRows("settings", { column: "key", value: "invoice" }));
    restores.push(await snapshotRows("settings", { column: "key", value: "prepayment" }));
    await onLocalDb(async (sql) => {
      await sql`delete from settings where key in ('invoice', 'prepayment')`;
      await sql`insert into settings (key, value) values ('prepayment', ${sql.json(INVOICE_BANK)})`;
      if (seller) await sql`insert into settings (key, value) values ('invoice', ${sql.json(seller as never)})`;
    });
  } catch (e) {
    await giveBack();
    throw e;
  }
  return giveBack;
}

/** Whether the page is no wider than its window (no sideways scrolling). */
export const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** Opens a registration's drawer; returns its dialog and its „Arved“ block. */
export async function openDrawer(page: Page, f: { registration: { id: number; name: string } }): Promise<{ drawer: Locator; block: Locator }> {
  await page.goto(`/admin/registreerimised?id=${f.registration.id}`);
  const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
  await expect(drawer).toBeVisible();
  const block = drawer.locator("[data-registration-invoices]");
  await expect(block).toBeVisible();
  return { drawer, block };
}

/** The amounts „Koosta arve“ offers, as their kinds. */
export const offered = (block: Locator) => block.locator("[data-invoice-kind]").evaluateAll((els) => els.map((e) => e.getAttribute("data-invoice-kind")));
/** A block's invoice rows in one state (`unpaid`, `paid` or `cancelled`). */
export const rowOf = (block: Locator, status: string) => block.locator(`[data-invoice-status="${status}"]`);

/**
 * A screen at the width it has now: the page does not scroll sideways, `surface` does not either, and every visible button, link and field in
 * `surface` is at least 44 px tall (a finger's size; the 0.5 is the rounding of a fractional layout). A radio button or a checkbox is as tall as
 * the label around it: that is what a finger meets. `what` names the screen in the failure.
 */
export async function expectFits(page: Page, surface: Locator, what: string): Promise<void> {
  const width = page.viewportSize()?.width;
  expect(await noOverflow(page), `${what} at ${width}: the page scrolls sideways`).toBe(true);
  expect(await surface.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${what} at ${width}: it scrolls sideways inside`).toBe(true);
  const small = await surface.locator("button, a[href], input:not([type=hidden]), select, textarea, summary").evaluateAll((els) =>
    els
      .map((el) => ({ el, box: (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox") ? el.closest("label") : null)?.getBoundingClientRect() ?? el.getBoundingClientRect(), style: getComputedStyle(el) }))
      .filter(({ box, style }) => box.width > 0 && box.height > 0 && style.visibility !== "hidden")
      .filter(({ box }) => box.height < 43.5)
      .map(({ el, box }) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30) || el.getAttribute("aria-label") || el.getAttribute("name") || ""}" ${Math.round(box.height)} px`),
  );
  expect(small, `${what} at ${width}: controls under 44 px`).toEqual([]);
}

import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { formatDate } from "../../src/i18n/format";
import { clientEmail, insertAccountFixtures, signInAsClient, type AccountCardKind } from "./account";
import { onLocalDb, removeClientRows, storedPayments } from "./fixtures";
import { E2E_MONTONIO } from "./montonio-values";
import { submitsForms, test, expect } from "./test";

// Invoices, the student's side (invoices Task 6, spec §4) in a browser: the lines on a course card — „Arve … · … · Tasutud“ or „… · Tasumata · tasu
// {kuupäev}“ — with „Laadi alla (PDF)“ (a download named by the number, the bytes a PDF, never another student's), the bank details of an unpaid
// invoice, „Maksa“ charging the invoice's own sum and paying THAT invoice (the fake Montonio, no second invoice), and the card in Russian. The
// clients are sample addresses (`e2e-client-…@example.test`, never mailed) with registrations and invoices written straight to the local database
// (tests/e2e/account.ts insertAccountFixtures; removeClientRows deletes the invoices of the address too: they have no cascade). The invoices carry
// their own bank details, so no shared setting is touched.

const made = new Set<string>();
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
});

const card = (page: Page, key: string) => page.locator(`[data-card="${key}"]`);
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const YEAR = new Date().getFullYear();
const SELLER = { company: "E2E OÜ", registryCode: "12345678", address: "Testi 1, Pärnu", vatNumber: "", receiver: "E2E Saaja OÜ", iban: "EE382200221020145685", bank: "Swedbank" };

type Inserted = { id: number; number: string; dueAt: Date };

/** An invoice of a registration, written straight to the local database: `paid` (born paid, Montonio) or a request to pay due in a week. */
async function insertInvoice(email: string, registrationId: number, o: { seq: number; paid: boolean; kind: "prepayment" | "full" | "balance"; cents: number }): Promise<Inserted> {
  const number = `E2E${YEAR}-${String(o.seq).padStart(3, "0")}`;
  const dueAt = new Date(Date.now() + 7 * 86_400_000);
  const line = { course: "Kulmude lamineerimine", session: "", part: o.kind === "balance" ? "Jääk 50%" : o.kind === "full" ? "Kogu summa (100%)" : "Ettemaks 50%" };
  const buyer = { name: "E2E Õpilane", email, address: "", company: "", companyCode: "", companyAddress: "" };
  const [row] = await onLocalDb(
    (sql) => sql<{ id: number }[]>`
      insert into invoices (number, prefix, year, seq, kind, registration_id, status, amount_cents, line, seller, buyer, reference, issued_at, due_at, paid_at, paid_method)
      values (${number}, 'E2E', ${YEAR}, ${o.seq}, ${o.kind}, ${registrationId}, ${o.paid ? "paid" : "unpaid"}, ${o.cents}, ${sql.json(line)}, ${sql.json(SELLER)}, ${sql.json(buyer)},
              ${o.paid ? "" : `E2E-${registrationId}`}, now(), ${o.paid ? null : dueAt}, ${o.paid ? new Date() : null}, ${o.paid ? "montonio" : null})
      returning id`,
    { marksPages: false },
  );
  return { id: row.id, number, dueAt };
}

/** The invoices of a test address as stored: number, status, the payment that paid it. */
const storedInvoices = (email: string) =>
  onLocalDb(
    (sql) => sql<{ number: string; status: string; method: string | null; paid: boolean }[]>`
      select number, status, paid_method as method, payment_id is not null as paid from invoices where buyer->>'email' = ${email} order by id`,
    { marksPages: false },
  );
/** The invoice each online payment of a test address was started for (payments.invoice_id), by the invoice's number. */
const paymentInvoices = (email: string) =>
  onLocalDb(
    (sql) => sql<{ number: string | null }[]>`select i.number from payments p left join invoices i on i.id = p.invoice_id where p.email = ${email} order by p.id`,
    { marksPages: false },
  );

/** A fresh client with these cards, signed in on `page` (/konto open, the dashboard loaded). */
async function signedInWith(page: Page, label: string, project: string, cards: AccountCardKind[]) {
  const email = clientEmail(label, project);
  made.add(email);
  await removeClientRows(email);
  const f = await insertAccountFixtures(email, { name: "Kati Tamm", cards });
  return { email, f, signIn: async () => { await signInAsClient(page, email); await expect(page.locator("[data-account-dashboard]")).toBeVisible(); } };
}

const lines = (c: Locator) => c.locator("[data-invoice-line]");

test("a card shows its invoices: the paid one downloads as a PDF named by its number, the unpaid one has its bank details and a „Maksa“ for its own sum; no sideways scrolling, 44 px targets", async ({ page }, info) => {
  const { email, f, signIn } = await signedInWith(page, "inv", info.project.name, ["awaiting", "confirmed"]);
  const seq = f.registrations.awaiting! * 10;
  const unpaid = await insertInvoice(email, f.registrations.awaiting!, { seq: seq + 1, paid: false, kind: "full", cents: 35000 });
  const paid = await insertInvoice(email, f.registrations.confirmed!, { seq: seq + 2, paid: true, kind: "full", cents: 35000 });
  await signIn();

  const awaiting = card(page, `registration-${f.registrations.awaiting}`);
  const confirmed = card(page, `registration-${f.registrations.confirmed}`);
  // „Arve … · 350,00 € · Tasumata · tasu …“ with its due date; the bank details frozen on it; „Maksa“ charges the invoice's 350 €, not the card's 175 €
  await expect(lines(awaiting)).toHaveText(`Arve ${unpaid.number} · 350,00\u00a0€ · Tasumata · tasu ${formatDate(unpaid.dueAt, "et")}`);
  const rows = awaiting.locator("[data-invoice-transfer] [data-pay-row]");
  await expect(rows).toHaveText([/^Saaja\s*E2E Saaja OÜ$/, /^IBAN\s*EE38 2200 2210 2014 5685\s*Kopeeri\s*Kopeeritud ✓$/, /^Pank\s*Swedbank$/, /^Summa\s*350,00\s€$/, new RegExp(`^Selgitus\\s*E2E-${f.registrations.awaiting}\\s*Kopeeri\\s*Kopeeritud ✓$`)]);
  await expect(awaiting.locator("[data-invoice-transfer]")).not.toContainText("Maria su koha");
  await expect(awaiting.getByRole("button", { name: "Maksa 350 €" })).toBeVisible();
  await expect(awaiting.locator("[data-card-action]")).toHaveCount(1);
  // the paid one: „Tasutud“, no bank details
  await expect(lines(confirmed)).toHaveText(`Arve ${paid.number} · 350,00\u00a0€ · Tasutud`);
  await expect(confirmed.locator("[data-invoice-transfer]")).toHaveCount(0);

  // the download: a PDF named by the number
  const link = confirmed.getByRole("link", { name: "Laadi alla (PDF)" });
  await expect(link).toHaveAttribute("href", `/api/konto/arve/${paid.id}`);
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toBe(`MS-LAB-arve-${paid.number}.pdf`);
  expect(readFileSync((await download.path())!).subarray(0, 5).toString()).toBe("%PDF-");

  // an invoice that is not hers is a 404, whoever asks
  const other = await signedInWith(page, "inv-other", info.project.name, ["confirmed"]);
  const theirs = await insertInvoice(other.email, other.f.registrations.confirmed!, { seq: seq + 3, paid: true, kind: "full", cents: 35000 });
  const res = await page.request.get(`/api/konto/arve/${theirs.id}`);
  expect([res.status(), await res.json()]).toEqual([404, { ok: false }]);
  expect((await page.request.get(`/api/konto/arve/${paid.id}`)).headers()["cache-control"]).toBe("private, no-store");

  // the phone: nothing wider than the screen, the download a 44 px target
  expect(await noOverflow(page)).toBe(true);
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("the card in Russian: the lines, the download, the bank details and „Оплатить …“ for the invoice's own sum", async ({ page }, info) => {
  const { email, f, signIn } = await signedInWith(page, "inv-ru", info.project.name, ["awaiting"]);
  const unpaid = await insertInvoice(email, f.registrations.awaiting!, { seq: f.registrations.awaiting! * 10 + 1, paid: false, kind: "full", cents: 35000 });
  await signIn();
  await page.goto("/ru/konto");
  await expect(page.locator("[data-account-dashboard]")).toBeVisible();
  const c = card(page, `registration-${f.registrations.awaiting}`);
  await expect(lines(c)).toHaveText(`Счёт ${unpaid.number} · 350,00\u00a0€ · Не оплачен · оплатить до ${formatDate(unpaid.dueAt, "ru")}`);
  await expect(c.getByRole("link", { name: "Скачать (PDF)" })).toHaveAttribute("href", `/api/konto/arve/${unpaid.id}`);
  await expect(c.locator("[data-invoice-transfer] dt")).toHaveText(["Получатель", "IBAN", "Банк", "Сумма", "Назначение платежа"]);
  await expect(c.getByRole("button", { name: "Оплатить 350 €" })).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
});

test("„Maksa 350 €“ pays THAT invoice: the payment is started for it, and paid at the bank the invoice is „Tasutud“ (Montonio) — no second invoice, no bank details left", async ({ page }, info) => {
  submitsForms();
  const { email, f, signIn } = await signedInWith(page, "inv-pay", info.project.name, ["awaiting"]);
  const unpaid = await insertInvoice(email, f.registrations.awaiting!, { seq: f.registrations.awaiting! * 10 + 1, paid: false, kind: "full", cents: 35000 });
  await signIn();
  const c = card(page, `registration-${f.registrations.awaiting}`);
  await c.getByRole("button", { name: "Maksa 350 €" }).click();
  await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
  await page.getByRole("button", { name: "Makstud" }).click();
  await page.waitForURL(/\/makse#tulemus=makstud&liik=registreering/);
  await expect.poll(() => storedPayments(email)).toEqual([{ kind: "prepayment", status: "paid", amountCents: 35000 }]);
  expect(await paymentInvoices(email)).toEqual([{ number: unpaid.number }]);
  await expect.poll(() => storedInvoices(email)).toEqual([{ number: unpaid.number, status: "paid", method: "montonio", paid: true }]);
  await page.goto("/konto");
  await expect(lines(c)).toHaveText(`Arve ${unpaid.number} · 350,00\u00a0€ · Tasutud`);
  await expect(c.locator("[data-invoice-transfer]")).toHaveCount(0);
  await expect(c.getByRole("button", { name: /^Maksa/ })).toHaveCount(0);
});

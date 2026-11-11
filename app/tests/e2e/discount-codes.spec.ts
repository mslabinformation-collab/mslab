import type { Locator, Page, TestInfo } from "@playwright/test";
import { clientEmail, holdTerms } from "./account";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { onLocalDb, removeAdminRows, removeClientRows, storedPayments, storedRegistrations } from "./fixtures";
import { takeFinancing } from "./financing";
import { holdInvoiceSettings } from "./invoices";
import { E2E_MONTONIO } from "./montonio-values";
import { revalidateLocalPages } from "./prod-build";
import { LOCAL_URL, TARGET } from "./target";
import { submitsForms, test, expect } from "./test";

// Discount codes (F1 Task 16) end to end against the e2e run's fake Montonio (tests/e2e/fake-montonio.ts): the code field of the group registration form and
// of the e-course cart, what Montonio is asked for, what the invoice says, Maria's Sooduskoodid page, and the järelmaks (Inbank) range that follows the total.
// The races (two registrations at the same moment, Maria's save, pause and delete against a booking, her add against a settlement) are discount-race.spec.ts,
// on real Postgres in a scratch database. The rules themselves (every refusal, the person rules, the limit) are the db tests' (tests/db/discount-*.test.ts).
// Every code here is made by the test (`E2E-<label>-<project>`, so the desktop and phone projects, which run side by side, never meet) and deleted by its
// exact id or text, its uses first (a use has no cascade); the welcome row is never touched (only one may exist, and the welcome-code.ts turn is not needed
// here). Every payer is a sample address (`e2e-client-disc-…@example.test`, never mailed) whose rows are removed after each test (fixtures.ts removeClientRows),
// so the seat of the seed session the registrations take (Kulmumeistri baaskoolitus, Tallinn) is free again.

const APP = new URL(TARGET || LOCAL_URL);
const COURSE = "/koolitused/kulmumeistri-baaskoolitus";
const ECOURSE = "kulmumeistri-e-koolitus";
const made = new Set<string>();
/** The codes of the running test, by their text (the clean-up deletes exactly these, their uses first). */
const codes = new Set<string>();
const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
let touchedPublicCourse = false;

test.beforeEach(() => {
  submitsForms();
  test.setTimeout(150_000); // (the first view of each page under `next dev` compiles it)
});
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
  for (const text of codes) await removeCode(text);
  codes.clear();
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
  if (touchedPublicCourse) revalidateLocalPages(); // (a registration on the seed course was removed behind the app's back: its seat is free again)
  touchedPublicCourse = false;
});

/** A fresh payer address for this test (its leftovers removed first); one per project, and per repeat of a --repeat-each run, which run side by side. */
async function fresh(label: string, info: TestInfo): Promise<string> {
  const email = clientEmail(`disc-${label}`, `${info.project.name}${info.repeatEachIndex ? `-r${info.repeatEachIndex}` : ""}`);
  made.add(email);
  await removeClientRows(email);
  return email;
}

/** The text of this test's code: upper case, letters, digits and hyphens only (the code's shape), at most 30 characters, one per project and repeat. */
const codeText = (label: string, info: TestInfo): string => `E2E-${label}-${info.project.name}${info.repeatEachIndex ? `-R${info.repeatEachIndex}` : ""}`.toUpperCase().replace(/[^A-Z0-9-]/g, "-").slice(0, 30);

/** Deletes the code with exactly this text: its uses first, then the row (its course links go with it, on delete cascade). No `like`. */
async function removeCode(text: string): Promise<void> {
  await onLocalDb(async (sql) => {
    await sql`delete from discount_redemptions where code_id in (select id from discount_codes where code = ${text} and not welcome)`;
    await sql`delete from discount_codes where code = ${text} and not welcome`;
  }, { marksPages: false });
}

/** Makes a code for everyone, for all courses, once per person: `percent`, or `amountCents` of euros; its text noted for the clean-up; its id. */
async function makeCode(text: string, value: { percent: number } | { amountCents: number }): Promise<number> {
  await removeCode(text); // (a code a dead run left)
  codes.add(text);
  const percent = "percent" in value ? value.percent : null;
  const amountCents = "amountCents" in value ? value.amountCents : null;
  const [row] = await onLocalDb(
    (sql) => sql<{ id: number }[]>`insert into discount_codes (code, percent, amount_cents, scope, audience, once_per_person) values (${text}, ${percent}, ${amountCents}, 'all', 'all', true) returning id`,
    { marksPages: false },
  );
  return row.id;
}

/** The registration form's fields up to the payment choice and the contract's box (a date in Tallinn, the payer); the code and „Registreeru“ are the test's. */
async function fillRegistration(page: Page, email: string, choice: RegExp): Promise<void> {
  touchedPublicCourse = true;
  await page.getByRole("radio", { name: /Grupikoolitus/ }).check();
  await page.locator("[data-session]:not([aria-disabled='true'])").filter({ hasText: "Tallinn" }).first().click();
  await page.getByLabel("Nimi").fill("Test Maksja");
  await page.getByLabel("E-post", { exact: true }).fill(email);
  await page.getByLabel("Telefon").fill("+3725555555");
  await page.getByRole("radio", { name: choice }).check();
  await page.getByLabel(/tingimustega/).check();
}

/** „Mul on sooduskood“, the typed code (in lower case: the code is read in any spelling) and „Rakenda“; the applied line names the code. */
async function applyCode(scope: Locator, text: string): Promise<void> {
  await scope.getByRole("button", { name: "Mul on sooduskood" }).click();
  await scope.getByLabel("Sooduskood", { exact: true }).fill(text.toLowerCase());
  await scope.getByRole("button", { name: "Rakenda", exact: true }).click();
  await expect(scope.locator("[data-discount-applied]")).toContainText(text);
}

/** Waits until the payer has left the app and stops the test unless she is at the fake bank (never another site: nothing is pressed there). */
async function reachBank(page: Page, amount: string): Promise<void> {
  await page.waitForURL((url) => url.origin !== APP.origin);
  const at = new URL(page.url());
  expect(`${at.origin}${at.pathname.startsWith("/pay/") ? "/pay/" : at.pathname}`, "where the payer was sent: the fake Montonio is expected").toBe(`${E2E_MONTONIO.url}/pay/`);
  await expect(page.locator("[data-fake-order]")).toContainText(amount); // (what the app asked the bank for)
}

/** The fake bank's own record of an order, by the app's reference: what the app sent. */
async function fakeOrder(reference: string): Promise<{ status: string; grandTotal: number }> {
  const res = await fetch(`${E2E_MONTONIO.url}/_fake/orders/${reference}`);
  expect(res.status, `the fake Montonio knows ${reference}`).toBe(200);
  return (await res.json()) as { status: string; grandTotal: number };
}

/** The payer's payments as stored with their frozen discounts, oldest first. */
const paymentsOf = (email: string) =>
  onLocalDb(
    (sql) => sql<{ reference: string; kind: string; amountCents: number; discountCents: number; discountCode: string }[]>`
      select reference, kind, amount_cents as "amountCents", discount_cents as "discountCents", discount_code as "discountCode" from payments where email = ${email} order by id`,
    { marksPages: false },
  );
/** The uses of a code as stored (by its id): what the form or the cart froze. */
const usesOf = (codeId: number) =>
  onLocalDb((sql) => sql<{ via: string; listCents: number; discountCents: number; email: string }[]>`select via, list_cents as "listCents", discount_cents as "discountCents", email from discount_redemptions where code_id = ${codeId} order by id`, { marksPages: false });

test("a registration with a code: Montonio's amount is the discounted prepayment", async ({ page }, info) => {
  const email = await fresh("reg", info);
  const text = codeText("REG", info);
  const codeId = await makeCode(text, { percent: 10 }); // 10% of 350 € = 35 €: the total is 315 €, half of it 157,50 €
  await page.goto(COURSE);
  await fillRegistration(page, email, /50%/);
  const form = page.locator("[data-register-form]");
  await applyCode(form, text);
  // one „Kokku“ line: the list price struck through and the total
  await expect(form.locator("[data-discount-applied]")).toContainText(/35\s*€/);
  await expect(form.locator("[data-discount-total] s")).toContainText(/350\s*€/);
  await expect(form.locator("[data-discount-total] strong")).toContainText(/315\s*€/);
  await form.getByRole("button", { name: "Registreeru" }).click();
  await reachBank(page, "157.50 EUR");
  // the order at Montonio and the stored payment say the same, and the registration froze the discount with its code's spelling
  const [payment] = await paymentsOf(email);
  expect(payment).toMatchObject({ kind: "prepayment", amountCents: 15750 });
  expect((await fakeOrder(payment.reference)).grandTotal).toBe(157.5);
  expect(await usesOf(codeId)).toEqual([{ via: "form", listCents: 35000, discountCents: 3500, email }]);
  const [reg] = await onLocalDb((sql) => sql<{ discountCents: number; discountCode: string }[]>`select discount_cents as "discountCents", discount_code as "discountCode" from registrations where email = ${email}`, { marksPages: false });
  expect(reg).toEqual({ discountCents: 3500, discountCode: text });
  // paid at the bank: the half of the discounted total confirms the place
  await page.getByRole("button", { name: "Makstud" }).click();
  await page.waitForURL(/\/makse#tulemus=makstud&liik=registreering$/);
  await expect.poll(() => storedPayments(email)).toEqual([{ kind: "prepayment", status: "paid", amountCents: 15750 }]);
  expect(await storedRegistrations(email)).toEqual([expect.objectContaining({ status: "confirmed", paidCents: 15750 })]);
});

test("a cart with a code: the amount and the invoice line", async ({ page }, info) => {
  const email = await fresh("cart", info);
  const text = codeText("CART", info);
  const codeId = await makeCode(text, { percent: 10 }); // 10% of 190 € = 19 €: the cart asks 171 €
  // the cart's contract is the e-course terms (no test saves other ones while this one buys, R6), and the paid payment issues its invoice in the tests' own series
  const releaseTerms = await holdTerms();
  const releaseInvoices = await holdInvoiceSettings(info);
  try {
    await page.goto(`/ostukorv?kursus=${ECOURSE}`);
    const form = page.locator("[data-ecourse-form]");
    await form.getByLabel("Nimi").fill("Test Ostja");
    await form.getByLabel("E-post").fill(email);
    await applyCode(form, text);
    await expect(form.locator("[data-discount-total] s")).toContainText(/190\s*€/);
    await expect(form.locator("[data-discount-total] strong")).toContainText(/171\s*€/);
    await form.getByLabel(/tingimustega/).check();
    await form.getByRole("button", { name: "Maksa 171 €" }).click();
    await reachBank(page, "171.00 EUR");
    const [payment] = await paymentsOf(email);
    expect(payment).toEqual(expect.objectContaining({ kind: "ecourse", amountCents: 17100, discountCents: 1900, discountCode: text }));
    expect((await fakeOrder(payment.reference)).grandTotal).toBe(171);
    await page.getByRole("button", { name: "Makstud" }).click();
    await page.waitForURL(/\/makse#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus$/);
    await expect.poll(() => storedPayments(email)).toEqual([{ kind: "ecourse", status: "paid", amountCents: 17100 }]);
    expect(await usesOf(codeId)).toEqual([{ via: "cart", listCents: 19000, discountCents: 1900, email }]);
    // the invoice: the sum she paid, and the line that says the code, the list price and the euros taken off (the invoice is written by the paid winner)
    await expect
      .poll(() => onLocalDb((sql) => sql<{ amountCents: number; line: { discount?: { code: string; listCents: number; cents: number } } }[]>`select amount_cents as "amountCents", line from invoices where buyer->>'email' = ${email}`, { marksPages: false }))
      .toEqual([expect.objectContaining({ amountCents: 17100, line: expect.objectContaining({ discount: { code: text, listCents: 19000, cents: 1900 } }) })]);
  } finally {
    await releaseInvoices();
    await releaseTerms();
  }
});

test("Maria creates a code, it is used, and the count shows the use", async ({ page, context, visitorIp }, info) => {
  const email = await fresh("maria", info);
  const text = codeText("MARIA", info);
  await removeCode(text);
  codes.add(text);
  await signInAsAdmin(page, context, visitorIp, created);
  // „Uus sooduskood +“: the new code's drawer; „Lisa sooduskood“ creates it (the code and its percent are all it needs), and the drawer goes on at its own address
  await page.goto("/admin/sooduskoodid?kood=uus");
  await adminReady(page);
  await page.getByRole("textbox", { name: "Kood", exact: true }).fill(text.toLowerCase());
  await page.getByRole("textbox", { name: "Soodustus (%)", exact: true }).fill("10");
  await page.getByRole("button", { name: "Lisa sooduskood", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/sooduskoodid\?kood=\d+&lisatud=\d+$/);
  const id = Number(new URL(page.url()).searchParams.get("kood"));
  await expect(page.locator("[data-code-drawer]")).toHaveAttribute("data-code-drawer", String(id));
  await expect(page.locator("[data-flash='added']")).toHaveText("Sooduskood lisatud.");
  await expect(page.locator("[data-code-uses]")).toContainText("Kasutused (0)");
  expect(await onLocalDb((sql) => sql<{ code: string; percent: number; active: boolean }[]>`select code, percent, active from discount_codes where id = ${id}`, { marksPages: false })).toEqual([{ code: text, percent: 10, active: true }]);
  await expect(page.locator(`[data-code-row="${id}"] [data-code-state]`)).toHaveText("Aktiivne");
  await expect(page.locator(`[data-code-row="${id}"] td[data-label="Kasutatud"]`)).toHaveText("0");

  // a visitor takes it on the registration form (the same browser: the admin's sign-in changes nothing on the public page); the use is written with the registration
  await page.goto(COURSE);
  await fillRegistration(page, email, /50%/);
  const form = page.locator("[data-register-form]");
  await applyCode(form, text);
  await form.getByRole("button", { name: "Registreeru" }).click();
  await reachBank(page, "157.50 EUR");
  expect(await usesOf(id)).toEqual([{ via: "form", listCents: 35000, discountCents: 3500, email }]);

  // Maria's list and the code's drawer count it
  await page.goto("/admin/sooduskoodid");
  await adminReady(page);
  await expect(page.locator(`[data-code-row="${id}"] td[data-label="Kasutatud"]`)).toHaveText("1");
  await page.goto(`/admin/sooduskoodid?kood=${id}`);
  await adminReady(page);
  await expect(page.locator("[data-code-uses]")).toContainText("Kasutused (1)");
  await expect(page.locator("[data-uses-total]")).toContainText(/35\s*€/);
  const use = page.locator("[data-code-use]");
  await expect(use).toHaveCount(1);
  await expect(use).toContainText("Test Maksja");
  await expect(use).toContainText(/−35\s*€/);
  // a used code's text is locked (a new code is made instead): the field is disabled and says so
  await expect(page.getByRole("textbox", { name: "Kood", exact: true })).toBeDisabled();
  await expect(page.locator("[data-code-hint]")).toHaveText("Kasutatud koodi ei saa muuta: loo uus kood.");
});

test("the järelmaks threshold follows the total", async ({ page }, info) => {
  const text = codeText("JARELMAKS", info);
  // 260 € off 350 € leaves 90 €, under Inbank's 100 € (financing's range is 100–5000 €); off 190 € the discount is capped to keep 1 € (MIN_TOTAL_CENTS)
  await makeCode(text, { amountCents: 26_000 });
  const release = await takeFinancing(info, true);
  try {
    // the registration form: Järelmaks (Inbank) is a third choice at 350 €, gone at 90 €; the visitor's own choice comes back with the price
    await page.goto(COURSE);
    const form = page.locator("[data-register-form]");
    await page.getByRole("radio", { name: /Grupikoolitus/ }).check();
    await expect(form.locator("input[name='payment']")).toHaveCount(3);
    await form.getByRole("radio", { name: "Järelmaks (Inbank)" }).check();
    await expect(form.locator("[data-financing-range]")).toHaveCount(0);
    await applyCode(form, text);
    await expect(form.locator("[data-discount-total] strong")).toContainText(/90\s*€/);
    await expect(form.locator("input[name='payment']")).toHaveCount(2); // (100% and 50%: no Järelmaks (Inbank) at 90 €)
    await expect(form.getByRole("radio", { name: "Järelmaks (Inbank)" })).toHaveCount(0);
    await expect(form.locator("[data-financing-range]")).toHaveText("Järelmaks on võimalik 100–5000 € hinnaga koolitusele.");
    await form.locator("[data-discount-remove]").click();
    await expect(form.locator("input[name='payment']")).toHaveCount(3);
    await expect(form.getByRole("radio", { name: "Järelmaks (Inbank)" })).toBeChecked(); // (her own choice stayed in the form)
    await expect(form.locator("[data-financing-range]")).toHaveCount(0);

    // the cart: the same on the e-course's total (190 € in range, 1 € out of it)
    await page.goto(`/ostukorv?kursus=${ECOURSE}`);
    const cart = page.locator("[data-ecourse-form]");
    await cart.getByRole("radio", { name: "Järelmaks (Inbank)" }).check();
    await expect(cart.locator("[data-financing-range]")).toHaveCount(0);
    await applyCode(cart, text);
    await expect(cart.getByRole("button", { name: "Maksa 1 €" })).toBeVisible();
    await expect(cart.locator("[data-financing-range]")).toHaveText("Järelmaks on võimalik 100–5000 € hinnaga koolitusele.");
    await cart.locator("[data-discount-remove]").click();
    await expect(cart.getByRole("button", { name: "Maksa 190 €" })).toBeVisible();
    await expect(cart.locator("[data-financing-range]")).toHaveCount(0);
    await expect(cart.getByRole("radio", { name: "Järelmaks (Inbank)" })).toBeChecked();
  } finally {
    await release();
  }
});

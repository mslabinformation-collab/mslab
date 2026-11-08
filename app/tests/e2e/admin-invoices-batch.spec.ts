import type { BrowserContext, Locator, Page } from "@playwright/test";
import { submitsForms, test, expect } from "./test";
import { signInAsAdmin } from "./admin-login";
import { insertAdminFixtures, insertStoredPayment, onLocalDb, removeAdminFixtures, removeAdminRows, storedAdminRegistration, type AdminFixtures } from "./fixtures";
import { holdInvoiceSettings, INVOICE_COMPANY, INVOICE_NUMBER, madeInvoices } from "./invoices";

// „Arveta maksed“ → „Koosta {n} arvet“ (admin UX pass B11), the one part of Maria's invoice screens (admin-invoices.spec.ts) that acts on the whole
// database: one press bills every paid payment without an invoice there is, other tests' too. This machine's database has no seller card between the
// tests that hold one, so every payment another test settles then, or stores as paid, is such a payment, and while the other specs run they come and
// go under this test: one made after the page counted them leaves the strip standing after the press or after a reload; one billed by the press is
// taken away, with its invoice, by the clean-up of the test that made it before this test counts the invoices; and the press bills a payment another
// test is still looking at. So this spec is one of those that run after all the others (playwright.config.ts EDITS), where no test stores a payment
// without holding the invoice settings, which this test holds too (invoices.ts holdInvoiceSettings): the payments without an invoice are its own three
// and any an interrupted run left. It reads no public page, so it takes no edit turn (edit-lock.ts). The rows are its own and go as in
// admin-invoices.spec.ts: the fixtures by their tag, the invoices of its seller card by the seller.

const created = { tokens: new Set<string>(), sessions: new Set<string>() };
let fx: AdminFixtures | null = null;
let giveBack: (() => Promise<void>) | null = null;

test.beforeEach(() => submitsForms());

test.afterEach(async () => {
  await removeAdminRows({ tokens: created.tokens, sessions: created.sessions }).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
  try {
    if (fx) {
      await onLocalDb((sql) => sql`delete from invoices where buyer->>'email' like ${`%${fx!.tag}%`} or seller->>'company' = ${INVOICE_COMPANY}`, { marksPages: false });
      expect(await removeAdminFixtures(fx.tag)).toBe(0);
    }
  } finally {
    fx = null;
    await giveBack?.();
    giveBack = null;
  }
});

async function fixtures(project: string): Promise<AdminFixtures> {
  fx = await insertAdminFixtures(project);
  return fx;
}
const signIn = (page: Page, context: BrowserContext, ip: string) => signInAsAdmin(page, context, ip, created);

/**
 * The folded strip's own space: as much below its head as above it. The empty line that says what was done is in the page for a screen reader but
 * takes no row of the strip's grid, so the strip's gap is not paid for it (it once was: 14 px more below than above).
 */
const spaceAround = (strip: Locator) =>
  strip.evaluate((el) => {
    const head = el.firstElementChild!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return { above: head.top - box.top, below: box.bottom - head.bottom };
  });

test("B11: „Koosta {n} arvet“ — the panel names the numbers, nothing is made before „Jah“, the result says what was made, nothing is mailed, and the strip is gone", async ({ page, context, visitorIp }, info) => {
  giveBack = await holdInvoiceSettings(info);
  const f = await fixtures(info.project.name);
  const payer = f.registration;
  const pay = (name: string, minutesAgo: number) =>
    insertStoredPayment({ email: payer.email, name, kind: "prepayment", status: "paid", amountCents: 17500, registrationId: payer.id, courseId: f.course.id, method: "paymentInitiation", bank: "Swedbank", paid: true, minutesAgo });
  // three payments paid while there was no invoice for them; the newest is stored first, so the order of the ids is not the order of the days
  const newest = await pay(`${payer.name} C`, 10);
  const middle = await pay(`${payer.name} B`, 20);
  const oldest = await pay(`${payer.name} A`, 30);
  await signIn(page, context, visitorIp);
  await page.goto("/admin/arved");
  const strip = page.locator("section#arveta");
  const n = Number(/(\d+)$/.exec((await strip.getByRole("heading", { level: 2 }).textContent())!.trim())![1]);
  expect(n).toBeGreaterThanOrEqual(3); // (a run that was stopped half-way may have left paid payments with no invoice: they are billed by the same press)
  await expect(strip.locator("[data-uninvoiced-summary]")).toContainText("Tasutud, aga arve puudub · ");
  const bulk = strip.getByRole("button", { name: `Koosta ${n} arvet`, exact: true }); // (exact: „Jah, koosta {n} arvet“ in the panel is another button)
  await expect(bulk).toBeVisible();
  const space = await spaceAround(strip);
  expect(Math.abs(space.below - space.above), `the folded strip: ${space.above} px above its head, ${space.below} px below`).toBeLessThan(1);
  // (the empty line is still in the page, for the screen reader that is told what was done)
  await expect(strip.getByRole("status")).toHaveCount(1);

  // asking: the question, the one line with the numbers, the two buttons; „Katkesta“ makes nothing and the focus is back on the button
  await bulk.click();
  const panel = strip.locator("[data-confirm-panel]");
  await expect(panel.locator("p").first()).toHaveText(`Kas koostan ${n} arvet?`);
  const lineText = (await panel.locator("li").textContent())!.trim();
  const numbers = /^Iga arve saab oma numbri \((\S+)–(\S+)\)\. Õpilastele neid ei saadeta\.$/.exec(lineText);
  expect(numbers, lineText).not.toBeNull();
  const [, first, last] = numbers!;
  expect(first).toMatch(INVOICE_NUMBER);
  expect(last).toMatch(INVOICE_NUMBER);
  await expect(bulk).toHaveCount(0);
  await panel.getByRole("button", { name: "Katkesta" }).click();
  await expect(panel).toHaveCount(0);
  await expect(bulk).toBeFocused();
  expect(await madeInvoices()).toEqual([]);

  // „Jah“: three or more invoices, the numbers the panel named, oldest paid first, paid on the payment's day by Montonio, not mailed
  await bulk.click();
  await strip.getByRole("button", { name: `Jah, koosta ${n} arvet` }).click();
  const status = strip.locator("[data-uninvoiced-result]");
  await expect(status).toHaveText(`Koostatud ${n} arvet: ${first}–${last}.`);
  await expect(status).toBeFocused();
  await expect(strip.getByRole("heading")).toHaveCount(0);
  await expect(strip.getByRole("button")).toHaveCount(0);
  const made = await madeInvoices();
  expect(made).toHaveLength(n);
  expect([made[0].number, made[n - 1].number]).toEqual([first, last]);
  const seqs = made.map((i) => Number(/-(\d+)$/.exec(i.number)![1]));
  expect(seqs).toEqual(seqs.map((_, i) => seqs[0] + i)); // (consecutive)
  const mine = [oldest.id, middle.id, newest.id].map((id) => made.find((i) => i.paymentId === id)!);
  expect(mine.map((i) => i.number), "oldest paid first").toEqual([...mine.map((i) => i.number)].sort());
  for (const i of made) expect([i.status, i.paidMethod, i.sentAt]).toEqual(["paid", "montonio", null]);
  expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 0 }); // (the stored rows never added money, and the invoices do not)
  // they are in the list below; a reload draws no strip at all
  await expect(page.locator(`[data-invoice="${first}"]`)).toBeVisible();
  await page.reload();
  await expect(page.locator("section#arveta")).toHaveCount(0);
  await expect(page.locator(`[data-invoice="${last}"]`)).toBeVisible();
});

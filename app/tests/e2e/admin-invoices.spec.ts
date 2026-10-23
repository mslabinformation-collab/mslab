import type { BrowserContext, Locator, Page } from "@playwright/test";
import { submitsForms, test, expect } from "./test";
import { adminReady, signInAsAdmin } from "./admin-login";
import {
  insertAdminFixtures,
  insertStoredPayment,
  onLocalDb,
  removeAdminFixtures,
  removeAdminRows,
  storedAdminRegistration,
  type AdminFixtures,
} from "./fixtures";
import { expectFits, holdInvoiceSettings, INVOICE_COMPANY, INVOICE_NUMBER, noOverflow, offered, openDrawer, rowOf, today, viaMenu } from "./invoices";

// Invoices, Maria's side (invoices Task 5, spec §5): the registration drawer's „Arved“ — „Koosta arve“ as a request to pay, a receipt made with the
// money by the Raha card's „Lisa laekumine“ (admin UX pass B4, Task 5: „Koosta arve“ offers a receipt only for money recorded without one),
// „Märgi tasutuks“ (which confirms the registration at 50 %), „Võta tasumine tagasi“ for a request and for a receipt, „Tühista arve“ (these under
// each row's „Veel ▾“, the last two as ConfirmPanels: S3-f and P-11, admin UX pass piece 2 Task 6), „Saada õpilasele“ — the „Arved“ page with its „Arveta maksed“ and the month's CSV, and Seaded → „Arve andmed“ with the sample. The signed-in tests
// run against the local dev server only: they sign in as Dim through the devLink and look at rows each test inserts for itself and deletes again
// (tests/e2e/fixtures.ts, an unpublished fixture course; its invoices have no cascade, so they are deleted by the buyer's address). The
// seller card and the bank details are shared settings other tests read: a test holds the prepayment setting's lock, writes its own and puts the
// stored rows back (tests/e2e/invoices.ts holdInvoiceSettings, with the other helpers the invoice specs share). No mail is sent here (no
// RESEND_API_KEY): a send that reaches Resend answers „Kirja ei saadeta“, and the registration of the send test carries a sample address
// (`…@example.test`), which counts as sent without a mail. The whole path in a row is invoices.spec.ts; the races on real Postgres are
// invoices-race.spec.ts.

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

test.describe("guard (GET only)", () => {
  test("the list, the PDF, the CSV and the sample need a session", async ({ request }) => {
    const page = await request.get("/admin/arved", { maxRedirects: 0 });
    expect([303, 307, 308]).toContain(page.status());
    expect(page.headers().location).toMatch(/\/admin\/login$/);
    for (const path of ["/api/admin/arve/1", "/api/admin/arved?kuu=2026-10", "/api/admin/naidisarve"]) {
      const res = await request.get(path);
      expect([res.status(), await res.json()], path).toEqual([401, { ok: false, error: "unauthorized" }]);
    }
  });
});

test("a request to pay: made in two taps, marked paid (the registration confirms at 50 %), taken back; money and its receipt in one „Lisa laekumine“, undone (the sum comes off); a request cancelled", async ({ page, context, visitorIp }, info) => {
  giveBack = await holdInvoiceSettings(info);
  const f = await fixtures(info.project.name);
  await signIn(page, context, visitorIp);
  const { drawer, block } = await openDrawer(page, f);
  await expect(block.locator("h3")).toHaveText("Arved"); // (a phone shows the folded row instead of the heading: the block is a PhoneFold)
  await expect(block.locator("[data-invoices-none]")).toHaveText("Sellele registreeringule pole arveid koostatud.");

  // „Koosta arve“ offers exactly the two amounts of a half-choice registration, „Maksmiseks“ chosen
  await block.locator("[data-invoice-create]").click();
  const form = block.locator("[data-invoice-create-form]");
  expect(await offered(block)).toEqual(["prepayment", "full"]);
  await expect(form.locator("label", { hasText: "Ettemaks 50%" })).toContainText("175,00");
  await expect(form.locator("label", { hasText: "Kogu summa (100%)" })).toContainText("350,00");
  await expect(form.locator('[data-invoice-mode="request"]')).toBeChecked();
  await form.locator("[data-invoice-create-confirm]").click();
  await expect(block.locator("[data-invoice-create-status]")).toContainText("on koostatud.");
  await expect(rowOf(block, "unpaid")).toHaveCount(1);
  // (the row by its id from here on: its state changes under the locator)
  const requestId = (await rowOf(block, "unpaid").getAttribute("data-invoice-id"))!;
  const unpaid = block.locator(`[data-invoice-id="${requestId}"]`);
  const number = (await unpaid.locator("strong").first().textContent())!.trim();
  expect(number).toMatch(INVOICE_NUMBER);
  await expect(unpaid.locator("[data-invoice-state]")).toHaveText("Tasumata");
  await expect(unpaid.locator("[data-invoice-amount]")).toContainText("175,00");
  await expect(unpaid.locator("[data-invoice-facts]")).toContainText("Ettemaks 50%");
  await expect(unpaid.locator("[data-invoice-facts]")).toContainText("Maksta kuni");
  expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 0, status: "awaiting_prepayment" });
  expect(await noOverflow(page)).toBe(true);
  // its PDF, as Maria downloads it
  const href = (await unpaid.locator("[data-invoice-download]").getAttribute("href"))!;
  const pdf = await page.request.get(href);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-disposition"]).toBe(`attachment; filename="MS-LAB-arve-${number}.pdf"`);
  expect(pdf.headers()["cache-control"]).toBe("private, no-store");
  expect((await pdf.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  // the 50 % is covered: only the rest is offered now
  await block.locator("[data-invoice-create]").click();
  expect(await offered(block)).toEqual(["balance"]);
  await block.getByRole("button", { name: "Katkesta" }).click();

  // „Märgi tasutuks“ adds the amount to „Laekunud summa“ and the registration confirms
  await viaMenu(unpaid, "Märgi tasutuks");
  const panel = unpaid.locator('[data-invoice-panel="paid"]');
  await expect(panel).toContainText("Summa lisatakse registreeringu „Laekunud summa“ juurde");
  await expect(panel.locator("[data-paid-date]")).toHaveAttribute("type", "date");
  await panel.getByRole("button", { name: "Salvesta tasumine" }).click();
  await expect(unpaid.locator("[data-invoice-status-line]")).toHaveText("Arve on märgitud tasutuks.");
  const paid = unpaid;
  await expect(paid.locator("[data-invoice-state]")).toHaveText("Tasutud");
  await expect(paid.locator("[data-invoice-facts]")).toContainText("Pangaülekanne");
  await expect(drawer.locator("[data-paid]")).toHaveText("175 €");
  await expect(drawer.locator("[data-reg-status]")).toHaveText("Kinnitatud");
  expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });

  // „Võta tasumine tagasi“ of a request: it asks first (and „Katkesta“ changes nothing), then the amount comes off again
  await viaMenu(paid, "Võta tasumine tagasi");
  await expect(paid.locator('[data-invoice-panel="undo"]')).toContainText("Arve muutub uuesti tasumata ja summa võetakse „Laekunud summa“ alt maha.");
  await paid.getByRole("button", { name: "Katkesta" }).click();
  await expect(paid.locator("[data-more-menu] > button")).toBeFocused(); // (the question is gone and the focus is back where it came from)
  expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
  await viaMenu(paid, "Võta tasumine tagasi");
  await paid.getByRole("button", { name: "Jah, võta tasumine tagasi" }).click();
  await expect(paid.locator("[data-invoice-status-line]")).toHaveText("Arve on jälle tasumata.");
  await expect(unpaid.locator("[data-invoice-state]")).toHaveText("Tasumata");
  await expect(drawer.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");
  expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 0, status: "awaiting_prepayment" });

  // with nothing recorded „Koosta arve“ offers no receipt (B4: a receipt documents money recorded with „Lisa laekumine“)
  await block.locator("[data-invoice-create]").click();
  await expect(block.locator('[data-invoice-mode="receipt"]')).toBeDisabled();
  await block.getByRole("button", { name: "Katkesta" }).click();
  // the money and its receipt in one press: „Lisa laekumine“ with „Koosta kviitung“ ticked, 175 € in cash
  await adminReady(page);
  const card = drawer.locator("[data-money-card]");
  await card.locator("[data-add-payment]").click();
  const adding = card.locator("[data-add-payment-panel]");
  await expect(adding.getByRole("radio", { name: "175 € · ettemaks" })).toBeChecked();
  await expect(adding.locator("[data-receipt]")).toBeChecked();
  await adding.locator('[data-paid-method="cash"]').check();
  await adding.locator("[data-add-payment-submit]").click();
  await expect(card.locator("[data-add-payment-result]")).toHaveText(/^175 € lisatud · kviitung E2E\d{4}-\d{3,} · koht kinnitatud\.$/);
  await expect(rowOf(block, "paid")).toHaveCount(1);
  const receipt = block.locator(`[data-invoice-id="${(await rowOf(block, "paid").getAttribute("data-invoice-id"))!}"]`);
  const receiptNumber = (await receipt.locator("strong").first().textContent())!.trim();
  expect(receiptNumber).toMatch(INVOICE_NUMBER);
  await expect(card.locator("[data-add-payment-result]")).toContainText(`kviitung ${receiptNumber} ·`);
  await expect(receipt.locator("[data-invoice-state]")).toHaveText("Tasutud");
  await expect(receipt.locator("[data-invoice-amount]")).toContainText("175,00");
  await expect(receipt.locator("[data-invoice-facts]")).toContainText("Sularaha");
  // (a receipt can only be taken back: that is the one item under its „Veel ▾“; it is neither marked nor cancelled)
  await receipt.locator("[data-more-menu] > button").click();
  await expect(receipt.getByRole("menuitem")).toHaveText(["Võta tasumine tagasi"]);
  await expect(drawer.locator("[data-paid]")).toHaveText("175 €");
  await expect(drawer.locator("[data-reg-status]")).toHaveText("Kinnitatud");
  expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
  // „Võta tasumine tagasi“ of the receipt asks first (S3-f: the question, the three lines — the sum then falls under 50 % —, the two buttons), then it is
  // cancelled — the number stays — and its money comes off „Laekunud summa“
  await receipt.getByRole("menuitem", { name: "Võta tasumine tagasi" }).click();
  const ask = receipt.locator('[data-invoice-panel="undo"]');
  await expect(ask.locator("[data-confirm-panel] > p")).toHaveText(`Kas võtan kviitungi ${receiptNumber} tasumise tagasi?`);
  await expect(ask.locator("li")).toHaveText(["Kviitung tühistatakse (number jääb alles).", "Laekunud summa väheneb 175 €.", "Registreering läheb tagasi olekusse „Ootab ettemaksu“."]);
  await expect(ask.getByRole("button")).toHaveText(["Jah, võta tasumine tagasi", "Katkesta"]);
  await ask.getByRole("button", { name: "Jah, võta tasumine tagasi" }).click();
  await expect(receipt.locator("[data-invoice-status-line]")).toHaveText("Kviitung on tühistatud.");
  await expect(receipt.locator("[data-invoice-state]")).toHaveText("Tühistatud");
  await expect(rowOf(block, "cancelled")).toHaveCount(1);
  await expect(drawer.locator("[data-paid]")).toHaveText("0 €");
  await expect(drawer.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");
  expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 0, status: "awaiting_prepayment" });

  // „Tühista arve“ of the unpaid request: it asks first (P-11)
  const request = unpaid;
  await viaMenu(request, "Tühista arve");
  const cancelling = request.locator('[data-invoice-panel="cancel"]');
  await expect(cancelling.locator("[data-confirm-panel] > p")).toHaveText(`Kas tühistan arve ${number}?`);
  await expect(cancelling.locator("li")).toHaveText(["Number jääb alles ja summa on uue arve jaoks jälle vaba."]);
  await cancelling.getByRole("button", { name: "Katkesta" }).click();
  await expect(request.locator("[data-invoice-state]")).toHaveText("Tasumata");
  await viaMenu(request, "Tühista arve");
  await request.getByRole("button", { name: "Jah, tühista arve" }).click();
  await expect(request.locator("[data-invoice-state]")).toHaveText("Tühistatud");
  await expect(rowOf(block, "cancelled")).toHaveCount(2);
  await expect(rowOf(block, "unpaid")).toHaveCount(0);
  // both numbers are still there, and both amounts are open again
  await block.locator("[data-invoice-create]").click();
  expect(await offered(block)).toEqual(["prepayment", "full"]);
  expect(await noOverflow(page)).toBe(true);
});

test("Esc inside the drawer closes „Veel ▾“ only: the focus is back on its button and the drawer stays open; the next Esc is the drawer's own (Task 1 review M5)", async ({ page, context, visitorIp }, info) => {
  test.skip(info.project.name !== "chromium", "chromium only");
  giveBack = await holdInvoiceSettings(info);
  const f = await fixtures(info.project.name);
  await signIn(page, context, visitorIp);
  const { drawer, block } = await openDrawer(page, f);
  await block.locator("[data-invoice-create]").click();
  await block.locator("[data-invoice-create-confirm]").click();
  const row = rowOf(block, "unpaid");
  await expect(row).toHaveCount(1);
  const more = row.locator("[data-more-menu] > button");
  await more.click();
  await expect(row.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row.getByRole("menu")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(more).toBeFocused();
  // the question of „Tühista arve“ is the same: Esc cancels it and nothing more
  await viaMenu(row, "Tühista arve");
  await expect(row.locator("[data-confirm-panel]")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row.locator("[data-confirm-panel]")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(more).toBeFocused();
  expect(await onLocalDb((sql) => sql<{ status: string }[]>`select status from invoices where buyer->>'email' like ${`%${f.tag}%`}`, { marksPages: false })).toEqual([{ status: "unpaid" }]);
  // with nothing open, Esc is the drawer's own
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("the phone drawer (375 × 812): Arved is a folded row with its summary, the invoice and its „Veel ▾“ open inside the screen, nothing scrolls sideways", async ({ page, context, visitorIp, isMobile }, info) => {
  test.skip(!isMobile, "the phone project only");
  giveBack = await holdInvoiceSettings(info);
  const f = await fixtures(info.project.name);
  await signIn(page, context, visitorIp);
  await page.setViewportSize({ width: 375, height: 812 });
  // one request to pay, made through the block (opened to do it)
  const made = await openDrawer(page, f);
  await made.block.locator("[data-invoice-create]").click();
  await made.block.locator("[data-invoice-create-confirm]").click();
  await expect(rowOf(made.block, "unpaid")).toHaveCount(1);
  // as the page draws it: the row, closed, with its summary (P-3); the invoice is not in view
  const { drawer, block } = await openDrawer(page, f, { open: false });
  await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // (it slides in: measured in place)
  const toggle = block.locator("[data-phone-fold-toggle]");
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText("Arved");
  await expect(toggle).toContainText("1 tasumata");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(block.locator("h3")).toBeHidden(); // (the heading is the desktop's)
  await expect(block.locator("[data-invoice-id]")).toBeHidden();
  // the folded rows are 52 px rows of the drawer's width, and the page does not scroll sideways
  for (const title of ["Tagasiside", "Registreerimise andmed"]) {
    const summary = drawer.locator("details[data-fold] > summary", { hasText: title });
    await expect(summary).toBeVisible();
    const box = (await summary.boundingBox())!;
    expect(box.height, title).toBeGreaterThanOrEqual(52);
    expect(box.x, title).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, title).toBeLessThanOrEqual(375);
  }
  const box = (await toggle.boundingBox())!;
  expect([box.height >= 52, box.x >= 0, box.x + box.width <= 375]).toEqual([true, true, true]);
  expect(await noOverflow(page)).toBe(true);
  // opened: the invoice and its two buttons in view; „Veel ▾“ lists the rest, inside the screen
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const row = rowOf(block, "unpaid");
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Saada õpilasele" })).toBeVisible();
  await expect(row.getByRole("link", { name: /^Laadi alla \(PDF\)/ })).toBeVisible();
  await row.locator("[data-more-menu] > button").click();
  const menu = row.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["Muuda saajat", "Märgi tasutuks", "Tühista arve"]);
  const place = (await menu.boundingBox())!;
  expect([place.x >= 0, place.x + place.width <= 375, place.y >= 0, place.y + place.height <= 812]).toEqual([true, true, true, true]);
  expect(await noOverflow(page)).toBe(true);
  await menu.getByRole("menuitem", { name: "Tühista arve" }).click();
  await expect(row.locator("[data-confirm-panel]")).toBeVisible();
  await expectFits(page, block, "the question of „Tühista arve“ in the phone drawer");
  await row.getByRole("button", { name: "Katkesta" }).click();
  await expectFits(page, block, "the opened „Arved“ in the phone drawer");
});

test("„Saada õpilasele“: a second address that is no address is refused; the send is recorded with the second address as its note", async ({ page, context, visitorIp }, info) => {
  giveBack = await holdInvoiceSettings(info);
  const f = await fixtures(info.project.name);
  // a sample address counts as sent without a mail (server/invoice-send.ts); the invoice is made for this address
  const sample = `e2e-admin-inv-${f.tag}@example.test`;
  await onLocalDb((sql) => sql`update registrations set email = ${sample} where id = ${f.registration.id}`, { marksPages: false });
  await signIn(page, context, visitorIp);
  const { block } = await openDrawer(page, f);
  await block.locator("[data-invoice-create]").click();
  await block.locator("[data-invoice-create-confirm]").click();
  await expect(rowOf(block, "unpaid")).toHaveCount(1);
  const row = block.locator(`[data-invoice-id="${(await rowOf(block, "unpaid").getAttribute("data-invoice-id"))!}"]`);
  await row.locator("[data-invoice-send]").click();
  const panel = row.locator('[data-invoice-panel="send"]');
  await expect(panel).toContainText(`Kiri läheb aadressile ${sample}.`);
  await panel.locator("[data-invoice-also]").fill("ei-aadress");
  await panel.locator("[data-invoice-send-confirm]").click();
  await expect(row.locator("[data-invoice-status-line]")).toHaveText("Sisesta korrektne e-posti aadress.");
  await expect(panel.locator("[data-invoice-also]")).toHaveAttribute("aria-invalid", "true");
  // no second address: sent, recorded
  await panel.locator("[data-invoice-also]").fill("");
  await panel.locator("[data-invoice-send-confirm]").click();
  await expect(row.locator("[data-invoice-status-line]")).toHaveText("Arve on saadetud.");
  await expect(row.locator("[data-invoice-sent]")).toContainText("Saadetud");
  const sent = async () => onLocalDb((sql) => sql<{ sentAt: Date | null; sentNote: string }[]>`select sent_at as "sentAt", sent_note as "sentNote" from invoices where buyer->>'email' = ${sample}`, { marksPages: false });
  expect((await sent())[0].sentAt).not.toBeNull();
  expect((await sent())[0].sentNote).toBe("");
});

test("„Arved“: the list with its filters, the month's CSV, and „Arveta maksed“ with its own „Koosta arve“", async ({ page, context, visitorIp }, info) => {
  giveBack = await holdInvoiceSettings(info);
  const f = await fixtures(info.project.name);
  const payer = f.registration;
  await signIn(page, context, visitorIp);
  // one invoice of Maria's, to find in the list (made before the payment below: while a paid payment waits for its invoice, its row's button is the only „Koosta arve“)
  const { block } = await openDrawer(page, f);
  await block.locator("[data-invoice-create]").click();
  await block.locator("[data-invoice-create-confirm]").click();
  await expect(rowOf(block, "unpaid")).toHaveCount(1);
  const number = (await rowOf(block, "unpaid").locator("strong").first().textContent())!.trim();
  expect(number).toMatch(INVOICE_NUMBER);
  // a payment that was paid while there was no invoice for it (the card was empty, or the step failed)
  const payment = await insertStoredPayment({ email: payer.email, name: payer.name, kind: "prepayment", status: "paid", amountCents: 17500, registrationId: payer.id, courseId: f.course.id, method: "paymentInitiation", bank: "Swedbank", paid: true, minutesAgo: 5 });
  // the drawer then lists it with its own „Koosta arve“, which is the only one in view (README A2 drawer 4)
  const again = await openDrawer(page, f);
  await expect(again.block.locator(`[data-uninvoiced-create="${payment.id}"]`)).toBeVisible();
  await expect(again.block.locator("[data-invoice-create]")).toHaveCount(0);

  // Maksed has it as its second tab (A6); the page lists the payment in the strip „Arveta maksed“, folded until „Näita ▸“, and the invoice below
  await page.goto("/admin/maksed");
  await page.getByRole("navigation", { name: "Maksed ja arved" }).getByRole("link", { name: "Arved" }).click();
  await expect(page).toHaveURL(/\/admin\/arved$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Maksed ja arved");
  await expect(page.getByRole("navigation", { name: "Maksed ja arved" }).getByRole("link", { name: "Arved" })).toHaveAttribute("aria-current", "page");
  const strip = page.locator("section#arveta");
  await expect(strip.getByRole("heading", { level: 2 })).toContainText("Arveta maksed: ");
  const line = strip.locator(`[data-uninvoiced-payment="${payment.id}"]`);
  await expect(line).toBeHidden();
  await strip.getByRole("button", { name: "Näita ▸" }).click();
  await expect(strip.getByRole("button", { name: "Peida ▾" })).toHaveAttribute("aria-expanded", "true");
  await expect(line).toContainText(payer.name);
  await expect(line).toContainText("175,00");
  await expect(line.locator("[data-uninvoiced-pays]")).toHaveText("Koostab uue arve");
  const listed = page.locator(`[data-invoice="${number}"]`);
  await expect(listed).toBeVisible();
  await expect(listed.locator("[data-invoice-who]")).toContainText(payer.name);
  await expect(listed.locator("[data-invoice-facts]")).toContainText("maksta kuni "); // (the list's meta line, short form)
  expect(await noOverflow(page)).toBe(true);

  // the filters: the pills carry counts, by state (a link with the state in the address)
  const unpaidPill = page.getByRole("link", { name: /^Tasumata/ });
  await expect(unpaidPill).toContainText(/\d/);
  await page.getByRole("link", { name: /^Tasutud/ }).click();
  await expect(page).toHaveURL(/staatus=paid$/);
  await expect(page.locator(`[data-invoice="${number}"]`)).toHaveCount(0);
  await unpaidPill.click();
  await expect(page.locator(`[data-invoice="${number}"]`)).toBeVisible();

  // the search finds it by its number (a link with the text in the address), and „Tühjenda otsing“ clears it
  const search = page.getByRole("searchbox", { name: "Otsi nime, e-posti või arve numbri järgi" });
  await search.fill(number);
  await expect(page).toHaveURL(new RegExp(`otsi=${number}`));
  await expect(page.locator("[data-invoice]")).toHaveCount(1);
  await expect(page.locator(`[data-invoice="${number}"]`)).toBeVisible();
  await search.fill(`${number}-ei-ole`);
  await expect(page.locator("[data-list-empty]")).toContainText(`„${number}-ei-ole“ järgi arveid ei leitud.`);
  await page.locator("[data-search-clear]").click();
  await expect(page).not.toHaveURL(/otsi=/);

  // the month is a select that applies on change, with no „Näita“; this month is the list when none is chosen, and the CSV button names it
  const month = today().slice(0, 7);
  const monthName = new Intl.DateTimeFormat("et-EE", { timeZone: "Europe/Tallinn", month: "long", year: "numeric" }).format(new Date());
  await page.goto("/admin/arved");
  const select = page.getByRole("combobox", { name: "Kuu" });
  await expect(select).toHaveValue(month);
  await expect(page.getByRole("button", { name: "Näita", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-invoices-csv]")).toHaveText(`Laadi alla (CSV) · ${monthName}`);
  await select.selectOption("koik");
  await expect(page).toHaveURL(/kuu=koik/);
  await expect(page.locator(`[data-invoice="${number}"]`)).toBeVisible();
  await expect(page.locator("[data-invoices-csv]")).toHaveText(`Laadi alla (CSV) · ${monthName}`); // (while „Kõik kuud“ is chosen it names this month)
  await page.goto("/admin/arved?kuu=2001-01");
  await expect(page.locator("[data-invoices-count]")).toHaveText("Arveid: 0");
  await expect(page.locator("[data-invoices-csv]")).toHaveText("Laadi alla (CSV) · jaanuar 2001");
  await page.goto(`/admin/arved?kuu=${month}`);
  await expect(page.locator(`[data-invoice="${number}"]`)).toBeVisible();

  // the month's CSV: a BOM, the name, the invoice's row
  const csvHref = (await page.locator("[data-invoices-csv]").getAttribute("href"))!;
  expect(csvHref).toBe(`/api/admin/arved?kuu=${month}`);
  const csv = await page.request.get(csvHref);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-disposition"]).toBe(`attachment; filename="MS-LAB-arved-${month}.csv"`);
  expect(csv.headers()["content-type"]).toBe("text/csv; charset=utf-8");
  const bytes = await csv.body();
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(bytes.toString("utf8")).toContain(`"${number}"`);

  // „Koosta arve“ on the payment's row: the address #arveta opens the strip's list; the row leaves „Arveta maksed“ and a paid Montonio invoice appears
  await page.goto("/admin/arved#arveta");
  await expect(strip.getByRole("button", { name: "Peida ▾" })).toBeVisible();
  await page.locator(`[data-uninvoiced-create="${payment.id}"]`).click();
  await expect(page.locator(`[data-uninvoiced-payment="${payment.id}"]`)).toHaveCount(0);
  const made = page.locator('[data-invoice-status="paid"]', { hasText: payer.name }).first();
  await expect(made.locator("[data-invoice-facts]")).toContainText("Montonio");
  await expect(made.locator("[data-more-menu]")).toHaveCount(0); // (an online payment's invoice is never changed by Maria: nothing is under „Veel ▾“, so there is none)
  // the registration's paid sum was not touched by it (the payment itself had added it, here a stored row that did not)
  expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 0 });
});

/** The invoices the test's seller card made (seller E2E Arvete OÜ), in the order of their numbers, as stored. */
const madeInvoices = () =>
  onLocalDb((sql) => sql<{ number: string; paymentId: number | null; status: string; paidMethod: string | null; sentAt: Date | null }[]>`
    select number, payment_id as "paymentId", status, paid_method as "paidMethod", sent_at as "sentAt" from invoices where seller->>'company' = ${INVOICE_COMPANY} order by seq`, { marksPages: false });

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
  expect(n).toBeGreaterThanOrEqual(3); // (other paid payments with no invoice may be in the local database: they are billed by the same press)
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

test("without a seller the strip offers no button: the link „Täida Seaded → Arve andmed“ stands in its place", async ({ page, context, visitorIp }, info) => {
  giveBack = await holdInvoiceSettings(info, null);
  const f = await fixtures(info.project.name);
  await insertStoredPayment({ email: f.registration.email, name: f.registration.name, kind: "prepayment", status: "paid", amountCents: 17500, registrationId: f.registration.id, courseId: f.course.id, method: "paymentInitiation", bank: "Swedbank", paid: true, minutesAgo: 5 });
  await signIn(page, context, visitorIp);
  await page.goto("/admin/arved");
  const strip = page.locator("section#arveta");
  await expect(strip.getByRole("heading", { level: 2 })).toContainText("Arveta maksed: ");
  await expect(strip.getByRole("button", { name: /^Koosta / })).toHaveCount(0);
  const link = strip.getByRole("link", { name: "Täida Seaded → Arve andmed" });
  await expect(link).toHaveAttribute("href", "/admin/seaded#arve");
  await strip.getByRole("button", { name: "Näita ▸" }).click();
  await expect(strip.locator("[data-uninvoiced-create]")).toHaveCount(0); // (nor on the rows)
  expect(await madeInvoices()).toEqual([]);
});

test("the invoice row's columns (the Part 2 prototype): number and state | who and what | sum | actions on one line from a wide card, the actions under the lines from 761 px", async ({ page, context, visitorIp, isMobile }, info) => {
  test.skip(isMobile, "sets its own widths: the desktop project only");
  giveBack = await holdInvoiceSettings(info);
  const f = await fixtures(info.project.name);
  await signIn(page, context, visitorIp);
  const { block } = await openDrawer(page, f);
  await block.locator("[data-invoice-create]").click();
  await block.locator("[data-invoice-create-confirm]").click();
  await expect(rowOf(block, "unpaid")).toHaveCount(1);
  const number = (await rowOf(block, "unpaid").locator("strong").first().textContent())!.trim();
  const geometry = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/arved");
    const row = page.locator(`[data-invoice="${number}"]`);
    await expect(row).toBeVisible();
    const box = async (selector: string) => (await row.locator(selector).first().boundingBox())!;
    const [num, tag, who, facts, amount, actions] = [await box("strong"), await box("[data-invoice-state]"), await box("[data-invoice-who]"), await box("[data-invoice-facts]"), await box("[data-invoice-amount]"), await box('[role="group"]')];
    expect(await noOverflow(page), `${width}: the page scrolls sideways`).toBe(true);
    return { num, tag, who, facts, amount, actions, row: (await row.boundingBox())! };
  };
  // a wide card: one line — the state under the number, the lines of the invoice to the right of them, the sum, the actions at the right
  const wide = await geometry(1440);
  expect(wide.tag.y, "the state is under the number").toBeGreaterThan(wide.num.y + wide.num.height - 2);
  expect(wide.who.x, "who is right of the number").toBeGreaterThan(wide.num.x + wide.num.width);
  expect(wide.amount.x, "the sum is right of the lines").toBeGreaterThanOrEqual(wide.facts.x + wide.facts.width - 1);
  expect(wide.actions.x, "the actions are right of the sum").toBeGreaterThanOrEqual(wide.amount.x + wide.amount.width - 1);
  expect(wide.actions.y, "the actions are on the row's line").toBeLessThan(wide.facts.y + wide.facts.height);
  // a laptop's narrower card: the actions go under the lines, the sum stays beside them
  const mid = await geometry(1180);
  expect(mid.actions.y, "the actions are under the lines").toBeGreaterThanOrEqual(mid.facts.y + mid.facts.height - 1);
  expect(mid.amount.x, "the sum is right of the lines").toBeGreaterThanOrEqual(mid.facts.x + mid.facts.width - 1);
  // the tablet with the top bar: the drawer's stacked row, the sum on the number's line
  const narrow = await geometry(834);
  expect(narrow.row.width).toBeLessThanOrEqual(834);
});

test("the Arved page at 375 × 812: the strip folded, opened and asking, the toolbar and the rows stay inside the screen, every control is 44 px", async ({ page, context, visitorIp, isMobile }, info) => {
  test.skip(!isMobile, "the phone project only");
  giveBack = await holdInvoiceSettings(info);
  const f = await fixtures(info.project.name);
  const payer = f.registration;
  // an unpaid invoice, and a payer with a name that has no place to break, whose payment has no invoice
  await signIn(page, context, visitorIp);
  const { block } = await openDrawer(page, f);
  await block.locator("[data-invoice-create]").click();
  await block.locator("[data-invoice-create-confirm]").click();
  await expect(rowOf(block, "unpaid")).toHaveCount(1);
  const number = (await rowOf(block, "unpaid").locator("strong").first().textContent())!.trim();
  await insertStoredPayment({ email: payer.email, name: "Annabellissimaantonovitšvolkonskaja-Kuuskmäe", kind: "balance", status: "paid", amountCents: 17500, registrationId: payer.id, courseId: f.course.id, method: "paymentInitiation", bank: "Swedbank", paid: true, minutesAgo: 5 });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/admin/arved");
  const main = page.locator("main");
  const outside = () =>
    main.evaluate((el) => {
      const limit = document.documentElement.clientWidth;
      return Array.from(el.querySelectorAll("*"))
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.right > limit + 0.5 || r.left < -0.5);
        })
        .map((e) => `${e.tagName.toLowerCase()} ${(e.textContent ?? "").trim().slice(0, 30)}`);
    });
  const fits = async (what: string) => {
    await expectFits(page, main, `the Arved page, ${what}`);
    expect(await outside(), `${what}: something lies outside the 375 px screen`).toEqual([]);
  };
  const strip = page.locator("section#arveta");
  await expect(strip.getByRole("heading", { level: 2 })).toContainText("Arveta maksed: ");
  await fits("the strip folded");
  await strip.getByRole("button", { name: "Näita ▸" }).click();
  await expect(strip.locator("[data-uninvoiced-payment]").first()).toBeVisible();
  await fits("the strip opened, a long name in it");
  await strip.getByRole("button", { name: /^Koosta \d+ arve/ }).click();
  await expect(strip.locator("[data-confirm-panel]")).toBeVisible();
  await fits("the strip asking");
  await strip.getByRole("button", { name: "Katkesta" }).click();
  // the toolbar: the search, the month, the pills with counts
  await expect(page.getByRole("combobox", { name: "Kuu" })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Otsi nime, e-posti või arve numbri järgi" })).toBeVisible();
  await fits("the toolbar and the rows");
  // the row's „Veel ▾“ opens inside the screen
  const row = page.locator(`[data-invoice="${number}"]`);
  await row.locator("[data-more-menu] > button").click();
  const menu = row.getByRole("menu");
  await expect(menu).toBeVisible();
  const at = (await menu.boundingBox())!;
  expect(at.x).toBeGreaterThanOrEqual(0);
  expect(at.x + at.width).toBeLessThanOrEqual(375);
  // an address that points at the strip (the overview's „Arveta makset“ row) leaves it clear of the sticky phone bar: 64 px high, a gap under it
  await page.keyboard.press("Escape");
  expect(await strip.evaluate((el) => getComputedStyle(el).scrollMarginTop)).toBe("76px");
  await page.evaluate(() => {
    document.body.style.paddingBottom = "3000px"; // (so the page can scroll that far)
    document.querySelector("#arveta")!.scrollIntoView();
  });
  const stripTop = await strip.evaluate((el) => el.getBoundingClientRect().top);
  expect(stripTop, "the strip is under the phone bar, not behind it").toBeGreaterThanOrEqual(64);
});

test("„Arve andmed“ in Seaded: refused without a KMKR number, saved, a new prefix starts at 001, and the sample shows what is typed — and stores nothing", async ({ page, context, visitorIp }, info) => {
  giveBack = await holdInvoiceSettings(info, null);
  await signIn(page, context, visitorIp);
  await page.goto("/admin/seaded");
  const cardBox = page.locator("[data-invoice-settings]");
  await expect(cardBox.getByRole("heading", { level: 2 })).toHaveText("Arve andmed");
  await expect(cardBox.locator('[data-invoice-field="prefix"]')).toHaveValue("MSL");
  await expect(cardBox.locator('[data-invoice-field="nextYear"]')).toHaveCount(0); // (B21: the year is never typed)
  await expect(cardBox).toContainText("Uus eesliide alustab oma numbrit 001-st.");
  // the bank details of Ettemaksu juhised, read-only
  await expect(cardBox.locator("[data-invoice-bank]")).toContainText("EE38 2200 2210 2014 5685");
  await expect(cardBox.locator("[data-invoice-bank] input")).toHaveCount(0);

  const field = (name: string) => cardBox.locator(`[data-invoice-field="${name}"]`);
  await field("company").fill("Näidis Akadeemia OÜ");
  await field("registryCode").fill("87654321");
  await field("address").fill("Pärnu mnt 1, Tallinn");
  await field("vatOn").check();
  await cardBox.locator("[data-invoice-save]").click();
  await expect(cardBox.locator("[data-invoice-status]")).toHaveText("Kontrolli märgitud välju.");
  await expect(cardBox).toContainText("Käibemaksuga arve vajab KMKR numbrit.");
  await expect(field("vatNumber")).toHaveAttribute("aria-invalid", "true");
  expect(await onLocalDb((sql) => sql`select 1 from settings where key = 'invoice'`, { marksPages: false })).toHaveLength(0);

  // the sample: the values on the screen, saved or not, in a new tab's address
  const sample = cardBox.locator("[data-invoice-sample]");
  await expect(sample).toHaveText("Näidisarve (PDF)");
  await expect(sample).toHaveAttribute("target", "_blank");
  await field("vatNumber").fill("EE100200300");
  const href = (await sample.getAttribute("href"))!;
  const pdf = await page.request.get(href);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-disposition"]).toBe('inline; filename="MS-LAB-naidisarve.pdf"');
  expect((await pdf.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(await onLocalDb((sql) => sql`select 1 from settings where key = 'invoice'`, { marksPages: false })).toHaveLength(0); // (nothing stored to draw it)

  // saved
  await cardBox.locator("[data-invoice-save]").click();
  await expect(cardBox.locator("[data-invoice-status]")).toHaveText("Arve andmed on salvestatud.");
  const stored = async () => (await onLocalDb((sql) => sql<{ value: Record<string, unknown> }[]>`select value from settings where key = 'invoice'`, { marksPages: false }))[0]?.value;
  expect(await stored()).toMatchObject({ company: "Näidis Akadeemia OÜ", registryCode: "87654321", vatOn: true, vatNumber: "EE100200300", prefix: "MSL" });
  // a new prefix resets the next number to 1 (ruling R3), whatever number was typed with it
  await field("prefix").fill("abc");
  await field("nextSeq").fill("40");
  await cardBox.locator("[data-invoice-save]").click();
  await expect(cardBox.locator("[data-invoice-status]")).toHaveText("Arve andmed on salvestatud.");
  await expect(field("prefix")).toHaveValue("ABC");
  await expect(field("nextSeq")).toHaveValue("1");
  expect(await stored()).toMatchObject({ prefix: "ABC", nextSeq: 1 });
  expect(await noOverflow(page)).toBe(true);
});

test("without a seller „Koosta arve“ is a link to Seaded → Arve andmed", async ({ page, context, visitorIp }, info) => {
  giveBack = await holdInvoiceSettings(info, null);
  const f = await fixtures(info.project.name);
  await signIn(page, context, visitorIp);
  const { drawer, block } = await openDrawer(page, f);
  await expect(block.locator("[data-invoice-create]")).toHaveCount(0);
  // „Lisa laekumine“ says the same in place of its receipt box (S3-c), with the same link
  await adminReady(page);
  const card = drawer.locator("[data-money-card]");
  await card.locator("[data-add-payment]").click();
  await expect(card.locator("[data-receipt]")).toHaveCount(0);
  await expect(card.locator("[data-receipt-need-seller]")).toHaveText("Kviitungit ei saa koostada: täida Seaded → Arve andmed.");
  await expect(card.locator("[data-receipt-need-seller] a")).toHaveAttribute("href", "/admin/seaded#arve");
  await card.getByRole("button", { name: "Katkesta" }).click();
  const link = block.getByRole("link", { name: "Täida Seaded → Arve andmed" });
  await expect(link).toHaveAttribute("href", "/admin/seaded#arve");
  await link.click();
  await expect(page).toHaveURL(/\/admin\/seaded#arve$/);
  await expect(page.locator("#arve")).toBeVisible();
});

import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { formatDate } from "../../src/i18n/format";
import { clientEmail, insertAccountFixtures } from "./account";
import { adminReady, signInAsAdmin } from "./admin-login";
import { onLocalDb, removeAdminRows, removeClientRows } from "./fixtures";
import { expectFits, holdInvoiceSettings, INVOICE_COMPANY, openDrawer, today, WIDTHS } from "./invoices";
import { runName, studentPage } from "./protocols";
import { expect, submitsForms, test } from "./test";

// Invoices, the whole path in a row (invoices Task 7, spec §1's success): Maria fills „Arve andmed“ and opens the sample, makes a request to pay
// for the 50 % of a registration, the student finds it in her account, Maria sends it and marks it paid (the registration confirms), the student
// downloads the PDF, Maria takes the payment back, cancels the invoice (the student no longer sees it) and finds it in the month's CSV. Maria's
// browser and the student's are two contexts, as they are in life. The three screens an invoice lives on — the registration's „Arved“, the
// „Arved“ page and the course card — are looked at in their four widths with an unpaid invoice on them (no sideways scrolling, 44 px targets).
// It uses no Montonio: an online payment's invoice is Task 4's DB tests (tests/db/payments-invoices.test.ts), the races on real Postgres are
// invoices-race.spec.ts, and each of Maria's screens one by one — receipts, the buyer, the list's filters, „Arveta maksed“, the VAT rule of the
// card — is admin-invoices.spec.ts; the student's card (the bank details, „Maksa" paying THAT invoice, Russian) is account-invoices.spec.ts.
// Local `next dev` has no RESEND_API_KEY, so no mail can be captured; the student's address is a sample (`…@example.test`), which counts as
// sent without a mail (server/invoice-send.ts), and the test asserts the invoice's `sent_at`. The rows are the test's own, a registration of an
// unpublished course with the student's address; the clean-up removes them by that exact address (removeClientRows: invoices, payments,
// registrations, clients), and the seller card and the bank details, which are shared settings, are put back (holdInvoiceSettings).

/** The series of this test: not E2E, which the other invoice specs write under (the account specs with high numbers). */
const PREFIX = "E2EP";

const created = { tokens: new Set<string>(), sessions: new Set<string>() };
const made = new Set<string>();
let giveBack: (() => Promise<void>) | null = null;

test.beforeEach(() => submitsForms());

test.afterEach(async () => {
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
  try {
    for (const email of made) expect(await removeClientRows(email), `the rows of ${email} left`).toBe(0);
  } finally {
    made.clear();
    await giveBack?.();
    giveBack = null;
  }
});

type StoredInvoice = { id: number; number: string; status: string; sentAt: Date | null; dueAt: Date | null; paidAt: Date | null; method: string | null };
/** The only invoice of the test address as stored. */
async function storedInvoice(email: string): Promise<StoredInvoice> {
  const rows = await onLocalDb(
    (sql) =>
      sql<StoredInvoice[]>`
        select id, number, status, sent_at as "sentAt", due_at as "dueAt", paid_at as "paidAt", paid_method as method
          from invoices where buyer->>'email' = ${email}`,
    { marksPages: false },
  );
  expect(rows, "the invoices of the test address").toHaveLength(1);
  return rows[0];
}

test("the whole path: „Arve andmed“, a request to pay, the student's account, the mail, „Märgi tasutuks“, the PDF, „Võta tasumine tagasi“, „Tühista arve“, the month's CSV", async ({ page, context, browser, visitorIp, isMobile }, info) => {
  test.setTimeout(240_000); // (the first view of each page under `next dev` compiles it)
  giveBack = await holdInvoiceSettings(info, null); // Ettemaksu juhised are filled, Arve andmed are not: Maria has not got to them yet
  // the student: a registration at 50 % (group price 350 €), nothing paid, on a course of the test's own
  const email = clientEmail("inv-path", runName(info));
  made.add(email);
  await removeClientRows(email);
  const f = await insertAccountFixtures(email, { name: "Kati Tamm", cards: ["awaiting"] });
  const registration = { id: f.registrations.awaiting!, name: "Kati Tamm" };

  // 1. Maria fills „Arve andmed“ in Seaded and opens „Näidisarve (PDF)“
  await test.step("Maria fills „Arve andmed“ and opens the sample", async () => {
    await signInAsAdmin(page, context, visitorIp, created);
    await page.goto("/admin/seaded");
    await adminReady(page);
    const box = page.locator("[data-invoice-settings]");
    const field = (name: string) => box.locator(`[data-invoice-field="${name}"]`);
    await field("company").fill(INVOICE_COMPANY);
    await field("registryCode").fill("12345678");
    await field("address").fill("Testi 1, Pärnu");
    await field("prefix").fill(PREFIX); // (this test's own series: no other test writes invoices under it, so its first number is 001)
    await box.locator("[data-invoice-save]").click();
    await expect(box.locator("[data-invoice-status]")).toHaveText("Arve andmed on salvestatud.");
    const stored = await onLocalDb((sql) => sql<{ value: Record<string, unknown> }[]>`select value from settings where key = 'invoice'`, { marksPages: false });
    expect(stored[0]?.value).toMatchObject({ company: INVOICE_COMPANY, registryCode: "12345678", prefix: PREFIX, vatOn: false });
    const sample = await page.request.get((await box.locator("[data-invoice-sample]").getAttribute("href"))!);
    expect(sample.status()).toBe(200);
    expect(sample.headers()["content-type"]).toBe("application/pdf");
    expect((await sample.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  // 2–3. the registration (half, nothing paid) → „Koosta arve“ → „Maksmiseks“, 50 %
  const { drawer, block } = await openDrawer(page, { registration });
  await test.step("Maria makes a request to pay for the 50 %", async () => {
    await expect(block.locator("[data-invoices-none]")).toBeVisible();
    await block.locator("[data-invoice-create]").click();
    const form = block.locator("[data-invoice-create-form]");
    await expect(form.locator("label", { hasText: "Ettemaks 50%" })).toContainText("175,00");
    await form.locator('[data-invoice-kind="prepayment"]').check();
    await form.locator('[data-invoice-mode="request"]').check();
    await form.locator("[data-invoice-create-confirm]").click();
    await expect(block.locator("[data-invoice-create-status]")).toContainText("on koostatud.");
  });
  const mine = block.locator('[data-invoice-status="unpaid"]');
  await expect(mine).toHaveCount(1);
  const invoiceId = (await mine.getAttribute("data-invoice-id"))!;
  const row = block.locator(`[data-invoice-id="${invoiceId}"]`); // (by its id from here on: its state changes under the locator)
  const number = (await row.locator("strong").first().textContent())!.trim();
  expect(number).toBe(`${PREFIX}${today().slice(0, 4)}-001`);
  await expect(row.locator("[data-invoice-state]")).toHaveText("Tasumata");
  await expect(row.locator("[data-invoice-amount]")).toContainText("175,00");
  const issued = await storedInvoice(email);
  expect(issued).toMatchObject({ number, status: "unpaid", sentAt: null });

  // 4. the student signs in and sees it: „Tasumata“, the due date, the IBAN
  const student = await studentPage(browser, email, visitorIp);
  try {
    const hers = student.page;
    const card = hers.locator(`[data-card="registration-${registration.id}"]`);
    const line = card.locator("[data-invoice-line]");
    await test.step("the student sees it as „Tasumata“ with the IBAN", async () => {
      await expect(line).toHaveText(`Arve ${number} · 175,00 € · Tasumata · tasu ${formatDate(issued.dueAt!, "et")}`);
      await expect(card.locator("[data-invoice-transfer]")).toContainText("EE38 2200 2210 2014 5685");
    });

    // the three screens at four widths, with the unpaid invoice (every action shown) on them: the phone project is a phone already
    await test.step("the registration's „Arved“, the „Arved“ page and the course card at 390 / 834 / 1194 / 1440", async () => {
      const widths = isMobile ? [page.viewportSize()!.width] : [...WIDTHS];
      const fit = async (p: Page, surface: Locator, what: string) => {
        const before = p.viewportSize()!;
        try {
          for (const width of widths) {
            if (!isMobile) await p.setViewportSize({ width, height: 900 });
            await expectFits(p, surface, what);
          }
        } finally {
          await p.setViewportSize(before);
        }
      };
      await fit(page, block, "the registration's „Arved“");
      // „Koosta arve“ open, as a receipt (the date and the ways of paying show), and „Märgi tasutuks“ open: the fields people touch
      await block.locator("[data-invoice-create]").click();
      await block.locator('[data-invoice-mode="receipt"]').check();
      await expect(block.locator("[data-paid-date]")).toBeVisible();
      await fit(page, block, "„Koosta arve“ in the registration's „Arved“");
      await block.getByRole("button", { name: "Katkesta" }).click();
      await row.locator("[data-invoice-mark-paid]").click();
      await expect(row.locator('[data-invoice-panel="paid"]')).toBeVisible();
      await fit(page, block, "„Märgi tasutuks“ in the registration's „Arved“");
      await row.locator('[data-invoice-panel="paid"]').getByRole("button", { name: "Katkesta" }).click();
      await page.goto("/admin/arved");
      await expect(page.locator(`[data-invoice="${number}"]`)).toBeVisible();
      await fit(page, page.locator("main"), "the „Arved“ page");
      await fit(hers, card, "the course card");
      await openDrawer(page, { registration });
    });

    // 5. „Saada õpilasele“: recorded as sent
    await test.step("Maria sends it to the student", async () => {
      await row.locator("[data-invoice-send]").click();
      const panel = row.locator('[data-invoice-panel="send"]');
      await expect(panel).toContainText(`Kiri läheb aadressile ${email}.`);
      await panel.locator("[data-invoice-send-confirm]").click();
      await expect(row.locator("[data-invoice-status-line]")).toHaveText("Arve on saadetud.");
      await expect(row.locator("[data-invoice-sent]")).toContainText("Saadetud");
      expect((await storedInvoice(email)).sentAt).not.toBeNull();
    });

    // 6. „Märgi tasutuks“: the amount is on the registration and it confirms
    await test.step("Maria marks it paid: the registration confirms", async () => {
      await row.locator("[data-invoice-mark-paid]").click();
      const panel = row.locator('[data-invoice-panel="paid"]');
      await expect(panel.locator("[data-paid-date]")).toHaveValue(today());
      await panel.getByRole("button", { name: "Salvesta tasumine" }).click();
      await expect(row.locator("[data-invoice-status-line]")).toHaveText("Arve on märgitud tasutuks.");
      await expect(row.locator("[data-invoice-state]")).toHaveText("Tasutud");
      await expect(drawer.locator("[data-paid]")).toHaveText("175 €");
      await expect(drawer.locator("[data-reg-status]")).toHaveText("Kinnitatud");
      expect(await storedInvoice(email)).toMatchObject({ status: "paid", method: "bank" });
    });

    // 7. the student downloads the PDF
    await test.step("the student sees „Tasutud“ and downloads the PDF", async () => {
      await hers.reload();
      await expect(line).toHaveText(`Arve ${number} · 175,00 € · Tasutud`);
      await expect(card.locator("[data-invoice-transfer]")).toHaveCount(0);
      const link = card.getByRole("link", { name: "Laadi alla (PDF)" });
      await expect(link).toHaveAttribute("href", `/api/konto/arve/${invoiceId}`);
      const [download] = await Promise.all([hers.waitForEvent("download"), link.click()]);
      expect(download.suggestedFilename()).toBe(`MS-LAB-arve-${number}.pdf`);
      expect(readFileSync((await download.path())!).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    });

    // 8. „Võta tasumine tagasi“: unpaid again, the registration back to awaiting
    await test.step("Maria takes the payment back: unpaid again", async () => {
      await row.locator("[data-invoice-undo]").click();
      await row.locator("[data-invoice-undo-confirm]").click();
      await expect(row.locator("[data-invoice-status-line]")).toHaveText("Arve on jälle tasumata.");
      await expect(row.locator("[data-invoice-state]")).toHaveText("Tasumata");
      await expect(drawer.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");
      expect(await storedInvoice(email)).toMatchObject({ status: "unpaid", paidAt: null, method: null });
      await hers.reload();
      await expect(line).toContainText("Tasumata");
    });

    // 9. „Tühista arve“: hidden from the student, her download a 404
    await test.step("Maria cancels it: the student no longer sees it", async () => {
      await row.locator("[data-invoice-cancel]").click();
      await row.locator("[data-invoice-cancel-confirm]").click();
      await expect(row.locator("[data-invoice-state]")).toHaveText("Tühistatud");
      expect(await storedInvoice(email)).toMatchObject({ status: "cancelled" });
      await hers.reload();
      await expect(card).toBeVisible();
      await expect(line).toHaveCount(0);
      const gone = await hers.request.get(`/api/konto/arve/${invoiceId}`);
      expect([gone.status(), await gone.json()]).toEqual([404, { ok: false }]);
    });
  } finally {
    await student.close();
  }

  // 10. the month's CSV holds the number, cancelled and marked
  await test.step("the month's CSV holds the number", async () => {
    const month = today().slice(0, 7);
    await page.goto(`/admin/arved?kuu=${month}`);
    await expect(page.locator(`[data-invoice="${number}"]`)).toBeVisible();
    const href = (await page.locator("[data-invoices-csv]").getAttribute("href"))!;
    expect(href).toBe(`/api/admin/arved?kuu=${month}`);
    const csv = await page.request.get(href);
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-disposition"]).toBe(`attachment; filename="MS-LAB-arved-${month}.csv"`);
    expect(csv.headers()["cache-control"]).toBe("private, no-store");
    const text = (await csv.body()).toString("utf8");
    const mineInCsv = text.split("\r\n").find((l) => l.startsWith(`"${number}"`));
    expect(mineInCsv, `${number} in the month's CSV`).toBeTruthy();
    expect(mineInCsv).toContain(";Tühistatud;");
  });
});

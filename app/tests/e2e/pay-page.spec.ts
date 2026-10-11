import { clientEmail, insertAccountFixtures } from "./account";
import { removeClientRows, storedPayments, storedPayToken } from "./fixtures";
import { E2E_MONTONIO } from "./montonio-values";
import { submitsForms, test, expect } from "./test";

// The mail's "Maksa" link (phase 2b, spec 6.3): /maksa/<token> shows the course, the amount and "Maksa 175 €" and changes nothing; the button
// goes to the bank. The registration is a sample client's on the test's own unpublished course (tests/e2e/account.ts), so no public seat moves.

test("/maksa/<token>: the page at 390, 834 and 1440 (no overflow, a 44 px button), opening it starts nothing; the button goes to the bank", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("maksa", info.project.name);
  await removeClientRows(email);
  try {
    const f = await insertAccountFixtures(email, { cards: ["awaiting"] });
    const token = await storedPayToken(f.registrations.awaiting!);
    for (const width of [390, 834, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const res = await page.goto(`/maksa/${token}`);
      expect(res?.status()).toBe(200);
      expect(res?.headers()["cache-control"]).toBe("no-store");
      expect(res?.headers()["referrer-policy"]).toBe("same-origin");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Koolituse eest tasumine");
      await expect(page.getByText("Kulmude lamineerimine")).toBeVisible();
      await expect(page.getByText("Summa: 175 €")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), String(width)).toBe(true);
      expect((await page.getByRole("button", { name: "Maksa 175 €" }).boundingBox())!.height, String(width)).toBeGreaterThanOrEqual(44);
    }
    expect(await storedPayments(email)).toEqual([]);
    await page.getByRole("button", { name: "Maksa 175 €" }).click();
    await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
    await page.getByRole("button", { name: "Katkesta" }).click();
    await page.waitForURL(/\/makse#tulemus=katkestatud/);
    await expect(page.getByRole("link", { name: "Proovi uuesti" })).toHaveAttribute("href", `/maksa/${token}`);
    await expect.poll(() => storedPayments(email)).toEqual([{ kind: "prepayment", status: "failed", amountCents: 17500 }]);
  } finally {
    await removeClientRows(email);
  }
});

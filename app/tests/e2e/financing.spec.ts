import type { Page, TestInfo } from "@playwright/test";
import { clientEmail, holdTerms, storedAccess } from "./account";
import { onLocalDb, removeClientRows, storedPayments, storedRegistrations } from "./fixtures";
import { setFinancing, takeFinancing } from "./financing";
import { E2E_MONTONIO } from "./montonio-values";
import { revalidateLocalPages } from "./prod-build";
import { LOCAL_URL, TARGET } from "./target";
import { submitsForms, test, expect } from "./test";

// Järelmaks (Inbank) end to end (instalments, Task 6) against the e2e run's fake Montonio (tests/e2e/fake-montonio.ts: a hirePurchase order is
// „Inbank (test)“ with „Kinnita laen“, the loan signed, and „Inbank keeldus“, which leaves the order PENDING with no webhook, as Montonio keeps a
// declined or abandoned järelmaks for 7 days). The toggle of Seaded is switched on for the length of each test (financing.ts: one shared setting,
// so the tests take turns), and every payer is a sample address (`e2e-client-fin-…@example.test`, never mailed) whose rows are removed after each
// test, so the seat of the seed session the paid registrations take (Kulmumeistri baaskoolitus, Tallinn, as payments.spec.ts does) is free again.
// Both projects run it: the phone project's 390 px is the width at which the choice must be reachable, and one test checks that width on the desktop too.

const APP = new URL(TARGET || LOCAL_URL);
const COURSE = "/koolitused/kulmumeistri-baaskoolitus";
const ECOURSE = "kulmumeistri-e-koolitus";
const made = new Set<string>();
let touchedPublicCourse = false;

test.beforeEach(() => {
  submitsForms();
  test.setTimeout(150_000); // (the first view of each page under `next dev` compiles it)
});
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
  if (touchedPublicCourse) revalidateLocalPages(); // (a registration on the seed course was removed behind the app's back: its seat is free again)
  touchedPublicCourse = false;
});

/** A fresh payer address for this test (its leftovers removed first); one per project, and per repeat of a --repeat-each run, which run side by side. */
async function fresh(label: string, info: TestInfo): Promise<string> {
  const email = clientEmail(`fin-${label}`, `${info.project.name}${info.repeatEachIndex ? `-r${info.repeatEachIndex}` : ""}`);
  made.add(email);
  await removeClientRows(email);
  return email;
}

/** The group registration form of the open course page: a date in Tallinn, the payer, the payment choice, the contract's box; "Registreeru". */
async function register(page: Page, email: string, choice: RegExp): Promise<void> {
  touchedPublicCourse = true;
  await page.getByRole("radio", { name: /Grupikoolitus/ }).check();
  await page.locator("[data-session]:not([aria-disabled='true'])").filter({ hasText: "Tallinn" }).first().click();
  await page.getByLabel("Nimi").fill("Test Maksja");
  await page.getByLabel("E-post", { exact: true }).fill(email);
  await page.getByLabel("Telefon").fill("+3725555555");
  await page.getByRole("radio", { name: choice }).check();
  await page.getByLabel(/tingimustega/).check();
  await page.getByRole("button", { name: "Registreeru" }).click();
}

/** Waits until the payer has left the app and stops the test unless she is at the fake Montonio (never another site: nothing is pressed there). */
async function reachFake(page: Page): Promise<void> {
  await page.waitForURL((url) => url.origin !== APP.origin);
  const at = new URL(page.url());
  expect(`${at.origin}${at.pathname.startsWith("/pay/") ? "/pay/" : at.pathname}`, "where the payer was sent: the fake Montonio is expected").toBe(`${E2E_MONTONIO.url}/pay/`);
}
/** At Inbank's page of the fake: the heading says so; the order's amount is shown. */
async function atInbank(page: Page, amount: string): Promise<void> {
  await reachFake(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Inbank (test)");
  await expect(page.locator("[data-fake-order]")).toContainText(amount);
}
/** At the bank's page of the fake. */
async function atBank(page: Page, amount: string): Promise<void> {
  await reachFake(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Testpank");
  await expect(page.locator("[data-fake-order]")).toContainText(amount);
}

type Row = { kind: string; status: string; method: string; amountCents: number };
/** The online payments of one test address, oldest first, with the way each was started. */
const payments = (email: string) =>
  onLocalDb((sql) => sql<Row[]>`select kind, status, method, amount_cents as "amountCents" from payments where email = ${email} order by id`, { marksPages: false });
const references = (email: string) => onLocalDb((sql) => sql<{ reference: string }[]>`select reference from payments where email = ${email} order by id`, { marksPages: false });

/** The fake Montonio's own record of an order, by the app's reference: what the app sent. */
async function fakeOrder(reference: string): Promise<{ status: string; method: string; expiresIn?: number; billingAddress?: Record<string, unknown> }> {
  const res = await fetch(`${E2E_MONTONIO.url}/_fake/orders/${reference}`);
  expect(res.status, `the fake Montonio knows ${reference}`).toBe(200);
  return (await res.json()) as { status: string; method: string; expiresIn?: number; billingAddress?: Record<string, unknown> };
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("a group registration with Järelmaks (Inbank): the quiet line, the third choice, Inbank's page, „Kinnita laen“: paid in full, the place confirmed", async ({ page }, info) => {
  const email = await fresh("paid", info);
  const release = await takeFinancing(info, true);
  try {
    await page.goto(COURSE);
    await expect(page.locator("[data-financing-line]")).toHaveText("Võimalik tasuda ka järelmaksuga (Inbank).");
    const form = page.locator("[data-register-form]");
    await page.getByRole("radio", { name: /Grupikoolitus/ }).check();
    await expect(form.locator("input[name='payment']")).toHaveCount(3); // 100%, 50% and Järelmaks (Inbank)
    await expect(form.getByRole("radio", { name: "Järelmaks (Inbank)" })).toBeEnabled();
    await expect(form.locator("[data-pay-instalment]")).toHaveCount(0);
    await register(page, email, /Järelmaks \(Inbank\)/);
    await atInbank(page, "350.00 EUR");
    // what the app sent: the loan method, 60 minutes, her name, e-mail and (an Estonian) phone for Inbank's own form
    const order = await fakeOrder((await references(email))[0].reference);
    expect(order).toMatchObject({ method: "hirePurchase", expiresIn: 60, status: "PENDING" });
    expect(order.billingAddress).toEqual({ firstName: "Test", lastName: "Maksja", email, phoneNumber: "5555555", phoneCountry: "372" });
    await page.getByRole("button", { name: "Kinnita laen" }).click();
    await page.waitForURL(/\/makse#tulemus=makstud&liik=registreering$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse õnnestus. Saatsime sulle kinnituse e-postiga.");
    await expect.poll(() => payments(email)).toEqual([{ kind: "prepayment", status: "paid", method: "hirePurchase", amountCents: 35000 }]);
    expect(await storedRegistrations(email)).toEqual([expect.objectContaining({ status: "confirmed", paidCents: 35000, paymentChoice: "financing" })]);
  } finally {
    await release();
  }
});

test("Inbank says no: the order stays pending, the return says so with „Maksa pangalingiga“ and „Proovi uuesti“; Inbank again is the same open order; the bank then pays and confirms the place", async ({ page }, info) => {
  const email = await fresh("declined", info);
  const release = await takeFinancing(info, true);
  try {
    await page.goto(COURSE);
    await register(page, email, /Järelmaks \(Inbank\)/);
    await atInbank(page, "350.00 EUR");
    await page.getByRole("button", { name: "Inbank keeldus" }).click();
    await page.waitForURL(/\/makse#tulemus=pooleli&liik=jarelmaks&maksa=/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Järelmaksu taotlus on pooleli või jäi lõpetamata. Kui Inbank selle kinnitab, saadame sulle kinnituse.");
    await expect(page.getByText("Kui pank selle kinnitab")).toHaveCount(0);
    const bank = page.getByRole("button", { name: "Maksa pangalingiga" });
    const again = page.getByRole("button", { name: "Proovi uuesti" });
    for (const width of [390, 834, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await noOverflow(page), String(width)).toBe(true);
      for (const button of [bank, again]) expect((await button.boundingBox())!.height, `${width} px`).toBeGreaterThanOrEqual(44);
    }
    expect(await payments(email)).toEqual([{ kind: "prepayment", status: "pending", method: "hirePurchase", amountCents: 35000 }]);
    // „Proovi uuesti“: Inbank again — the open order is sent again, never a second loan
    await again.click();
    await atInbank(page, "350.00 EUR");
    expect(await payments(email)).toHaveLength(1);
    await page.getByRole("button", { name: "Inbank keeldus" }).click();
    await page.waitForURL(/\/makse#tulemus=pooleli&liik=jarelmaks&maksa=/);
    // „Maksa pangalingiga“: a new attempt by bank, for the whole price; the pending loan is left as it is
    await page.getByRole("button", { name: "Maksa pangalingiga" }).click();
    await atBank(page, "350.00 EUR");
    await page.getByRole("button", { name: "Makstud" }).click();
    await page.waitForURL(/\/makse#tulemus=makstud&liik=registreering$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse õnnestus. Saatsime sulle kinnituse e-postiga.");
    await expect.poll(() => payments(email)).toEqual([
      { kind: "prepayment", status: "pending", method: "hirePurchase", amountCents: 35000 },
      { kind: "prepayment", status: "paid", method: "paymentInitiation", amountCents: 35000 },
    ]);
    expect(await storedRegistrations(email)).toEqual([expect.objectContaining({ status: "confirmed", paidCents: 35000, paymentChoice: "financing" })]);
  } finally {
    await release();
  }
});

test("an e-course in the cart: „Pangalink“ and „Järelmaks (Inbank)“; the järelmaks signed at Inbank: paid, the course is hers", async ({ page }, info) => {
  const email = await fresh("cart", info);
  const release = await takeFinancing(info, true);
  const releaseTerms = await holdTerms(); // the cart's contract is the e-course terms: no test of them saves other ones while this one buys (R6)
  try {
    await page.goto(`/ostukorv?kursus=${ECOURSE}`);
    const form = page.locator("[data-ecourse-form]");
    await expect(form.locator("fieldset label")).toHaveText(["Pangalink", "Järelmaks (Inbank)"]);
    await expect(form.getByRole("radio", { name: "Pangalink" })).toBeChecked();
    await form.getByLabel("Nimi").fill("Test Ostja");
    await form.getByLabel("E-post").fill(email);
    await form.getByRole("radio", { name: "Järelmaks (Inbank)" }).check();
    await form.getByLabel(/tingimustega/).check();
    await form.getByRole("button", { name: "Maksa 190 €" }).click();
    await atInbank(page, "190.00 EUR");
    const order = await fakeOrder((await references(email))[0].reference);
    expect(order).toMatchObject({ method: "hirePurchase", expiresIn: 60 });
    expect(order.billingAddress).toEqual({ firstName: "Test", lastName: "Ostja", email }); // (no phone is asked in the cart)
    await page.getByRole("button", { name: "Kinnita laen" }).click();
    await page.waitForURL(/\/makse#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse õnnestus.");
    await expect(page.getByRole("link", { name: "Ava e-koolitus" })).toHaveAttribute("href", `/konto/kursus/${ECOURSE}`);
    await expect.poll(() => payments(email)).toEqual([{ kind: "ecourse", status: "paid", method: "hirePurchase", amountCents: 19000 }]);
    expect(await storedAccess(email, ECOURSE)).toMatchObject({ grantedBy: "payment", revoked: false });
  } finally {
    await releaseTerms();
    await release();
  }
});

test("an e-course's järelmaks that Inbank turned down: the return says so, „Maksa pangalingiga“ is the cart, „Proovi uuesti“ the cart with Järelmaks (Inbank) chosen", async ({ page }, info) => {
  const email = await fresh("cartno", info);
  const release = await takeFinancing(info, true);
  const releaseTerms = await holdTerms();
  try {
    await page.goto(`/ostukorv?kursus=${ECOURSE}`);
    const form = page.locator("[data-ecourse-form]");
    await form.getByLabel("Nimi").fill("Test Ostja");
    await form.getByLabel("E-post").fill(email);
    await form.getByRole("radio", { name: "Järelmaks (Inbank)" }).check();
    await form.getByLabel(/tingimustega/).check();
    await form.getByRole("button", { name: "Maksa 190 €" }).click();
    await atInbank(page, "190.00 EUR");
    await page.getByRole("button", { name: "Inbank keeldus" }).click();
    await page.waitForURL(/\/makse#tulemus=pooleli&liik=jarelmaks&kursus=kulmumeistri-e-koolitus$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Järelmaksu taotlus on pooleli või jäi lõpetamata. Kui Inbank selle kinnitab, saadame sulle kinnituse.");
    await expect(page.getByRole("link", { name: "Maksa pangalingiga" })).toHaveAttribute("href", `/ostukorv?kursus=${ECOURSE}`);
    await page.getByRole("link", { name: "Proovi uuesti" }).click();
    await expect(page).toHaveURL(`/ostukorv?kursus=${ECOURSE}&makse=jarelmaks`);
    await expect(page.locator("[data-ecourse-form]").getByRole("radio", { name: "Järelmaks (Inbank)" })).toBeChecked();
    // and the bank link from the same result page is the cart as it opens
    await page.goBack();
    await page.getByRole("link", { name: "Maksa pangalingiga" }).click();
    await expect(page.locator("[data-ecourse-form]").getByRole("radio", { name: "Pangalink" })).toBeChecked();
    expect(await payments(email)).toEqual([{ kind: "ecourse", status: "pending", method: "hirePurchase", amountCents: 19000 }]);
  } finally {
    await releaseTerms();
    await release();
  }
});

test("the choice is reachable at 390 px: a tap target of 44 px inside the screen, nothing overflows, and tapping it chooses it", async ({ page }, info) => {
  const release = await takeFinancing(info, true);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(COURSE);
    await page.getByRole("radio", { name: /Grupikoolitus/ }).check();
    const loan = page.locator("label").filter({ has: page.getByRole("radio", { name: "Järelmaks (Inbank)" }) });
    await loan.scrollIntoViewIfNeeded();
    await expect(loan).toBeVisible();
    const box = (await loan.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await loan.click();
    await expect(page.getByRole("radio", { name: "Järelmaks (Inbank)" })).toBeChecked();
    expect(await noOverflow(page)).toBe(true);
    await expect(page.locator("[data-financing-line]")).toBeVisible();
    // the cart's choice, too
    const releaseTerms = await holdTerms();
    try {
      await page.goto(`/ostukorv?kursus=${ECOURSE}`);
      const cartLoan = page.locator("[data-ecourse-form] label").filter({ has: page.getByRole("radio", { name: "Järelmaks (Inbank)" }) });
      await expect(cartLoan).toBeVisible();
      expect((await cartLoan.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await noOverflow(page)).toBe(true);
    } finally {
      await releaseTerms();
    }
  } finally {
    await release();
  }
});

test("the e-course page: the quiet line next to the price, no placeholder; Russian too", async ({ page }, info) => {
  const release = await takeFinancing(info, true);
  try {
    await page.goto(`/koolitused/${ECOURSE}`);
    const buy = page.locator("[data-buy]");
    await expect(buy.locator("[data-financing-line]")).toHaveText("Võimalik tasuda ka järelmaksuga (Inbank).");
    await expect(buy).not.toContainText("tulekul");
    await expect(buy.getByRole("radio")).toHaveCount(1); // (the cart has the choice, not the page)
    await expect(buy.getByRole("link", { name: "Osta kohe" })).toHaveAttribute("href", `/ostukorv?kursus=${ECOURSE}`);
    await page.goto(`/ru/koolitused/${ECOURSE}`);
    await expect(page.locator("[data-buy] [data-financing-line]")).toHaveText("Можно оплатить и в рассрочку (Inbank).");
    await page.goto(COURSE.replace("/koolitused", "/ru/koolitused"));
    await page.getByRole("radio", { name: /Групповое обучение/ }).check();
    await expect(page.locator("[data-financing-line]")).toHaveText("Можно оплатить и в рассрочку (Inbank).");
    await expect(page.getByRole("radio", { name: "Рассрочка (Inbank)" })).toBeEnabled();
  } finally {
    await release();
  }
});

test("switched off: no line, no third choice, no choice in the cart — the pages are as they were, without the old placeholders", async ({ page }, info) => {
  const release = await takeFinancing(info, false);
  const releaseTerms = await holdTerms();
  try {
    await page.goto(COURSE);
    await page.getByRole("radio", { name: /Grupikoolitus/ }).check();
    const form = page.locator("[data-register-form]");
    await expect(form.locator("input[name='payment']")).toHaveCount(2);
    await expect(page.locator("[data-financing-line]")).toHaveCount(0);
    await expect(form.getByText(/järelmaks/i)).toHaveCount(0);
    await page.goto(`/koolitused/${ECOURSE}`);
    await expect(page.locator("[data-buy]")).toBeVisible();
    await expect(page.locator("[data-financing-line]")).toHaveCount(0);
    await expect(page.locator("[data-buy]").getByText(/järelmaks/i)).toHaveCount(0);
    await page.goto(`/ostukorv?kursus=${ECOURSE}`);
    await expect(page.locator("[data-ecourse-form]")).toBeVisible();
    await expect(page.locator("[data-ecourse-form] input[name='method']")).toHaveCount(0);
    await expect(page.locator("[data-cart-summary]").getByText(/järelmaks/i)).toHaveCount(0);
  } finally {
    await releaseTerms();
    await release();
  }
});

test("switched off after the page was loaded: the registration stands, awaiting payment, and she is told what Järelmaks needs; nothing was started", async ({ page }, info) => {
  const email = await fresh("refused", info);
  const release = await takeFinancing(info, true);
  try {
    await page.goto(COURSE);
    await expect(page.locator("[data-financing-line]")).toBeVisible();
    await setFinancing(false); // Maria switches it off while the page is open (the page is a few minutes old, as a cached one is)
    await register(page, email, /Järelmaks \(Inbank\)/);
    const done = page.locator("[data-register-sent]");
    await expect(done.locator("[data-financing-refused]")).toHaveText("Järelmaks on võimalik 100–5000 € hinnaga koolitusele.");
    await expect(done).toContainText("Registreerimine on vastu võetud.");
    await expect(page.locator("[data-register-form]")).toHaveCount(0);
    expect(await storedRegistrations(email)).toEqual([expect.objectContaining({ status: "awaiting_prepayment", paidCents: 0, paymentChoice: "financing" })]);
    expect(await storedPayments(email)).toEqual([]); // (no order was made at Montonio)
    await expect(page).toHaveURL(new RegExp(`${COURSE}$`)); // and the browser did not leave
  } finally {
    await release();
  }
});

test("switched off after the cart was loaded: the range is said at the choice, the bank link is chosen, and pressing again pays by bank", async ({ page }, info) => {
  const email = await fresh("cartrefused", info);
  const release = await takeFinancing(info, true);
  const releaseTerms = await holdTerms();
  try {
    await page.goto(`/ostukorv?kursus=${ECOURSE}`);
    const form = page.locator("[data-ecourse-form]");
    await form.getByLabel("Nimi").fill("Test Ostja");
    await form.getByLabel("E-post").fill(email);
    await form.getByRole("radio", { name: "Järelmaks (Inbank)" }).check();
    await form.getByLabel(/tingimustega/).check();
    await setFinancing(false);
    await form.getByRole("button", { name: "Maksa 190 €" }).click();
    await expect(form.locator("[data-financing-range]")).toHaveText("Järelmaks on võimalik 100–5000 € hinnaga koolitusele.");
    await expect(form.getByRole("radio", { name: "Pangalink" })).toBeChecked();
    expect(await storedPayments(email)).toEqual([]);
    await form.getByRole("button", { name: "Maksa 190 €" }).click();
    await atBank(page, "190.00 EUR");
    await page.getByRole("button", { name: "Katkesta" }).click();
    await page.waitForURL(/\/makse#tulemus=katkestatud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus$/);
    expect(await payments(email)).toEqual([{ kind: "ecourse", status: "failed", method: "paymentInitiation", amountCents: 19000 }]);
  } finally {
    await releaseTerms();
    await release();
  }
});

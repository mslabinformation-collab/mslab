import type { Page, Request, TestInfo } from "@playwright/test";
import { clientEmail, holdTerms, insertAccountFixtures, signInAsClient, storedAccess, storedClient } from "./account";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { insertStoredPayment, onLocalDb, removeAdminRows, removeClientRows, storedPayments, storedPayToken, storedRegistrations } from "./fixtures";
import { ECOURSE_BUY_LOCK_CLASS } from "../../src/server/payments/start";
import { E2E_MONTONIO } from "./montonio-values";
import { revalidateLocalPages } from "./prod-build";
import { LOCAL_URL, TARGET } from "./target";
import { submitsForms, test, expect } from "./test";

// Phase 2b (spec 12): the online payments end to end against the e2e run's fake Montonio (tests/e2e/fake-montonio.ts: PAYMENT_PROVIDER=mock,
// the app's real client, signed tokens, the webhook). Every payer is a sample address (`e2e-client-pay-…@example.test`, never mailed) whose
// rows — registrations, payments, the client — are removed after each test (fixtures.ts removeClientRows). A paid group registration takes a
// real seat of a seed session (Kulmumeistri baaskoolitus, Tallinn, 6 seats) for the length of the test; no other spec counts that session's
// seats, and the row is removed after the test (and the cached pages of a production build are marked stale, so the seat is given back there too).
// Three tests prove on the local Postgres what the unit tests' single-connection PGlite cannot: the once-only work under four webhooks of one
// token at the same moment, and one pending payment under eight starts of the same e-course purchase at the same moment. The race alone does
// not always overlap (with the lock removed, eight racers still missed it in one run in five), so the lock has a test that never misses: another
// connection holds the purchase's advisory lock and a start must wait for it.

const APP = new URL(TARGET || LOCAL_URL);
const made = new Set<string>();
const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
let touchedPublicCourse = false;

test.beforeEach(() => {
  submitsForms();
  test.setTimeout(120_000); // (the first view of each page under `next dev` compiles it)
});
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
  if (touchedPublicCourse) revalidateLocalPages(); // (a registration on the seed course was removed behind the app's back: its seat is free again)
  touchedPublicCourse = false;
});

/** A fresh payer address for this test (its leftovers removed first); one per project, and per repeat of a --repeat-each run, which run side by side. */
async function fresh(label: string, info: TestInfo): Promise<string> {
  const email = clientEmail(`pay-${label}`, `${info.project.name}${info.repeatEachIndex ? `-r${info.repeatEachIndex}` : ""}`);
  made.add(email);
  await removeClientRows(email);
  return email;
}

/** The group registration form of the open course page: a date in `city`, the payer, the payment choice, the terms; "Registreeru". */
async function register(page: Page, email: string, choice: "100%" | "50%", city: string): Promise<void> {
  touchedPublicCourse = true;
  await page.getByRole("radio", { name: /Grupikoolitus/ }).check();
  await page.locator("[data-session]:not([aria-disabled='true'])").filter({ hasText: city }).first().click();
  await page.getByLabel("Nimi").fill("Test Maksja");
  await page.getByLabel("E-post", { exact: true }).fill(email);
  await page.getByLabel("Telefon").fill("+3725555555");
  await page.getByRole("radio", { name: new RegExp(choice) }).check();
  await page.getByLabel(/tingimustega/).check();
  await page.getByRole("button", { name: "Registreeru" }).click();
}

/**
 * Waits until the payer has left the app, and stops the test unless she is at the fake bank (tests/e2e/fake-montonio.ts) — never on another
 * site: if the app were talking to the real Montonio sandbox (a dev server of your own that was reused), nothing is pressed there.
 * (Global setup refuses such a server before any test: montonio-guard.ts; this is the second line.)
 */
async function reachBank(page: Page): Promise<void> {
  await page.waitForURL((url) => url.origin !== APP.origin);
  const at = new URL(page.url());
  expect(`${at.origin}${at.pathname.startsWith("/pay/") ? "/pay/" : at.pathname}`, "where the payer was sent: the fake Montonio is expected, so this run is not on it").toBe(`${E2E_MONTONIO.url}/pay/`);
}

/** At the fake bank: one of its three outcomes. */
async function atBank(page: Page, outcome: "Makstud" | "Pooleli" | "Katkesta"): Promise<void> {
  await reachBank(page);
  await page.getByRole("button", { name: outcome }).click();
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** The reference (MSLAB-L<id>: this machine's prefix) of the payer's only payment row. */
async function onlyReference(email: string): Promise<string> {
  const rows = await onLocalDb((sql) => sql<{ reference: string }[]>`select reference from payments where email = ${email}`, { marksPages: false });
  expect(rows).toHaveLength(1);
  return rows[0].reference;
}

/** The fake bank's own record of an order, by the app's reference. */
async function fakeOrder(reference: string): Promise<{ uuid: string; status: string; grandTotal: number }> {
  const res = await fetch(`${E2E_MONTONIO.url}/_fake/orders/${reference}`);
  expect(res.status, `the fake bank knows ${reference}`).toBe(200);
  return (await res.json()) as { uuid: string; status: string; grandTotal: number };
}

test("a group registration paid at the bank: confirmed, the rest offered on her card; the rest paid: fully paid (spec 6.1, 6.2, D5)", async ({ page }, info) => {
  const email = await fresh("reg", info);
  await page.goto("/koolitused/kulmumeistri-baaskoolitus");
  await register(page, email, "50%", "Tallinn");
  await atBank(page, "Makstud");
  await page.waitForURL(/\/makse#tulemus=makstud&liik=registreering$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse õnnestus. Saatsime sulle kinnituse e-postiga.");
  await expect.poll(() => storedPayments(email)).toEqual([{ kind: "prepayment", status: "paid", amountCents: 17500 }]);

  await signInAsClient(page, email);
  const card = page.locator("[data-card^='registration-']");
  await expect(card.locator("[data-next-step]")).toHaveText("Koht on kinnitatud. Ülejäänud 175 € tasud koolituspäeval.");
  await card.getByRole("button", { name: "Maksa ülejäänud 175 €" }).click();
  await atBank(page, "Makstud");
  await page.waitForURL(/\/makse#tulemus=makstud/);
  await page.goto("/konto");
  await expect(card.locator("[data-next-step]")).toHaveText("Koht on kinnitatud.");
  await expect(card.getByRole("button", { name: /Maksa/ })).toHaveCount(0); // nothing left to pay
  expect(await storedRegistrations(email)).toEqual([expect.objectContaining({ status: "confirmed", paidCents: 35000, paymentChoice: "half" })]);
  expect(await storedPayments(email)).toEqual([
    { kind: "prepayment", status: "paid", amountCents: 17500 },
    { kind: "balance", status: "paid", amountCents: 17500 },
  ]);
});

test("cancelled at the bank: 'Makse jäi tegemata.' and 'Proovi uuesti' (the /maksa page) → paid; the result page fits 390, 834 and 1440", async ({ page }, info) => {
  const email = await fresh("retry", info);
  await page.goto("/koolitused/kulmumeistri-baaskoolitus");
  await register(page, email, "50%", "Tallinn");
  await atBank(page, "Katkesta");
  await page.waitForURL(/\/makse#tulemus=katkestatud&liik=registreering&maksa=/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse jäi tegemata.");
  const retry = page.getByRole("link", { name: "Proovi uuesti" });
  for (const width of [390, 834, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await noOverflow(page), String(width)).toBe(true);
    expect((await retry.boundingBox())!.height, String(width)).toBeGreaterThanOrEqual(44);
  }
  await retry.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Koolituse eest tasumine");
  await page.getByRole("button", { name: "Maksa 175 €" }).click();
  await atBank(page, "Makstud");
  await page.waitForURL(/\/makse#tulemus=makstud/);
  await expect.poll(() => storedPayments(email)).toEqual([
    { kind: "prepayment", status: "failed", amountCents: 17500 },
    { kind: "prepayment", status: "paid", amountCents: 17500 },
  ]);
  expect(await storedRegistrations(email)).toEqual([expect.objectContaining({ status: "confirmed", paidCents: 17500 })]);
});

test("pending at the bank: 'Makse on pooleli'; the bank confirms later (Montonio's webhook): paid", async ({ page }, info) => {
  const email = await fresh("pending", info);
  const f = await insertAccountFixtures(email, { cards: ["awaiting"] });
  await page.goto(`/maksa/${await storedPayToken(f.registrations.awaiting!)}`);
  await page.getByRole("button", { name: "Maksa 175 €" }).click();
  await atBank(page, "Pooleli");
  await page.waitForURL(/\/makse#tulemus=pooleli&liik=registreering&maksa=/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse on pooleli. Kui pank selle kinnitab, saadame sulle kinnituse.");
  await expect(page.getByRole("link", { name: "Proovi uuesti" })).toBeVisible(); // (a pending one may still be tried again: the open order is sent again)
  expect(await storedPayments(email)).toEqual([{ kind: "prepayment", status: "pending", amountCents: 17500 }]);
  const order = await fakeOrder(await onlyReference(email));
  expect(order.status).toBe("PENDING");
  // the bank decides later: the fake sends the webhook, no browser involved
  expect((await fetch(`${E2E_MONTONIO.url}/_fake/settle/${order.uuid}`, { method: "POST", body: JSON.stringify({ status: "PAID" }) })).status).toBe(200);
  await expect.poll(() => storedPayments(email)).toEqual([{ kind: "prepayment", status: "paid", amountCents: 17500 }]);
  expect(await storedRegistrations(email)).toEqual([expect.objectContaining({ status: "confirmed", paidCents: 17500 })]);
});

test("a refund in Montonio's Partner System: its refund notice ({ refundToken }) is asked about at Montonio and marks the paid payment refunded; a forged one is 400", async ({ page }, info) => {
  const email = await fresh("refund", info);
  const f = await insertAccountFixtures(email, { cards: ["awaiting"] });
  await page.goto(`/maksa/${await storedPayToken(f.registrations.awaiting!)}`);
  await page.getByRole("button", { name: "Maksa 175 €" }).click();
  await atBank(page, "Makstud");
  await page.waitForURL(/\/makse#tulemus=makstud/);
  await expect.poll(() => storedPayments(email)).toEqual([{ kind: "prepayment", status: "paid", amountCents: 17500 }]);
  const order = await fakeOrder(await onlyReference(email));
  // Maria refunds in the Partner System: the order reads REFUNDED at Montonio, and the refund notice is what Montonio would send
  const refunded = await fetch(`${E2E_MONTONIO.url}/_fake/refund/${order.uuid}`, { method: "POST", body: "{}" });
  expect(refunded.status).toBe(200);
  const { refundToken } = (await refunded.json()) as { refundToken: string };
  const hook = new URL("/api/payments/notify", APP);
  const send = (body: unknown) => fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const [head, claims] = refundToken.split(".");
  expect((await send({ refundToken: `${head}.${claims}.forged` })).status).toBe(400);
  expect(await storedPayments(email)).toEqual([{ kind: "prepayment", status: "paid", amountCents: 17500 }]);
  expect((await send({ refundToken })).status).toBe(200);
  expect(await storedPayments(email)).toEqual([{ kind: "prepayment", status: "refunded", amountCents: 17500 }]);
  expect((await send({ refundToken })).status).toBe(200); // Montonio's retry: still 200, nothing new
  expect(await storedRegistrations(email)).toEqual([expect.objectContaining({ status: "confirmed", paidCents: 17500 })]); // Maria adjusts it herself
});

test("an e-course bought from the cart: paid → 'Ava e-koolitus'; the access is hers, opened by the payment, and her card offers it (spec 6.4)", async ({ page }, info) => {
  // the cart's contract is the e-course terms: no test of the terms saves other ones while this one buys (R6)
  const release = await holdTerms();
  try {
    const email = await fresh("ecourse", info);
    await page.goto("/ostukorv?kursus=kulmumeistri-e-koolitus");
    const form = page.locator("[data-ecourse-form]");
    await form.getByLabel("Nimi").fill("Test Ostja");
    await form.getByLabel("E-post").fill(email);
    await form.getByLabel(/tingimustega/).check();
    await form.getByRole("button", { name: "Maksa 190 €" }).click();
    await atBank(page, "Makstud");
    await page.waitForURL(/\/makse#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse õnnestus.");
    // she is not signed in by buying: her login link is in the mail (task 6)
    await expect(page.getByText("Saatsime sulle e-postiga sisselogimislingi.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Ava e-koolitus" })).toHaveAttribute("href", "/konto/kursus/kulmumeistri-e-koolitus");
    await expect.poll(() => storedPayments(email)).toEqual([{ kind: "ecourse", status: "paid", amountCents: 19000 }]);
    expect(await storedClient(email)).toMatchObject({ name: "Test Ostja", locale: "et" });
    expect(await storedAccess(email, "kulmumeistri-e-koolitus")).toMatchObject({ grantedBy: "payment", revoked: false });
    expect((await page.context().cookies()).some((c) => c.name === "__Host-mslab_client")).toBe(false);

    await signInAsClient(page, email);
    const open = page.locator("[data-card='course-kulmumeistri-e-koolitus'] [data-card-action='open']");
    await expect(open).toBeVisible();
    await expect(open).toHaveText("Ava koolitus");
  } finally {
    await release();
  }
});

test("the admin's Maksed: tabs, search, pills with counts, the row link, „Montonios ↗“, 'Kontrolli Montonios' on a held payment; the registration's drawer lists its payments (spec 8, A6)", async ({ page, context, visitorIp }, info) => {
  const email = await fresh("admin", info);
  const f = await insertAccountFixtures(email, { cards: ["awaiting"], name: "E2E Maksja" });
  const regId = f.registrations.awaiting!;
  const own = { email, name: "E2E Maksja", registrationId: regId, courseId: f.course.id, clientId: f.clientId, amountCents: 17500, method: "paymentInitiation", bank: "Testpank" };
  const paid = await insertStoredPayment({ ...own, kind: "prepayment", status: "paid", paid: true, minutesAgo: 5 });
  const held = await insertStoredPayment({ ...own, kind: "balance", status: "held" });
  await signInAsAdmin(page, context, visitorIp, created);
  // (this payer's rows only, found by the search; the pills count what the search finds)
  await page.goto(`/admin/maksed?otsi=${encodeURIComponent(email)}`);
  await expect(page.locator("aside [data-nav='payments']")).toHaveAttribute("aria-current", "page"); // (a phone has it in the menu drawer)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Maksed ja arved");
  const tabs = page.getByRole("navigation", { name: "Maksed ja arved" });
  await expect(tabs.getByRole("link")).toHaveText(["Maksed", "Arved"]);
  await expect(tabs.getByRole("link", { name: "Maksed" })).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("link", { name: "Arved" })).toHaveAttribute("href", "/admin/arved");
  const pills = page.locator("[data-list-pill-row] a");
  await expect(pills).toHaveText(["Kõik2", "Makstud1", "Pooleli0", "Ebaõnnestunud0", "Tagastatud0", "Ootel kontrollil1"]);
  const row = (reference: string) => page.locator(`tr[data-payment="${reference}"]`);
  for (const text of ["E2E Maksja", f.course.title, "Ettemaks", "175 €", "Makstud", "Pangalink · Testpank"]) await expect(row(paid.reference)).toContainText(text);
  // the row leads to the registration's drawer; the Montonio id is no text any more
  await expect(row(paid.reference).getByRole("link", { name: "Ava E2E Maksja" })).toHaveAttribute("href", `/admin/registreerimised?id=${regId}`);
  await expect(row(paid.reference)).not.toContainText(paid.providerUuid);
  await expect(row(paid.reference)).not.toContainText("paymentInitiation"); // Maria never reads Montonio's code (Task 9)
  await expect(row(held.reference)).not.toContainText("paymentInitiation");
  await expect(row(paid.reference).locator("[data-payment-check]")).toHaveCount(0);
  await expect(row(held.reference).locator("[data-payment-check]")).toHaveText("Kontrolli Montonios");
  await page.locator("[data-list-pill-row]").getByRole("link", { name: /^Ootel kontrollil/ }).click();
  await expect(page).toHaveURL(/\/admin\/maksed\?otsi=[^&]+&staatus=kontroll$/);
  await expect(row(held.reference)).toBeVisible();
  await expect(row(paid.reference)).toHaveCount(0);
  // the search is as she types, and finds a payment by its Montonio id (a part of it, any case)
  await page.goto("/admin/maksed");
  const search = page.getByRole("searchbox", { name: "Otsi nime, e-posti või Montonio id järgi" });
  await search.fill(paid.providerUuid.slice(4, 20).toUpperCase());
  await expect(page).toHaveURL(/\/admin\/maksed\?otsi=/);
  await expect(row(paid.reference)).toBeVisible();
  await expect(page.locator("tr[data-payment]")).toHaveCount(1);
  await search.fill("ei-leia-midagi");
  await expect(page.getByText("„ei-leia-midagi“ järgi makseid ei leitud.")).toBeVisible();
  await page.getByRole("link", { name: "Tühjenda otsing ja filtrid" }).click();
  await expect(page).toHaveURL(/\/admin\/maksed$/);

  await page.goto(`/admin/registreerimised?id=${regId}`);
  const lines = page.locator("[data-registration-payments]");
  await expect(lines.locator("[data-payment]")).toHaveCount(2);
  await expect(lines.locator(`[data-payment="${paid.reference}"] [data-payment-method]`)).toHaveText("Pangalink · Testpank");
  await expect(lines.locator(`[data-payment="${held.reference}"] [data-payment-check]`)).toHaveText("Kontrolli Montonios");
  await expect(lines).not.toContainText("paymentInitiation");
});

test("„Montonios ↗“ opens Montonio's Partner System in a new tab and copies the order id at the same press; a refused clipboard changes nothing but the line (Dim 22.10)", async ({ page, context, visitorIp }, info) => {
  const email = await fresh("partner", info);
  const f = await insertAccountFixtures(email, { cards: ["awaiting"], name: "E2E Partner" });
  const own = { email, name: "E2E Partner", registrationId: f.registrations.awaiting!, courseId: f.course.id, clientId: f.clientId, amountCents: 17500, method: "paymentInitiation", bank: "Testpank" };
  const paid = await insertStoredPayment({ ...own, kind: "prepayment", status: "paid", paid: true, minutesAgo: 5 });
  // (the sandbox's Partner System is not visited from a test: the new tab gets a stand-in page)
  let opened = 0;
  await context.route("https://sandbox-partner.montonio.com/**", (route) => {
    opened++;
    return route.fulfill({ status: 200, contentType: "text/html", body: "<title>Partner</title><p>Partner System</p>" });
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto(`/admin/maksed?otsi=${encodeURIComponent(email)}`);
  const link = page.locator(`tr[data-payment="${paid.reference}"] [data-montonio-link]`);
  await expect(link).toHaveText("Montonios ↗");
  await expect(link).toHaveAttribute("href", "https://sandbox-partner.montonio.com");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener");
  await expect(link).toHaveAttribute("title", paid.providerUuid); // (the id stays readable where the clipboard is refused)
  await expect(link).toHaveAttribute("aria-label", "Montonios ↗ — E2E Partner"); // (its visible words and the payer's)
  const line = page.locator(`tr[data-payment="${paid.reference}"] [data-montonio-copied]`);
  await expect(line).toHaveText("");
  await adminReady(page);

  const [tab] = await Promise.all([context.waitForEvent("page"), link.click()]);
  await tab.waitForLoadState();
  expect(tab.url()).toBe("https://sandbox-partner.montonio.com/");
  expect(opened).toBe(1);
  await expect(line).toHaveText("Montonio id kopeeritud.");
  await page.bringToFront();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(paid.providerUuid);
  expect(page.url()).toContain("/admin/maksed"); // (the press did not also open the row)
  await tab.close();
  await expect(line).toHaveText("", { timeout: 10_000 }); // (the line goes by itself)

  // a middle-click opens the tab too, and copies as well
  await page.bringToFront();
  await page.evaluate(() => navigator.clipboard.writeText("not copied yet"));
  const [middle] = await Promise.all([context.waitForEvent("page"), link.click({ button: "middle" })]);
  // (a middle-clicked tab opens behind this one: it is not shown or waited for here, only closed)
  await expect(line).toHaveText("Montonio id kopeeritud.");
  await page.bringToFront();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(paid.providerUuid);
  await middle.close();
  await expect(line).toHaveText("", { timeout: 10_000 });

  // a clipboard that refuses: the tab still opens, and no line says what did not happen
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("NotAllowedError")) } }));
  const [again] = await Promise.all([context.waitForEvent("page"), link.click()]);
  await again.waitForLoadState();
  expect(again.url()).toBe("https://sandbox-partner.montonio.com/");
  await page.bringToFront();
  await page.waitForTimeout(300);
  await expect(line).toHaveText("");
  await again.close();
});

test("four webhooks of the same PAID token at the same moment: all 200, the payment paid once, the registration credited once (Postgres, Task 3)", async ({ page }, info) => {
  const email = await fresh("twice", info);
  const f = await insertAccountFixtures(email, { cards: ["awaiting"] });
  await page.goto(`/maksa/${await storedPayToken(f.registrations.awaiting!)}`);
  await page.getByRole("button", { name: "Maksa 175 €" }).click();
  await reachBank(page); // an open order at the bank, not paid
  const order = await fakeOrder(await onlyReference(email));
  expect(order.status).toBe("PENDING");
  const minted = await fetch(`${E2E_MONTONIO.url}/_fake/token/${order.uuid}?status=PAID`);
  expect(minted.status).toBe(200);
  const { orderToken } = (await minted.json()) as { orderToken: string };

  const hook = new URL("/api/payments/notify", APP);
  const send = () => fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderToken }) });
  const answers = await Promise.all(Array.from({ length: 4 }, send));
  expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
  expect(await storedPayments(email)).toEqual([{ kind: "prepayment", status: "paid", amountCents: 17500 }]); // one row, paid
  expect(await storedRegistrations(email)).toEqual([expect.objectContaining({ status: "confirmed", paidCents: 17500 })]); // credited once, not four times (70000)
  // and Montonio's retry, long after: still 200 and nothing new
  expect((await send()).status).toBe(200);
  expect(await storedRegistrations(email)).toEqual([expect.objectContaining({ status: "confirmed", paidCents: 17500 })]);
  expect(await storedPayments(email)).toEqual([{ kind: "prepayment", status: "paid", amountCents: 17500 }]);
});

/**
 * The e-course form filled in for `email`, and its press held back at the browser: the page's own server-action call, as it is (the same form
 * data, the same action), is captured and refused there. `replay(racer)` sends it again from the test process, as a visitor of its own (the forms
 * allow 5 presses in 10 minutes per visitor), and answers the response.
 */
async function heldEcoursePress(page: Page, email: string): Promise<{ replay: (racer: string) => Promise<Response> }> {
  await page.goto("/ostukorv?kursus=kulmumeistri-e-koolitus");
  const form = page.locator("[data-ecourse-form]");
  await form.getByLabel("Nimi").fill("Test Ostja");
  await form.getByLabel("E-post").fill(email);
  await form.getByLabel(/tingimustega/).check();
  let hold!: (request: Request) => void;
  const held = new Promise<Request>((resolve) => (hold = resolve));
  await page.route("**/*", (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) return route.fallback();
    hold(request);
    return route.abort();
  });
  await form.getByRole("button", { name: "Maksa 190 €" }).click();
  const press = await held;
  const body = press.postDataBuffer();
  expect(body, "the form data of the press").not.toBeNull();
  const headers = Object.fromEntries(Object.entries(await press.allHeaders()).filter(([name]) => !["host", "connection", "content-length", "accept-encoding"].includes(name)));
  return { replay: (racer) => fetch(press.url(), { method: "POST", headers: { ...headers, "x-forwarded-for": racer }, body: new Uint8Array(body!) }) };
}

/** A visitor address of its own for each racer of a test (the server keeps 64 characters of an address, and the run-unique part comes first). */
const racerIps = (visitorIp: string, n: number) => Array.from({ length: n }, (_, i) => `e2e-lock-${visitorIp.slice(0, 40)}-${i}`);

const answeredWithBank = async (answer: Response) => {
  expect(answer.status).toBe(200);
  expect(await answer.text()).toContain(`"paymentUrl":"${E2E_MONTONIO.url}/pay/`); // sent to the bank, to the one open order
};

test("a start of an e-course purchase waits for the purchase's advisory lock while another transaction holds it, and goes on when it is let go (Postgres, Task 7)", async ({ page, visitorIp }, info) => {
  // the cart's contract is the e-course terms: no test of the terms saves other ones while this one buys (R6)
  const release = await holdTerms();
  try {
    const email = await fresh("held", info);
    const { replay } = await heldEcoursePress(page, email);
    const [course] = await onLocalDb((sql) => sql<{ id: number }[]>`select id from courses where slug = 'kulmumeistri-e-koolitus'`, { marksPages: false });
    let answer!: Promise<Response>;
    let finished = false;
    // another connection holds the purchase's lock (start.ts lockEcoursePurchase: class ECOURSE_BUY_LOCK_CLASS, key "<course id>:<address>") …
    await onLocalDb(
      (sql) =>
        sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(${ECOURSE_BUY_LOCK_CLASS}::int, hashtext(${`${course.id}:${email}`}))`;
          answer = replay(racerIps(visitorIp, 1)[0]);
          void answer.then(() => (finished = true), () => (finished = true));
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          // … so the start cannot have got further than the lock: no answer yet, and no payment row (the look for an open attempt and the insert are behind it)
          expect(finished, "the start went past the purchase's lock while it was held").toBe(false);
          expect(await storedPayments(email)).toEqual([]);
        }),
      { marksPages: false },
    );
    // the lock is let go with the transaction: the start goes on and ends as any other
    await answeredWithBank(await answer);
    expect(await storedPayments(email)).toEqual([{ kind: "ecourse", status: "pending", amountCents: 19000 }]);
  } finally {
    await release();
  }
});

test("the same e-course purchase started eight times at the same moment is one pending payment, never several charges (the advisory lock, Postgres, Task 7)", async ({ page, visitorIp }, info) => {
  // the cart's contract is the e-course terms: no test of the terms saves other ones while this one buys (R6)
  const release = await holdTerms();
  try {
    const email = await fresh("lock", info);
    const { replay } = await heldEcoursePress(page, email);
    // eight requests that meet in the server at the same moment. Without the lock, two or three of them are enough to make two rows, but how often
    // they overlap varies (about four runs in five caught the missing lock): the test above is the one that never misses it.
    const answers = await Promise.all(racerIps(visitorIp, 8).map(replay));
    for (const answer of answers) await answeredWithBank(answer);
    expect(await storedPayments(email)).toEqual([{ kind: "ecourse", status: "pending", amountCents: 19000 }]);
  } finally {
    await release();
  }
});

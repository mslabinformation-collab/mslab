import type { Locator, Page } from "@playwright/test";
import { formatDate, formatTime } from "../../src/i18n/format";
import { clientEmail, insertAccountFixtures, setPrepayment, signInAsClient, storedChangeRequests, takeTerms, TEST_PREPAYMENT, type AccountCardKind } from "./account";
import { signInAsAdmin, type CreatedRows } from "./admin-login";
import { holdLocalLock, LOCK_WAIT_MS, onLocalDb, removeAdminRows, removeClientRows, snapshotRows, storedPayments } from "./fixtures";
import { insertLessonCourse, markDone, removeLessonFile } from "./lessons";
import { E2E_MONTONIO } from "./montonio-values";
import { submitsForms, test, expect } from "./test";
import { scrollLeft, swipe } from "./touch";

// Phase 2a Task 6: "Minu koolitused" (/konto) — every card says what to do next in one sentence with at most one button
// (spec 2.1 rule 5), the prepayment instructions, "Tühista või muuda aega", the tabs (a bar at the bottom on a phone),
// "Logi välja". Every client is a sample address (`e2e-client-…@example.test`, never mailed) with rows written straight
// to the local database (tests/e2e/account.ts insertAccountFixtures): registrations on the test's own unpublished course,
// so no public seat count moves. Each test starts by removing its own address's rows.

const ALL: AccountCardKind[] = ["awaiting", "confirmed", "cancelled", "practice", "waitlist", "ecourse"];

const card = (page: Page, key: string) => page.locator(`[data-card="${key}"]`);
/** What a card offers: its buttons and links. */
const actions = (c: Locator) => c.locator("button, a");
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const fab = (page: Page) => page.getByRole("button", { name: "Jäta kommentaar" });

/** The addresses this worker's tests made rows for: removed after each test (the admin list would show their courses). */
const made = new Set<string>();
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
});

/** A fresh client with these cards, signed in on `page` (/konto open, the dashboard loaded). */
async function signedInWith(page: Page, label: string, project: string, opts: { name?: string; locale?: "et" | "ru"; cards?: AccountCardKind[] } = {}) {
  const email = clientEmail(label, project);
  made.add(email);
  await removeClientRows(email);
  const f = await insertAccountFixtures(email, opts);
  await signInAsClient(page, email);
  await expect(page.locator("[data-account-dashboard]")).toBeVisible();
  return { email, ...f };
}

test("every card says what to do next, with at most one main button; the prepayment instructions open in place; without them the card still says what is due", async ({ page, context }, info) => {
  submitsForms();
  // The prepayment instructions are one shared setting: the desktop and phone runs of this test take turns.
  info.setTimeout(info.timeout + LOCK_WAIT_MS); // the wait for the shared setting is not taken from the test's own time
  const release = await holdLocalLock("e2e-prepayment-setting");
  const restore = await snapshotRows("settings", { column: "key", value: "prepayment" });
  try {
    await setPrepayment(TEST_PREPAYMENT);
    const f = await signedInWith(page, "dash", info.project.name, { name: "Kati Tamm", cards: ALL });
    const reg = f.registrations;
    const start = f.session.startsAt;

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tere, Kati!");
    await expect(page.getByText("Siin on sinu koolitused.", { exact: true })).toBeVisible();

    const expected: [string, string, string, string[]][] = [
      // card, tag, sentence, its buttons (the first is the one main button; with online payments an unpaid card has "Vaata juhiseid" as a text button under it)
      [`registration-${reg.awaiting}`, "Kontaktõpe", "Koha kinnitamiseks tasu ettemaks 175 €.", ["Maksa 175 €", "Vaata juhiseid"]],
      [`registration-${reg.confirmed}`, "Kontaktõpe", "Koht on kinnitatud.", ["Tühista või muuda aega"]],
      [`registration-${reg.cancelled}`, "Kontaktõpe", "Registreering on tühistatud.", []],
      [`request-${f.requests.practice}`, "Päring", "Päring on saadetud. Maria vastab peagi.", []],
      [`request-${f.requests.waitlist}`, "Ootenimekiri", "Oled ootenimekirjas. Anname teada, kui koht vabaneb.", []],
      [`course-${f.ecourse.slug}`, "E-õpe", `Ligipääs kuni ${formatDate(f.ecourse.expiresAt!, "et")}.`, ["Ava koolitus"]],
    ];
    await expect(page.locator("[data-card]")).toHaveCount(expected.length);
    for (const [key, tag, sentence, buttons] of expected) {
      const c = card(page, key);
      await expect(c, key).toContainText(tag);
      await expect(c.locator("[data-next-step]"), key).toHaveText(sentence);
      if (buttons.length) await expect(actions(c), key).toHaveText(buttons);
      else await expect(actions(c), key).toHaveCount(0);
      await expect(c.locator("[data-card-action]"), key).toHaveCount(buttons.length ? 1 : 0); // one main button at most
    }
    // the dated session line (the sentences do not repeat it), the practice request's times, the e-course link
    await expect(card(page, `registration-${reg.awaiting}`)).toContainText(`${formatDate(start, "et")} · ${formatTime(start, "et")}`);
    await expect(card(page, `registration-${reg.confirmed}`)).toContainText(`${formatDate(start, "et")} · ${formatTime(start, "et")}`);
    await expect(card(page, `registration-${reg.awaiting}`)).toContainText("Pärnu, MS LAB stuudio");
    await expect(card(page, `request-${f.requests.practice}`)).toContainText("Tööpäeviti pärast kella 17");
    await expect(card(page, `course-${f.ecourse.slug}`).getByRole("link", { name: "Ava koolitus" })).toHaveAttribute("href", `/konto/kursus/${f.ecourse.slug}`);
    // the cancelled registration comes last (over cards after the open ones)
    await expect(page.locator("[data-card]").last()).toHaveAttribute("data-card", `registration-${reg.cancelled}`);

    // Kõik / Tulevased / Möödunud
    const chips = page.locator("[data-account-filters]");
    await expect(chips.getByRole("button")).toHaveText(["Kõik", "Tulevased", "Möödunud"]);
    await chips.getByRole("button", { name: "Möödunud" }).click();
    await expect(page.locator("[data-card]")).toHaveCount(1);
    await chips.getByRole("button", { name: "Tulevased" }).click();
    await expect(page.locator("[data-card]")).toHaveCount(5);
    await chips.getByRole("button", { name: "Kõik" }).click();
    await expect(page.locator("[data-card]")).toHaveCount(6);

    // "Vaata juhiseid" opens the instructions under the card
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const awaiting = card(page, `registration-${reg.awaiting}`);
    const pay = awaiting.getByRole("button", { name: "Vaata juhiseid" });
    // only the opened card grows: its neighbours keep their height
    const neighbour = card(page, `registration-${reg.confirmed}`);
    const before = (await neighbour.boundingBox())!.height;
    await pay.click();
    await expect(awaiting.getByRole("button", { name: "Peida juhised" })).toHaveAttribute("aria-expanded", "true");
    const panel = awaiting.locator("[data-prepayment]");
    await expect(panel.locator("[data-pay-row]")).toHaveText([
      /^Saaja\s*MS LAB OÜ$/,
      // both labels of Kopeeri are in the button, one shown
      new RegExp(`^IBAN\\s*${TEST_PREPAYMENT.iban}\\s*Kopeeri\\s*Kopeeritud ✓$`),
      /^Pank\s*Swedbank$/,
      /^Summa\s*175 €$/,
      new RegExp(`^Selgitus\\s*MSLAB-${reg.awaiting}\\s*Kopeeri\\s*Kopeeritud ✓$`),
    ]);
    await expect(panel).toContainText("Pärast makset kinnitab Maria su koha.");
    expect((await awaiting.boundingBox())!.height).toBeGreaterThan(before + 200);
    expect((await neighbour.boundingBox())!.height).toBe(before);
    // Kopeeri: the pressed button says so for a moment; a hidden live region tells a screen reader
    const copyRef = panel.getByRole("button", { name: "Kopeeri: Selgitus" });
    await copyRef.click();
    await expect(copyRef.locator("span", { hasText: "Kopeeritud ✓" })).toBeVisible();
    await expect(copyRef.locator("span", { hasText: /^Kopeeri$/ })).toBeHidden();
    await expect(panel.locator("[data-pay-status]")).toHaveText("Kopeeritud: Selgitus");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`MSLAB-${reg.awaiting}`);
    await expect(copyRef.locator("span", { hasText: /^Kopeeri$/ })).toBeVisible({ timeout: 4000 }); // back after about 2 s
    // the drawn pill is the button itself: at least 44 px tall
    expect((await copyRef.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await panel.getByRole("button", { name: "Kopeeri: IBAN" }).click();
    // read in groups of four, copied without spaces
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(TEST_PREPAYMENT.iban.replace(/ /g, ""));
    await awaiting.getByRole("button", { name: "Peida juhised" }).click();
    await expect(panel).toHaveCount(0);

    // no instructions stored: with online payments the card still says what is due, and "Maksa 175 €" is its one button (phase 2b)
    await setPrepayment(null);
    await page.reload();
    await expect(card(page, `registration-${reg.awaiting}`).locator("[data-next-step]")).toHaveText("Koha kinnitamiseks tasu ettemaks 175 €.");
    await expect(actions(card(page, `registration-${reg.awaiting}`))).toHaveText(["Maksa 175 €"]);
  } finally {
    await restore();
    await release();
  }
});

test("'Maksa 175 €' goes to the bank; paid there, the place is confirmed and 'Maksa ülejäänud 175 €' offers the rest (phase 2b)", async ({ page }, info) => {
  submitsForms();
  const f = await signedInWith(page, "pay", info.project.name, { cards: ["awaiting"] });
  const c = card(page, `registration-${f.registrations.awaiting}`);
  await c.getByRole("button", { name: "Maksa 175 €" }).click();
  await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
  await page.getByRole("button", { name: "Makstud" }).click();
  await expect.poll(() => storedPayments(f.email)).toEqual([{ kind: "prepayment", status: "paid", amountCents: 17500 }]);
  await page.goto("/konto");
  await expect(c.locator("[data-next-step]")).toHaveText("Koht on kinnitatud. Ülejäänud 175 € tasud koolituspäeval.");
  await expect(actions(c)).toHaveText(["Maksa ülejäänud 175 €", "Tühista või muuda aega"]);
  await expect(c.locator("[data-card-action]")).toHaveCount(1);
  await c.getByRole("button", { name: "Maksa ülejäänud 175 €" }).click();
  await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
  await page.getByRole("button", { name: "Katkesta" }).click();
  await expect.poll(() => storedPayments(f.email)).toEqual([
    { kind: "prepayment", status: "paid", amountCents: 17500 },
    { kind: "balance", status: "failed", amountCents: 17500 },
  ]);
});

test("without the clipboard, Kopeeri selects the text and says so", async ({ page }, info) => {
  submitsForms();
  info.setTimeout(info.timeout + LOCK_WAIT_MS); // the wait for the shared setting is not taken from the test's own time
  const release = await holdLocalLock("e2e-prepayment-setting");
  const restore = await snapshotRows("settings", { column: "key", value: "prepayment" });
  try {
    await setPrepayment(TEST_PREPAYMENT);
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "clipboard", { value: undefined, configurable: true }));
    const f = await signedInWith(page, "noclip", info.project.name, { cards: ["awaiting"] });
    const c = card(page, `registration-${f.registrations.awaiting}`);
    await c.getByRole("button", { name: "Vaata juhiseid" }).click();
    await c.getByRole("button", { name: "Kopeeri: IBAN" }).click();
    await expect(c.locator("[data-pay-selected]")).toHaveText("Tekst on märgitud. Kopeeri see.");
    await expect(c.locator("[data-pay-status]")).toHaveText("Tekst on märgitud. Kopeeri see.");
    expect(await page.evaluate(() => String(window.getSelection()))).toBe(TEST_PREPAYMENT.iban);
  } finally {
    await restore();
    await release();
  }
});

test("Tühista või muuda aega: two choices, a message, Saada — Maria finds it in Päringud, and the card keeps saying it was sent", async ({ page, context, visitorIp }, info) => {
  submitsForms();
  const f = await signedInWith(page, "change", info.project.name, { name: "Mari", cards: ["confirmed"] });
  const c = card(page, `registration-${f.registrations.confirmed}`);
  const open = c.getByRole("button", { name: "Tühista või muuda aega" });

  // the dialog: the course and its date, the first choice focused; Esc closes it and the focus is back on the button
  await open.click();
  const dialog = page.getByRole("dialog", { name: f.course.title });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`${formatDate(f.session.startsAt, "et")} · ${formatTime(f.session.startsAt, "et")}, Pärnu`);
  await expect(dialog.getByRole("radio", { name: "Soovin tühistada" })).toBeFocused();
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();

  // Saada without a choice asks for one; then the request goes
  await open.click();
  await dialog.getByRole("button", { name: "Saada" }).click();
  await expect(dialog.locator("[data-change-notice]")).toHaveText("Vali üks neist.");
  await expect(dialog.getByRole("radio", { name: "Soovin tühistada" })).toBeFocused();
  await dialog.getByText("Soovin muuta aega").click();
  await dialog.getByLabel("Sõnum Mariale (kui soovid)").fill("Kas jaanuaris oleks võimalik?");
  await dialog.getByRole("button", { name: "Saada" }).click();
  await expect(dialog).toBeHidden();
  const sent = c.locator("[data-card-sent]");
  await expect(sent).toHaveText("Saadetud. Maria võtab sinuga ühendust.");
  await expect(sent).toBeFocused();
  await expect(actions(c)).toHaveCount(0);
  await expect.poll(() => storedChangeRequests(f.clientId)).toEqual([
    { payload: { registrationId: f.registrations.confirmed, kind: "change", message: "Kas jaanuaris oleks võimalik?", email: f.email } },
  ]);

  // a reload in this tab still says so
  await page.reload();
  await expect(c.locator("[data-card-sent]")).toHaveText("Saadetud. Maria võtab sinuga ühendust.");
  await expect(actions(c)).toHaveCount(0);

  // Maria's inbox: Päringud → Muutmine
  const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
  try {
    await signInAsAdmin(page, context, visitorIp, created);
    await page.goto("/admin/paringud?liik=muutmine");
    const row = page.locator("[data-request]").filter({ hasText: f.email });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Kas jaanuaris oleks võimalik?");
  } finally {
    await removeAdminRows(created);
  }
});

test("a request that cannot go says so in one plain sentence (too many, no longer possible); the cards catch up in place, chips and focus kept", async ({ page }, info) => {
  submitsForms();
  const f = await signedInWith(page, "refused", info.project.name, { cards: ["confirmed", "confirmed2", "cancelled"] });
  const first = card(page, `registration-${f.registrations.confirmed}`);
  const second = card(page, `registration-${f.registrations.confirmed2}`);
  const dialog = page.getByRole("dialog");
  const notice = dialog.locator("[data-change-notice]");
  const chips = page.locator("[data-account-filters]");
  // the dashboard is drawn once: a reload behind it keeps this very element (no skeleton in between)
  await page.locator("[data-account-dashboard]").evaluate((el) => el.setAttribute("data-e2e-same", ""));

  // under Tulevased: 429 (5 an hour), then Maria cancels the registration meanwhile: 404
  await chips.getByRole("button", { name: "Tulevased" }).click();
  await first.getByRole("button", { name: "Tühista või muuda aega" }).click();
  await dialog.getByText("Soovin tühistada").click();
  await page.route("**/api/konto/muutmine", (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ ok: false, error: "rate" }) }), { times: 1 });
  await dialog.getByRole("button", { name: "Saada" }).click();
  await expect(notice).toHaveText("Oled saatnud juba mitu soovi. Proovi tunni aja pärast uuesti.");
  await expect(dialog).toBeVisible();
  await onLocalDb((sql) => sql`update registrations set status = 'cancelled' where id = ${f.registrations.confirmed!}`);
  await dialog.getByRole("button", { name: "Saada" }).click();
  await expect(notice).toHaveText("Seda registreeringut ei saa enam muuta. Võta Mariaga ühendust.");
  await dialog.getByRole("button", { name: "Sulge" }).click();
  await expect(dialog).toBeHidden();
  // the cards are loaded again behind the page: that one is over now, so Tulevased no longer shows it; the chip stays
  await expect(first).toHaveCount(0);
  await expect(chips.getByRole("button", { name: "Tulevased" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused(); // its card is gone from view: the page heading
  await expect(page.locator("[data-account-dashboard][data-e2e-same]")).toHaveCount(1);
  await expect(page.locator("[data-card-skeleton]")).toHaveCount(0);

  // under Kõik the same for the other one: it stays in view, over, and the focus is on its heading
  await chips.getByRole("button", { name: "Kõik" }).click();
  await second.getByRole("button", { name: "Tühista või muuda aega" }).click();
  await dialog.getByText("Soovin muuta aega").click();
  await onLocalDb((sql) => sql`update registrations set status = 'cancelled' where id = ${f.registrations.confirmed2!}`);
  await dialog.getByRole("button", { name: "Saada" }).click();
  await expect(notice).toHaveText("Seda registreeringut ei saa enam muuta. Võta Mariaga ühendust.");
  await page.keyboard.press("Escape");
  await expect(second.locator("[data-next-step]")).toHaveText("Registreering on tühistatud.");
  await expect(actions(second)).toHaveCount(0);
  await expect(second.getByRole("heading", { level: 2 })).toBeFocused();
  await expect(chips).toHaveCount(0); // every card is over now: nothing left to filter
  await expect(page.locator("[data-account-dashboard][data-e2e-same]")).toHaveCount(1);
  expect(await storedChangeRequests(f.clientId)).toEqual([]);
});

test("no courses yet: one sentence and Vaata koolitusi; no chips", async ({ page }, info) => {
  submitsForms();
  await signedInWith(page, "empty", info.project.name);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tere!");
  await expect(page.getByText("Siin on sinu koolitused.")).toHaveCount(0); // the line is for a page with courses
  const empty = page.locator("[data-account-empty]");
  await expect(empty).toContainText("Sul ei ole veel koolitusi.");
  await expect(page.locator("[data-account-filters]")).toHaveCount(0);
  await empty.getByRole("link", { name: "Vaata koolitusi" }).click();
  await expect(page).toHaveURL(/\/koolitused$/);
});

test("while loading: two skeleton cards; a failed load says so, and Proovi uuesti loads again", async ({ page }, info) => {
  submitsForms();
  await signedInWith(page, "load", info.project.name, { cards: ["confirmed"] });

  let hold: () => void = () => {};
  const held = new Promise<void>((resolve) => (hold = resolve));
  await page.route("**/api/konto", async (route) => {
    await held;
    await route.fallback();
  });
  await page.reload();
  await expect(page.locator("[data-card-skeleton]")).toHaveCount(2);
  await expect(page.locator("[data-account-state='loading']")).toHaveAttribute("aria-busy", "true");
  hold();
  await expect(page.locator("[data-card]")).toHaveCount(1);
  await page.unroute("**/api/konto");

  let failing = true;
  await page.route("**/api/konto", (route) =>
    failing ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false }) }) : route.fallback(),
  );
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ei õnnestunud laadida.");
  failing = false;
  await page.getByRole("button", { name: "Proovi uuesti" }).click();
  await expect(page.locator("[data-card]")).toHaveCount(1);
});

test("the tabs: a bar at the bottom of a phone (icons, labels, ≥ 44 px, never over a card or the comment button), at the top on a computer; no sideways scrolling", async ({ page, isMobile }, info) => {
  submitsForms();
  await signedInWith(page, "tabs", info.project.name, { name: "Kati", cards: ALL });
  const top = page.locator("[data-account-tabs='top']");
  const bar = page.locator("[data-account-tabs='bottom']");
  const names = ["Minu koolitused", "Lemmikud", "Minu andmed"];
  const hrefs = ["/konto", "/konto/lemmikud", "/konto/andmed"];

  if (isMobile) {
    await expect(top).toBeHidden();
    await expect(bar).toBeVisible();
    await expect(bar.getByRole("link")).toHaveText(names);
    for (const [i, link] of (await bar.getByRole("link").all()).entries()) {
      await expect(link).toHaveAttribute("href", hrefs[i]);
      await expect(link.locator("svg")).toBeVisible();
      const box = (await link.boundingBox())!;
      expect(box.height, names[i]).toBeGreaterThanOrEqual(44);
      expect(box.width, names[i]).toBeGreaterThanOrEqual(44);
    }
    await expect(bar.getByRole("link", { name: "Minu koolitused" })).toHaveAttribute("aria-current", "page");
    // at the screen's bottom edge, and the cards end above it
    const viewport = page.viewportSize()!;
    await expect.poll(async () => Math.round((await bar.boundingBox())!.y + (await bar.boundingBox())!.height)).toBe(viewport.height);
    const barTop = (await bar.boundingBox())!.y;
    const list = (await page.locator("[data-account-cards]").boundingBox())!;
    expect(list.y + list.height).toBeLessThanOrEqual(barTop + 1);
    // the review build's comment button moves up above the bar
    const reviewBuild = await fab(page).waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
    if (reviewBuild) {
      await expect.poll(async () => Math.round((await fab(page).boundingBox())!.y + (await fab(page).boundingBox())!.height)).toBeLessThanOrEqual(Math.round(barTop));
    }
    // at the end of the page the bar stops above the footer: it never covers it
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const footer = (await page.locator("footer").boundingBox())!;
    await expect.poll(async () => (await bar.boundingBox())!.y + (await bar.boundingBox())!.height).toBeLessThanOrEqual(footer.y + 1);
    expect(await noOverflow(page)).toBe(true);
  } else {
    await expect(bar).toBeHidden();
    await expect(top).toBeVisible();
    await expect(top.getByRole("link")).toHaveText(names);
    await expect(top.getByRole("link", { name: "Minu koolitused" })).toHaveAttribute("aria-current", "page");
    for (const link of await top.getByRole("link").all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    for (const width of [390, 834, 1440, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator("[data-card]").first()).toBeVisible();
      expect(await noOverflow(page), `${width} px`).toBe(true);
    }
  }
});

test("phones: the cards are a row to swipe through", async ({ page, isMobile }, info) => {
  test.skip(!isMobile, "touch swipes: phone project only");
  submitsForms();
  await signedInWith(page, "swipe", info.project.name, { cards: ALL });
  const row = page.locator("[data-account-cards='swipe']");
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("tabindex", "0"); // the arrow keys scroll it too
  expect(await scrollLeft(row)).toBe(0);
  const second = page.locator("[data-card]").nth(1);
  const x = async (el: Locator) => (await el.boundingBox())!.x;
  const before = await x(second);
  expect(before).toBeGreaterThan(300); // the next card peeks in at the right
  expect(before).toBeLessThan(390);
  await swipe(page, row, "left", 0.15);
  await expect.poll(() => scrollLeft(row)).toBeGreaterThan(0);
  // the next card has come in from the right (the snap to its edge is the browser's own: synthetic touch does not fling)
  await expect.poll(() => x(second)).toBeLessThan(before - 150);
  expect(await noOverflow(page)).toBe(true);
});

test("Logi välja ends the session and opens the home page, which says Logi sisse again", async ({ page, isMobile }, info) => {
  submitsForms();
  await signedInWith(page, "logout", info.project.name, { cards: ["confirmed"] });
  const menu = page.locator("[data-account-menu]");
  await expect(menu).toHaveAccessibleName("Konto menüü");
  await menu.click();
  const logout = page.getByRole("button", { name: "Logi välja" });
  await expect(logout).toBeVisible();
  await page.keyboard.press("Escape"); // closes, the focus back on the button
  await expect(logout).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await logout.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("[data-account-link]").first()).toHaveAttribute("data-account-link", "out");
  if (!isMobile) await expect(page.locator("header").getByRole("link", { name: "Logi sisse", exact: true })).toBeVisible();
  expect((await page.request.get("/api/konto/me")).status()).toBe(401);
});

test("in Russian: the page, the tabs and Выйти speak Russian, and logging out opens /ru", async ({ page, isMobile }, info) => {
  submitsForms();
  const f = await signedInWith(page, "dash-ru", info.project.name, { name: "Анна", locale: "ru", cards: ["awaiting", "confirmed"] });
  await expect(page).toHaveURL(/\/ru\/konto$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Здравствуйте, Анна!");
  await expect(page.getByText("Здесь ваши курсы.", { exact: true })).toBeVisible();
  const tabs = page.locator(isMobile ? "[data-account-tabs='bottom']" : "[data-account-tabs='top']");
  await expect(tabs.getByRole("link")).toHaveText(["Мои курсы", "Избранное", "Мои данные"]);
  await expect(tabs.getByRole("link").nth(1)).toHaveAttribute("href", "/ru/konto/lemmikud");
  const start = f.session.startsAt;
  await expect(card(page, `registration-${f.registrations.confirmed}`).locator("[data-next-step]")).toHaveText("Место подтверждено.");
  await expect(card(page, `registration-${f.registrations.confirmed}`)).toContainText(`${formatDate(start, "ru")} · ${formatTime(start, "ru")}`);
  await expect(card(page, `registration-${f.registrations.confirmed}`).getByRole("button")).toHaveText("Отменить или перенести");
  await expect(card(page, `registration-${f.registrations.awaiting}`)).toContainText("Очное обучение");
  await page.locator("[data-account-menu]").click();
  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page).toHaveURL(/\/ru$/);
  await expect(page.locator("[data-account-link]").first()).toHaveAttribute("data-account-link", "out");
});

test("an e-course with lessons: the dark 'Pooleli' card on top with the next lesson and 'Jätka'; the card's bar; finished: 'Läbitud ✓' and no dark card", async ({ page }, info) => {
  submitsForms();
  // the lesson page the card opens checks the course terms, shared by every client: this test takes them like the lesson specs do
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  const restoreTerms = await takeTerms();
  const email = clientEmail("dash-pooleli", info.project.name);
  await removeClientRows(email);
  const c = await insertLessonCourse(email);
  try {
    await signInAsClient(page, email);
    await page.goto("/konto");
    const resume = page.locator("[data-resume-card]");
    await expect(resume).toContainText("Pooleli");
    await expect(resume.locator("[data-resume-where]")).toHaveText("Alustame · Esimene tund");
    await expect(resume.locator("[data-resume-progress]")).toHaveText("0 / 3 õppetundi tehtud");
    await expect(resume.locator("[data-resume-next]")).toHaveText("Alusta");
    await markDone(c.clientId, c.lessons.video);
    await page.reload();
    await expect(resume.locator("[data-resume-where]")).toHaveText("Alustame · Teine tund");
    await expect(resume.locator("[data-resume-next]")).toHaveText("Jätka");
    await expect(page.locator(`[data-card="course-${c.slug}"] [data-card-progress]`)).toHaveText("1 / 3");
    expect(await noOverflow(page)).toBe(true);
    await resume.locator("[data-resume-next]").click();
    await expect(page).toHaveURL(new RegExp(`/konto/kursus/${c.slug}/${c.lessons.text}$`));
    await markDone(c.clientId, c.lessons.text);
    await markDone(c.clientId, c.lessons.last);
    await page.goto("/konto");
    await expect(page.locator(`[data-card="course-${c.slug}"] [data-card-finished]`)).toHaveText("Läbitud ✓");
    await expect(page.locator("[data-resume-card]")).toHaveCount(0);
  } finally {
    try {
      await removeClientRows(email);
      await removeLessonFile(c.fileKey);
    } finally {
      await restoreTerms();
    }
  }
});

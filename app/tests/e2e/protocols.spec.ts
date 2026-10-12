import type { Page } from "@playwright/test";
import { mintLoginToken } from "./account";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { removeAdminRows, removeClientRows } from "./fixtures";
import { chip, E2E_HEADINGS, editor, general, insertDraftProtocol, insertFeedbackAnswer, insertProtocolFixtures, insertSentProtocol, keptKeys, note, runName, saved, saveStatus, storedFeedback, storedProtocol, studentContext, studentPage } from "./protocols";
import { smallTargets } from "./targets";
import { submitsForms, test, expect } from "./test";

// Phase protocols (spec §10 "End to end"): Maria's course day — the headings in the course editor, two students written while switching between
// them, a dropped connection and a reload that lose nothing, "Lukusta ja saada kõik", the student reading hers (from her card and from the
// mail's button), "Muuda" and "Saada uuesti" — and the feedback form from its card to Maria's Tagasiside, "Ei soovi", and the pages at 390,
// 834, 1194 and 1440 px. Every student is a sample address (`e2e-client-proto-…@example.test`, never mailed) on a course of the test's own;
// all of it is removed after each test. Under `next dev` and the production build (E2E_PROD_BUILD=1); the admin signs in as Dim (admin-login.ts).
// The autosave in a real browser (offline, Back, the server's refusals) is protocols-autosave.spec.ts; the locks on real Postgres are
// protocols-race.spec.ts.

const made = new Set<string>();
const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
const SAVE = "**/api/admin/protokoll";

test.beforeEach(() => {
  submitsForms();
  test.setTimeout(180_000); // (the first view of each page under `next dev` compiles it; the retries wait seconds)
});
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
});

async function fixtures(...args: Parameters<typeof insertProtocolFixtures>) {
  const fx = await insertProtocolFixtures(...args);
  for (const s of fx.students) made.add(s.email);
  return fx;
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const emptyNotes = (n: number) => Array.from({ length: n }, () => expect.objectContaining({ note: "" }));
/**
 * Records whether the protocol page's "not found" was on the page in any frame from now on: a MutationObserver over the whole document (it
 * also looks at once). It looks at the page's visible text and at the case's own mark (AccountNotFound's data-account-state), never at the
 * document's text content, which holds the scripts' text too (the static shell carries its sentences in the page's data).
 * Self-contained: it is sent to the browser (page.evaluate, or addInitScript before a document's own scripts).
 */
function watchNotFound({ text, state }: { text: string; state: string }): void {
  const w = window as unknown as { __notFoundSeen?: boolean };
  w.__notFoundSeen = false;
  const look = () => {
    if (document.querySelector(`[data-account-state="${state}"]`) || (document.body && document.body.innerText.includes(text))) w.__notFoundSeen = true;
  };
  look();
  new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
}
const sawNotFound = (page: Page) => page.evaluate(() => (window as unknown as { __notFoundSeen?: boolean }).__notFoundSeen === true);
const NOT_FOUND = { text: "Seda protokolli ei leitud", state: "noProtocol" };

test("the headings in the course editor; Kalender's 'Protokollid'; two students written while switching between them, every word stored (§10 e2e 1)", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("two", runName(info), ["Mari Maasikas", "Anu Aas"], { headings: [] });
  const [mari, anu] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  // Protokolli punktid: three headings, saved with the course
  await page.goto(`/admin/koolitused/${fx.course.id}`);
  await adminReady(page);
  const stages = page.locator("[data-protocol-stages]");
  for (const [i, title] of E2E_HEADINGS.entries()) {
    await stages.locator("[data-add-stage]").click();
    await stages.locator(`[data-protocol-stage="${i}"]`).fill(title);
  }
  await page.getByRole("button", { name: "Salvesta", exact: true }).click();
  await expect(page.locator("[data-save-status]")).toHaveText("Salvestatud.");
  // the session's drawer in Kalender: one tap to the course day's screen
  await page.goto(`/admin/kalender?id=${fx.session.id}`);
  await adminReady(page);
  await page.locator("[data-session-protocols]").click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?sessioon=${fx.session.id}$`));
  await adminReady(page);
  await expect(page.locator("[data-students] [data-student]")).toHaveCount(2);
  // Mari: her headings with a box each, then the general notes
  await chip(page, mari.id).click();
  await expect(editor(page, mari.id).locator("label")).toHaveText([...E2E_HEADINGS, "Üldised märkused"]);
  await note(page, mari.id, 0).fill("Mari: ühtlane joon.");
  // switching is one tap and never waits: Mari's text saves in the background
  await chip(page, anu.id).click();
  await note(page, anu.id, 1).fill("Anu: kulmud analüüsitud.");
  await general(page, anu.id).fill("Anu: tubli töö!\nHarjuta värvimist.");
  await saved(page, anu.id);
  await expect(chip(page, mari.id)).toHaveAttribute("data-status", "draft");
  await expect(chip(page, mari.id).locator("[data-unsaved]")).toHaveCount(0);
  await expect(chip(page, anu.id)).toHaveAttribute("data-status", "draft");
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 1, stages: [{ title: "Ettevalmistus", note: "Mari: ühtlane joon." }, ...emptyNotes(2)], generalNote: "", sentAt: null });
  expect(await storedProtocol(anu.id)).toMatchObject({ stages: [{ note: "" }, { title: "Kulmude analüüs", note: "Anu: kulmud analüüsitud." }, { note: "" }], generalNote: "Anu: tubli töö!\nHarjuta värvimist." });
  // a reload shows what is stored
  await page.reload();
  await adminReady(page);
  await chip(page, mari.id).click();
  await expect(note(page, mari.id, 0)).toHaveValue("Mari: ühtlane joon.");
});

test("Review Focus 1: answers lost on the way, then no network and a reload: nothing is lost, no conflict, stored once the network is back (§10 e2e 2)", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("wifi", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  page.on("dialog", (dialog) => void dialog.accept()); // "leave the page?" while a text is not confirmed: yes (the reload below)
  await page.goto(`/admin/protokollid?sessioon=${fx.session.id}`);
  await adminReady(page);
  // 1. each save reaches the server, but its answer never comes back to the tablet
  await page.route(SAVE, async (route) => {
    await route.fetch({ headers: await route.request().allHeaders() }).catch(() => null); // (the admin's cookie with it)
    await route.abort("connectionreset");
  });
  await note(page, mari.id, 0).fill("Esimene lause.");
  await expect(saveStatus(page, mari.id)).toHaveAttribute("data-save-status", "retrying", { timeout: 20_000 });
  await expect(saveStatus(page, mari.id)).toHaveText("Salvestamata — proovin uuesti");
  await expect.poll(async () => (await storedProtocol(mari.id))?.stages[0].note).toBe("Esimene lause."); // stored, unknown to the tablet
  await note(page, mari.id, 0).fill("Esimene lause. Teine lause.");
  // 2. no network at all, and the tablet reloads the page: the text comes back from this browser
  await page.unroute(SAVE);
  await page.route(SAVE, (route) => route.abort("internetdisconnected"));
  await page.reload();
  await adminReady(page);
  await expect(note(page, mari.id, 0)).toHaveValue("Esimene lause. Teine lause.");
  // 3. the network is back (the "online" event: the autosave tries at once)
  await page.unroute(SAVE);
  await context.setOffline(true);
  await context.setOffline(false);
  await saved(page, mari.id);
  await expect(editor(page, mari.id).locator("[data-conflict]")).toHaveCount(0);
  expect(await storedProtocol(mari.id)).toMatchObject({ stages: [{ note: "Esimene lause. Teine lause." }, ...emptyNotes(2)], sentAt: null });
  expect(await keptKeys(page, mari.id)).toEqual([]); // the browser's copy is gone once confirmed
});

test("'Täna' opens the day's screen; 'Lukusta ja saada kõik' names who gets one and who is skipped, sends, and the student reads hers (§10 e2e 3)", async ({ page, context, visitorIp, browser }, info) => {
  const fx = await fixtures("send", runName(info), ["Mari Maasikas", "Anu Aas"]);
  const [mari, anu] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created); // lands on the overview
  await adminReady(page);
  const today = page.locator(`[data-today-session="${fx.session.id}"]`);
  await expect(today).toContainText("E2E protokollikoolitus");
  await expect(today).toContainText("Õpilasi: 2");
  await today.getByRole("link", { name: "Protokollid" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?sessioon=${fx.session.id}$`));
  await adminReady(page);
  await chip(page, mari.id).click();
  await note(page, mari.id, 0).fill("Ühtlane joon, hea kuju.");
  await general(page, mari.id).fill("Tubli töö!\nHarjuta veel värvimist.");
  await saved(page, mari.id);
  // Anu's is empty: skipped, and named
  await page.locator("[data-send-all-open]").click();
  const confirm = page.locator("[data-send-confirm]");
  await expect(confirm.locator("[data-confirm-will]")).toContainText("Mari Maasikas");
  await expect(confirm.locator("[data-confirm-skipped]")).toContainText("Anu Aas");
  await confirm.locator("[data-confirm-send]").click();
  await expect(page.locator("[data-summary-sent]")).toContainText("Mari Maasikas");
  await expect(chip(page, mari.id)).toHaveAttribute("data-status", "sent");
  await expect(chip(page, anu.id)).toHaveAttribute("data-status", "none");
  await expect(editor(page, mari.id).locator("[data-locked]")).toBeVisible();
  await expect(note(page, mari.id, 0)).toHaveAttribute("readonly", "");
  // (two boxes, so two saves: leaving the first one saved it at once, the general notes 1.5 s after; what was sent is the last one)
  const sent = (await storedProtocol(mari.id))!;
  expect(sent.sentVersion).toBe(sent.version);
  expect(sent).toMatchObject({ sent: { stages: [{ note: "Ühtlane joon, hea kuju." }, ...emptyNotes(2)], generalNote: "Tubli töö!\nHarjuta veel värvimist." } });
  expect(await storedProtocol(anu.id)).toBeNull();
  // the send made her account and linked her registration: she signs in and opens it from her card
  const student = await studentPage(browser, mari.email, visitorIp);
  const s = student.page;
  await s.evaluate(watchNotFound, NOT_FOUND); // (a MutationObserver: the dashboard and the page are one document, a card's <Link> is a client navigation)
  await s.locator(`[data-card="registration-${mari.id}"] [data-card-protocol]`).click();
  await expect(s).toHaveURL(new RegExp(`/konto/protokoll#id=${mari.id}$`));
  const protocol = s.locator("[data-protocol-page]");
  await expect(protocol.locator("h1")).toHaveText("E2E protokollikoolitus");
  for (const text of ["Ettevalmistus", "Ühtlane joon, hea kuju.", "Üldised märkused", "Harjuta veel värvimist."]) await expect(protocol).toContainText(text);
  expect(await sawNotFound(s), `"${NOT_FOUND.text}" was on the page in some frame of the card's navigation`).toBe(false);
  // back to the dashboard: "Tagasi" is the way, and the card is still there
  await protocol.locator("[data-protocol-back]").click();
  await expect(s.locator("[data-account-dashboard]")).toBeVisible();
  await expect(s.locator(`[data-card="registration-${mari.id}"] [data-card-protocol]`)).toBeVisible();
  // and the browser's own Back and Back again over the same pages (the page, then the dashboard)
  await s.goBack();
  await expect(s.locator("[data-protocol-page]")).toContainText("Harjuta veel värvimist.");
  await s.goBack();
  await expect(s.locator("[data-account-dashboard]")).toBeVisible();
  expect(await sawNotFound(s), `"${NOT_FOUND.text}" was on the page in some frame on the way back`).toBe(false);
  await student.close();
});

test("the protocol mail's button: /api/konto/verify?t=…&p=<registration> signs her in and lands on her protocol (§5)", async ({ browser, visitorIp }, info) => {
  const fx = await fixtures("mail", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await insertSentProtocol(mari.id, ["Ühtlane joon, hea kuju.", "", "Pehme üleminek."], "Tubli töö!");
  const context = await studentContext(browser, visitorIp, "mail");
  try {
    const page = await context.newPage();
    const token = await mintLoginToken(mari.email); // the login the mail carries (its link is /api/konto/verify?t=<token>&p=<registration>)
    await context.addInitScript(watchNotFound, NOT_FOUND); // (in every document of this context, before its own scripts)
    await page.goto(`/api/konto/verify?t=${token}&p=${mari.id}`);
    await expect(page).toHaveURL(/\/konto\/protokoll(#.*)?$/);
    const protocol = page.locator("[data-protocol-page]");
    await expect(protocol.locator("h1")).toHaveText("E2E protokollikoolitus");
    for (const text of ["Ühtlane joon, hea kuju.", "Pehme üleminek.", "Tubli töö!"]) await expect(protocol).toContainText(text);
    expect(await sawNotFound(page), `"${NOT_FOUND.text}" was on the page in some frame of the mail's landing`).toBe(false);
    expect((await page.context().cookies()).some((c) => c.name === "__Host-mslab_client")).toBe(true);
    // the login mark is used up: the address keeps the id only, so a reload shows the same protocol
    await page.reload();
    await expect(page.locator("[data-protocol-page]")).toContainText("Pehme üleminek.");
  } finally {
    await context.close();
  }
});

test("from the registration's drawer: 'Saada', 'Muuda', an edit, 'Saada uuesti'; the student reads the new text (§10 e2e 4)", async ({ page, context, visitorIp, browser }, info) => {
  const fx = await fixtures("resend", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto(`/admin/registreerimised?id=${mari.id}`);
  await adminReady(page);
  await page.locator("[data-registration-protocol]").click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?registreering=${mari.id}$`));
  await adminReady(page);
  await note(page, mari.id, 0).fill("Esimene versioon.");
  await saved(page, mari.id);
  await editor(page, mari.id).locator('[data-send="first"]').click(); // one registration's screen: "Saada" is its primary button
  await expect(editor(page, mari.id).locator("[data-locked]")).toBeVisible();
  // "Muuda" only unlocks the screen: nothing changes until an edit is saved
  await editor(page, mari.id).locator("[data-edit]").click();
  await expect(editor(page, mari.id).locator("[data-editing]")).toBeVisible();
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 1, sentVersion: 1 });
  await note(page, mari.id, 0).fill("Teine versioon.");
  await saved(page, mari.id);
  const again = editor(page, mari.id).locator('[data-send="again"]');
  await expect(again).toHaveText("Saada uuesti");
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 2, sentVersion: 1, sent: { stages: [{ note: "Esimene versioon." }, ...emptyNotes(2)] } });
  // the student still reads the first version until it is sent again
  const student = await studentPage(browser, mari.email, visitorIp);
  await student.page.goto(`/konto/protokoll#id=${mari.id}`);
  await expect(student.page.locator("[data-protocol-page]")).toContainText("Esimene versioon.");
  await again.click();
  await expect(editor(page, mari.id).locator("[data-locked]")).toBeVisible();
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 2, sentVersion: 2, sent: { stages: [{ note: "Teine versioon." }, ...emptyNotes(2)] } });
  await student.page.reload();
  await expect(student.page.locator("[data-protocol-page]")).toContainText("Teine versioon.");
  await expect(student.page.locator("[data-protocol-page]")).not.toContainText("Esimene versioon.");
  await student.close();
});

test("the feedback card, the form sent, the card gone; Maria reads the answer on Tagasiside (§10 e2e 5)", async ({ page, context, visitorIp, browser }, info) => {
  const fx = await fixtures("feedback", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await insertSentProtocol(mari.id, ["Ühtlane joon."], "Tubli töö!");
  // her first login makes her account and links the registration (phase 2a)
  const student = await studentPage(browser, mari.email, visitorIp);
  const s = student.page;
  const card = s.locator(`[data-feedback-card="${mari.id}"]`);
  await expect(card).toContainText("Kuidas koolitus läks?");
  await card.locator("[data-feedback-open]").click();
  await expect(s).toHaveURL(new RegExp(`/konto/tagasiside#id=${mari.id}$`));
  const form = s.locator("[data-feedback-form]");
  await expect(form.locator("h1")).toHaveText("Sinu kogemus MS LAB koolitusel");
  await form.locator("[data-feedback-submit]").click();
  await expect(form.locator("[data-feedback-error]")).toHaveText("Vasta vähemalt ühele küsimusele.");
  await form.locator('[data-question="score"] input[value="9"]').check();
  await form.locator('[data-question="expectations"] input[value="met"]').check();
  await form.locator('[data-question="message"] textarea').fill("Aitäh, väga hea päev!");
  await form.locator("[data-feedback-submit]").click();
  const done = s.locator('[data-feedback-done="done"]');
  await expect(done).toContainText("Aitäh, et oled osa MS LAB koolituskeskuse algusest ja kasvust. Sinu tagasiside aitab meil saada veel paremaks!");
  const stored = (await storedFeedback(mari.id))!;
  expect(stored).toMatchObject({ answers: { score: 9, expectations: "met", message: "Aitäh, väga hea päev!" }, locale: "et", submitted: true, dismissed: false });
  await done.getByRole("link", { name: "Minu koolitused" }).click();
  await expect(s.locator("[data-account-dashboard]")).toBeVisible();
  await expect(s.locator("[data-feedback-card]")).toHaveCount(0);
  await student.close();
  // Maria's Tagasiside: the answer listed with its score, its words in the drawer
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto("/admin/tagasiside");
  await adminReady(page);
  const row = page.locator(`[data-feedback-row="${stored.id}"]`);
  await expect(row).toContainText("9/10");
  await row.getByRole("link", { name: "Mari Maasikas" }).click();
  const detail = page.locator(`[data-feedback-detail="${stored.id}"]`);
  await expect(detail).toContainText("Kas koolitus vastas sinu ootustele?");
  await expect(detail).toContainText("Vastas ootustele");
  await expect(detail).toContainText("Aitäh, väga hea päev!");
});

test("'Ei soovi': a course that was yesterday offers the form by its date; the card goes for good (§10 e2e 6)", async ({ browser, visitorIp }, info) => {
  const fx = await fixtures("dismiss", runName(info), ["Mari Maasikas"], { day: -1 });
  const [mari] = fx.students;
  const student = await studentPage(browser, mari.email, visitorIp);
  const s = student.page;
  const card = s.locator(`[data-feedback-card="${mari.id}"]`);
  await expect(card).toBeVisible();
  await card.locator("[data-feedback-dismiss]").click();
  await expect(card).toHaveCount(0);
  expect(await storedFeedback(mari.id)).toMatchObject({ answers: null, submitted: false, dismissed: true });
  await s.reload();
  await expect(s.locator("[data-account-dashboard]")).toBeVisible();
  await expect(s.locator("[data-feedback-card]")).toHaveCount(0);
  await student.close();
});

test("the screens at 390, 834, 1194 and 1440 px: no sideways scroll, every target 44 px (§10 e2e 7)", async ({ page, context, visitorIp, browser, isMobile }, info) => {
  test.skip(isMobile, "sets its own widths: the desktop project only");
  // Mari's is sent (read-only, "Muuda"), Anu's is a draft (so the confirmation lists her), Eva's is empty (skipped); Anu has answered the form
  const fx = await fixtures("look", runName(info), ["Mari Maasikas", "Anu Aas", "Eva Esimene"]);
  const [mari, anu] = fx.students;
  await insertSentProtocol(mari.id, ["Ühtlane joon, hea kuju. ".repeat(20)], "Tubli töö!");
  await insertDraftProtocol(anu.id, ["Kulmud analüüsitud.", "", ""], "");
  await insertFeedbackAnswer(anu.id, { score: 8, expectations: "exceeded", recommend: "Jah, kindlasti." });
  await signInAsAdmin(page, context, visitorIp, created);
  const student = await studentPage(browser, mari.email, visitorIp);
  const screens = [
    { page, url: `/admin/protokollid?sessioon=${fx.session.id}`, scope: "[data-protocol-screen]", admin: true },
    // … with "Lukusta ja saada kõik" asking (who gets one, who is skipped, who has hers already)
    { page, url: `/admin/protokollid?sessioon=${fx.session.id}`, scope: "[data-protocol-screen]", admin: true, open: "[data-send-all-open]", shown: "[data-send-confirm]" },
    { page, url: "/admin/tagasiside", scope: "main", admin: true },
    { page: student.page, url: `/konto/protokoll#id=${mari.id}`, scope: "[data-protocol-page]", admin: false },
    { page: student.page, url: `/konto/tagasiside#id=${mari.id}`, scope: "[data-feedback-form]", admin: false },
  ];
  for (const width of [390, 834, 1194, 1440]) {
    for (const v of screens) {
      await v.page.setViewportSize({ width, height: 900 });
      await v.page.goto(v.url);
      if (v.admin) await adminReady(v.page);
      const scope = v.page.locator(v.scope);
      await expect(scope).toBeVisible();
      if (v.open) {
        await v.page.locator(v.open).click();
        await expect(v.page.locator(v.shown)).toBeVisible();
      }
      const where = `${v.url}${v.open ? " (asking)" : ""} at ${width} px`;
      expect(await noOverflow(v.page), where).toBe(true);
      expect(await smallTargets(scope), where).toEqual([]);
    }
  }
  await student.close();
});


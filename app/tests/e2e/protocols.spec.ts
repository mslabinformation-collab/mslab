import type { Page } from "@playwright/test";
import { clientEmail, mintLoginToken } from "./account";
import { adminReady, signInAsAdmin } from "./admin-login";
import {
  chip, E2E_HEADINGS, editor, emptyNotes, general, insertDraftProtocol, insertFeedbackAnswer, insertIndividualRegistration, insertReview, insertSentProtocol, keptKeys, note,
  protocolRows, runName, saved, SAVE_ROUTE, saveStatus, saveWords, sendAllLines, sendAllYes,
  storedFeedback, storedProtocol, studentContext, studentPage,
} from "./protocols";
import { smallTargets } from "./targets";
import { test, expect } from "./test";

// Phase protocols (spec §10 "End to end"): Maria's course day — the headings in the course editor, two students written while switching between
// them, a dropped connection and a reload that lose nothing, „Saada kõigile ({n})“, the student reading hers (from her card and from the
// mail's button), "Muuda" and „Saada protokoll {eesnimi}le uuesti“ — and the feedback form from its card to Maria's Tagasiside, "Ei soovi", and the pages at 390,
// 834, 1194 and 1440 px. Every student is a sample address (`e2e-client-proto-…@example.test`, never mailed) on a course of the test's own;
// all of it is removed after each test. Under `next dev` and the production build (E2E_PROD_BUILD=1); the admin signs in as Dim (admin-login.ts).
// The autosave in a real browser (offline, Back, the server's refusals) is protocols-autosave.spec.ts; the locks on real Postgres are
// protocols-race.spec.ts.

const { created, fixtures } = protocolRows();
const SAVE = SAVE_ROUTE;

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
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
  // Protokolli punktid: three headings; the card autosaves (admin UX pass piece 3a: an unpublished course's cards save straight to the record)
  await page.goto(`/admin/koolitused/${fx.course.id}`);
  await adminReady(page);
  const stages = page.locator("[data-protocol-stages]");
  for (const [i, title] of E2E_HEADINGS.entries()) {
    await stages.locator("[data-add-stage]").click();
    await stages.locator(`[data-protocol-stage="${i}"]`).fill(title);
  }
  const stagesSaved = page.waitForResponse((r) => r.url().endsWith(`/api/admin/koolitus/${fx.course.id}/osa/protocolStages`) && r.status() === 200);
  await stages.locator(`[data-protocol-stage="${E2E_HEADINGS.length - 1}"]`).blur();
  await stagesSaved;
  await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-kind", "saved");
  // the session's drawer in Kalender: one tap to the course day's screen
  await page.goto(`/admin/kalender?id=${fx.session.id}`);
  await adminReady(page);
  await page.locator("[data-session-protocols]").click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?sessioon=${fx.session.id}$`));
  await adminReady(page);
  await expect(page.locator("[data-students] [data-student]")).toHaveCount(2);
  // the way back is the index (admin UX pass, README A3)
  await expect(page.getByRole("link", { name: "← Protokollid", exact: true })).toHaveAttribute("href", "/admin/protokollid");
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

test("answers lost on the way, then no network and a reload: nothing is lost, no conflict, stored once the network is back (§10 e2e 2)", async ({ page, context, visitorIp }, info) => {
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
  await expect(saveStatus(page, mari.id)).toHaveAttribute("data-save-kind", "retry", { timeout: 20_000 });
  await expect(saveWords(page, mari.id)).toHaveText("Salvestamata — proovin uuesti");
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

test("'Täna' (Ava protokollid →) opens the day's screen; „Saada kõigile (1)“ asks, naming who gets one and who is skipped, sends, and the student reads hers (§10 e2e 3)", async ({ page, context, visitorIp, browser }, info) => {
  const fx = await fixtures("send", runName(info), ["Mari Maasikas", "Anu Aas"]);
  const [mari, anu] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created); // lands on the overview
  await adminReady(page);
  const today = page.locator(`[data-today-session="${fx.session.id}"]`);
  await expect(today).toContainText("E2E protokollikoolitus");
  await expect(today).toContainText("2 õpilast · protokollid: 0 saadetud, 0 mustand, 2 alustamata");
  await today.getByRole("link", { name: "Ava protokollid →" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?sessioon=${fx.session.id}$`));
  await adminReady(page);
  await chip(page, mari.id).click();
  await note(page, mari.id, 0).fill("Ühtlane joon, hea kuju.");
  await general(page, mari.id).fill("Tubli töö!\nHarjuta veel värvimist.");
  await saved(page, mari.id);
  // Anu's is empty: skipped, and named
  await page.getByRole("button", { name: "Saada kõigile (1)", exact: true }).click();
  const confirm = page.locator("[data-send-confirm]");
  await expect(confirm).toContainText("Kas saadan 1 protokolli?");
  await expect(sendAllLines(page)).toHaveText(["Saavad protokolli: Mari Maasikas", "Jäävad vahele, sest protokoll on tühi: Anu Aas"]);
  await expect(page.locator("[data-send-all-open]")).toHaveCount(0); // (the question stands in the button's place)
  await expect(sendAllYes(page)).toHaveText("Jah, saada 1 protokolli");
  await sendAllYes(page).click();
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

test("from the registration's drawer: „Saada protokoll Marile“, 'Muuda', an edit, „… uuesti“; the student reads the new text (§10 e2e 4)", async ({ page, context, visitorIp, browser }, info) => {
  const fx = await fixtures("resend", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto(`/admin/registreerimised?id=${mari.id}`);
  await adminReady(page);
  await page.locator("[data-registration-protocol]").click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?registreering=${mari.id}$`));
  await adminReady(page);
  await expect(page.getByRole("link", { name: "← Protokollid", exact: true })).toHaveAttribute("href", "/admin/protokollid");
  await note(page, mari.id, 0).fill("Esimene versioon.");
  await saved(page, mari.id);
  const send = editor(page, mari.id).locator('[data-send="first"]');
  await expect(send).toHaveText("Saada protokoll Marile"); // her first name with S5's ending; no confirmation
  await send.click(); // one registration's screen: the send is its primary button
  await expect(editor(page, mari.id).locator("[data-locked]")).toBeVisible();
  // "Muuda" only unlocks the screen: nothing changes until an edit is saved
  await editor(page, mari.id).locator("[data-edit]").click();
  await expect(editor(page, mari.id).locator("[data-editing]")).toBeVisible();
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 1, sentVersion: 1 });
  await note(page, mari.id, 0).fill("Teine versioon.");
  await saved(page, mari.id);
  const again = editor(page, mari.id).locator('[data-send="again"]');
  await expect(again).toHaveText("Saada protokoll Marile uuesti");
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
  const card = s.locator(`[data-feedback-card="registration-${mari.id}"]`);
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
  const card = s.locator(`[data-feedback-card="registration-${mari.id}"]`);
  await expect(card).toBeVisible();
  await card.locator("[data-feedback-dismiss]").click();
  await expect(card).toHaveCount(0);
  expect(await storedFeedback(mari.id)).toMatchObject({ answers: null, submitted: false, dismissed: true });
  await s.reload();
  await expect(s.locator("[data-account-dashboard]")).toBeVisible();
  await expect(s.locator("[data-feedback-card]")).toHaveCount(0);
  await student.close();
});

test("the day's screen below 900 px keeps the chips (the phone top bar is above it, a sticky column would sit under it); from 1194 px the students stand in a column", async ({ page, context, visitorIp, isMobile }, info) => {
  test.skip(isMobile, "sets its own widths: the desktop project only");
  const fx = await fixtures("tablet", runName(info), ["Mari Maasikas", "Anu Aas"]);
  await signInAsAdmin(page, context, visitorIp, created);
  const students = page.locator("[data-students]");
  // an upright tablet (810, 820, 834 and 899 px) is a phone to the admin (the bar, no sidebar); 1194 px and 1440 px have the sidebar and the column
  for (const [width, height, column] of [[390, 844, false], [810, 1080, false], [834, 1112, false], [899, 1112, false], [1194, 834, true], [1440, 900, true]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`/admin/protokollid?sessioon=${fx.session.id}`);
    await adminReady(page);
    await expect(page.locator("[data-students] [data-student]")).toHaveCount(2);
    const where = `${width} px`;
    const css = await students.evaluate((el) => {
      const style = getComputedStyle(el);
      return { direction: style.flexDirection, position: style.position };
    });
    expect(css, where).toEqual(column ? { direction: "column", position: "sticky" } : { direction: "row", position: "static" });
    const [first, second] = await Promise.all([page.locator("[data-student]").nth(0).boundingBox(), page.locator("[data-student]").nth(1).boundingBox()]);
    if (column) {
      expect(second!.y, where).toBeGreaterThan(first!.y + first!.height - 1); // one under the other
    } else {
      if (width >= 810) expect(Math.abs(second!.y - first!.y), where).toBeLessThan(2); // side by side, in the page's flow (not under the 64 px bar)
      await expect(page.locator("aside")).toBeHidden();
    }
    expect(await noOverflow(page), where).toBe(true);
  }
});

test("the screens at 390, 834, 1194 and 1440 px: no sideways scroll, every target 44 px (§10 e2e 7)", async ({ page, context, visitorIp, browser, isMobile }, info) => {
  test.skip(isMobile, "sets its own widths: the desktop project only");
  // Mari's is sent (read-only, "Muuda"), Anu's is a draft (so the confirmation lists her), Eva's is empty (skipped); Anu has answered the form
  const fx = await fixtures("look", runName(info), ["Mari Maasikas", "Anu Aas", "Eva Esimene"]);
  const [mari, anu] = fx.students;
  await insertSentProtocol(mari.id, ["Ühtlane joon, hea kuju. ".repeat(20)], "Tubli töö!");
  await insertDraftProtocol(anu.id, ["Kulmud analüüsitud.", "", ""], "");
  await insertFeedbackAnswer(anu.id, { score: 8, expectations: "exceeded", recommend: "Jah, kindlasti." });
  const answer = (await storedFeedback(anu.id))!;
  // „Arvustused“ (student reviews, Task 4): Anu's pending review of that answer, and one Maria added (every button of every kind is measured)
  await insertReview(fx.course.id, answer.id, "Anu A.", "Jah, kindlasti. ".repeat(12));
  await insertReview(fx.course.id, null, "Liis L.", "Väga hea koolitus, soovitan!");
  await signInAsAdmin(page, context, visitorIp, created);
  const student = await studentPage(browser, mari.email, visitorIp);
  const screens = [
    { page, url: `/admin/protokollid?sessioon=${fx.session.id}`, scope: "[data-protocol-screen]", admin: true },
    // … the index in front of it (today's session is there)
    { page, url: "/admin/protokollid", scope: "[data-protocol-index]", admin: true },
    // … with „Saada kõigile (1)“ asking (who gets one, who is skipped, who has hers already)
    { page, url: `/admin/protokollid?sessioon=${fx.session.id}`, scope: "[data-protocol-screen]", admin: true, open: "[data-send-all-open]", shown: "[data-send-confirm]" },
    { page, url: "/admin/tagasiside", scope: "main", admin: true },
    // … one course's numbers (the average and every option's count), and one answer's drawer
    { page, url: `/admin/tagasiside?koolitus=${fx.course.id}`, scope: "main", admin: true },
    { page, url: `/admin/tagasiside?koolitus=${fx.course.id}&id=${answer.id}`, scope: "dialog[open]", admin: true },
    // … the reviews' view (the waiting one and the one Maria added), and „Lisa arvustus“ open
    { page, url: "/admin/tagasiside?vaade=arvustused", scope: "main", admin: true },
    { page, url: "/admin/tagasiside?vaade=arvustused", scope: "main", admin: true, open: "[data-review-add]", shown: "[data-review-form]" },
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
      // (a switch's target is its row of 44 px, not its 48×28 checkbox: the reviews' „Avalehel“, admin UX pass piece 4c)
      expect((await smallTargets(scope)).filter((html) => !SWITCH.test(html)), where).toEqual([]);
    }
  }
  await student.close();
});


/** A switch's checkbox (components/admin/Switch.tsx): its touch target is the row of 44 px round it. */
const SWITCH = /^<input[^>]*\srole="switch"/;

/** The menu's „Protokollid“ row: the sidebar's on a wide screen, the menu panel's (opened here) on a phone. */
async function protocolsRow(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page.getByRole("button", { name: "Ava menüü" }).click();
    await expect(page.locator("[data-admin-drawer]")).toBeVisible();
    return page.locator('[data-admin-drawer] a[data-nav="protocols"]');
  }
  return page.locator('aside a[data-nav="protocols"]');
}

test("Protokollid: the menu's row; the index of today and the 14 days before it with each day's counts; „Ava“ to the screen; the open individual registrations (B8, B16)", async ({ page, context, visitorIp, isMobile }, info) => {
  const project = runName(info);
  const day = await fixtures("index", project, ["Mari Maasikas", "Anu Aas", "Kati Kask"]); // 10:00 today
  const past = await fixtures("index-past", project, ["Eve Esi"], { day: -3 });
  const old = await fixtures("index-old", project, ["Siiri Sepp"], { day: -15 }); // 15 days ago: Kalender has it, the index does not
  const [mari, anu] = day.students;
  await insertSentProtocol(mari.id, ["Ühtlane joon.", "", ""], "Tubli töö!");
  await insertDraftProtocol(anu.id, ["Kulmud analüüsitud.", "", ""], "");
  await insertSentProtocol(past.students[0].id, ["Hea töö.", "", ""], "Tubli!");
  const piret = await insertIndividualRegistration(day.course.id, "Piret Kalda", clientEmail("proto-index-ind", project));
  await signInAsAdmin(page, context, visitorIp, created); // lands on the overview
  await adminReady(page);

  // The menu's row opens the index — or, on a day with exactly one session, that session (B16: tests/unit/menu.test.ts has both). The shared test
  // database can hold other tests' sessions of today, so which of the two it is is read from the row's own address; each is checked for what it is.
  const row = await protocolsRow(page, isMobile);
  await expect(row).toHaveAttribute("href", /^\/admin\/protokollid(\?sessioon=\d+)?$/);
  const straight = ((await row.getAttribute("href")) ?? "").includes("?");
  await row.click();
  await expect(page).toHaveURL(straight ? /\/admin\/protokollid\?sessioon=\d+$/ : /\/admin\/protokollid$/);
  await adminReady(page);
  await expect(page.locator(straight ? "[data-protocol-screen]" : "[data-protocol-index]")).toBeVisible();
  if (straight) {
    await page.goto("/admin/protokollid");
    await adminReady(page);
  }

  const index = page.locator("[data-protocol-index]");
  await expect(page.locator("h1")).toHaveText("Protokollid");
  await expect(page.getByText("Täna ja viimased 14 päeva. Vanemad leiad Kalendrist.")).toBeVisible();
  // today: „Täna“, the course, the time and place, the counts, and an ink „Ava“
  const today = index.locator(`[data-index-session="${day.session.id}"]`);
  await expect(today).toContainText("Täna");
  await expect(today).toContainText("E2E protokollikoolitus");
  await expect(today).toContainText("10:00 · Pärnu, MS LAB stuudio");
  await expect(today.locator("[data-index-counts]")).toHaveText("3 õpilast · 1 saadetud · 1 mustand");
  await expect(today.locator("[data-index-counts]")).toHaveCSS("color", "rgb(107, 79, 92)"); // #6b4f5c while incomplete
  await expect(today.locator("[data-index-open]")).toHaveText("Ava");
  await expect(today.locator("[data-index-open]")).toHaveCSS("background-color", "rgb(34, 34, 34)");
  // three days ago: its date, everything sent in green, an outline „Ava“; today stands above it
  const earlier = index.locator(`[data-index-session="${past.session.id}"]`);
  await expect(earlier).not.toContainText("Täna");
  await expect(earlier).toContainText(/\d\d\.\d\d/);
  await expect(earlier.locator("[data-index-counts]")).toHaveText("✓ Kõik 1 saadetud");
  await expect(earlier.locator("[data-index-counts]")).toHaveCSS("color", "rgb(47, 93, 70)"); // #2f5d46
  await expect(earlier.locator("[data-index-open]")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const [above, below] = await Promise.all([today.boundingBox(), earlier.boundingBox()]);
  expect(above!.y).toBeLessThan(below!.y);
  await expect(index.locator(`[data-index-session="${old.session.id}"]`)).toHaveCount(0);
  // the individual registrations, under a heading shown in capitals
  const section = index.locator("[data-index-individual]");
  await expect(section.locator("h2")).toHaveText("Individuaalkoolitused");
  await expect(section.locator("h2")).toHaveCSS("text-transform", "uppercase");
  const individual = section.locator(`[data-index-registration="${piret.id}"]`);
  await expect(individual).toContainText("Aeg kokkuleppel");
  await expect(individual).toContainText("Piret Kalda");
  await expect(individual).toContainText("E2E protokollikoolitus");
  await expect(individual.locator("[data-index-state]")).toHaveText("Alustamata");

  // „Ava“ of the earlier day: its screen; Back: the index; „Ava“ of the individual registration: hers
  await earlier.locator("[data-index-open]").click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?sessioon=${past.session.id}$`));
  await expect(page.locator("[data-protocol-course]")).toHaveText("E2E protokollikoolitus");
  await expect(editor(page, past.students[0].id)).toBeVisible(); // (one student: no chips, her protocol is open)
  await page.goBack();
  await expect(page.locator("[data-protocol-index]")).toBeVisible();
  await page.locator(`[data-index-registration="${piret.id}"] [data-index-open]`).click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?registreering=${piret.id}$`));
  await expect(page.locator("[data-protocol-screen]")).toBeVisible();
  await expect(page.locator("[data-protocol-course]")).toHaveText("E2E protokollikoolitus");
});

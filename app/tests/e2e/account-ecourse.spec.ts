import type { Page, Response } from "@playwright/test";
import { formatDate } from "../../src/i18n/format";
import {
  clientEmail, currentTermsVersion, E2E_TERMS, insertEcourseAccess, removeTermsPage, SEED_ECOURSE_SLUG, setTerms, signInAsClient, storedAcceptances, takeTerms,
} from "./account";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { LOCAL_FIXTURES, LOCK_WAIT_MS, onLocalDb, removeAdminRows, removeClientRows } from "./fixtures";
import { PROD_BUILD } from "./target";
import { submitsForms, test, expect } from "./test";

// Phase 2a Task 7: an e-course in the account (/konto/kursus/<slug>) — "Sul ei ole sellele koolitusele ligipääsu.", the terms
// notice the student accepts once per terms version, the course view, and the admin's "E-koolituse tingimused" (Seaded), whose
// save asks everyone to accept again. Clients are sample addresses (`e2e-client-…@example.test`, never mailed) with rows written
// straight to the local database (account.ts). The terms text and version are shared by every client, so each test takes them
// (takeTerms: an advisory lock, a snapshot, restored afterwards) and the desktop and phone runs take turns.

// Every test signs a client in through a token row in the local database: a local server only, never a deployment.
test.skip(!LOCAL_FIXTURES, "signs in through the local database: runs against a local server only");

let restoreTerms: (() => Promise<void>) | null = null;
/** The addresses this worker's tests made rows for: removed after each test (the admin course list would show their courses). */
const made = new Set<string>();

test.beforeEach(async ({}, info) => {
  // the wait for the shared terms (another test may hold them for a while) is part of this test's time, not taken from it
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  restoreTerms = await takeTerms();
});

test.afterEach(async () => {
  try {
    for (const email of made) await removeClientRows(email);
    made.clear();
  } finally {
    await restoreTerms?.();
    restoreTerms = null;
  }
});

/**
 * A fresh client (with access to the seed e-course, or its own unpublished one, or none) signed in on `page`; /konto is open. She has a name
 * („E2E Õpilane“) unless `name` says otherwise: an account with none gives hers at the gate (contracts, ruling R19).
 */
async function signedIn(page: Page, label: string, project: string, opts: { own?: boolean; access?: boolean; locale?: "et" | "ru"; name?: string } = {}) {
  const email = clientEmail(label, project);
  made.add(email);
  await removeClientRows(email);
  const course = await insertEcourseAccess(email, { name: "E2E Õpilane", ...opts });
  await signInAsClient(page, email);
  return { email, ...course };
}

/**
 * Seaded's page-wide „Salvesta“. Seaded has a second one since the Järelmaks (Inbank) card (instalments, `data-financing-save`, which saves its own toggle),
 * so the button is asked for without that one.
 */
const seadedSave = (page: Page) => page.getByRole("button", { name: "Salvesta", exact: true }).and(page.locator(":not([data-financing-save])"));
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const gate = (page: Page) => page.locator("[data-terms-gate]");
const box = (page: Page) => gate(page).getByRole("checkbox", { name: "Olen tutvunud ja nõustun tingimustega" });
const start = (page: Page) => gate(page).getByRole("button", { name: "Alusta koolitust" });
const courseView = (page: Page) => page.locator("[data-ecourse]");
const path = (slug: string, ru = false) => `${ru ? "/ru" : ""}/konto/kursus/${slug}`;
const paragraphs = (text: string) => text.split("\n\n");

/** Opens the course from the dashboard's "Ava koolitus" (the real way in) and waits for the page's own load to finish. */
async function openFromDashboard(page: Page, slug: string) {
  await page.goto("/konto");
  await page.locator(`[data-card="course-${slug}"]`).getByRole("link", { name: "Ava koolitus" }).click();
  await expect(page).toHaveURL(new RegExp(`/konto/kursus/${slug}$`));
}

/** Ticks the box and presses "Alusta koolitust"; the POST's answer. */
async function accept(page: Page) {
  await box(page).check();
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/konto/tingimused") && r.request().method() === "POST");
  await start(page).click();
  return answer;
}

test("without access: one sentence, a button to the public course page and a link to her account (where an ended access's certificate is), not the error; an unknown course is the same", async ({ page }, info) => {
  const c = await signedIn(page, "noaccess", info.project.name, { access: false });
  expect(c.expiresAt).toBeNull();
  await page.goto(path(c.slug));
  const state = page.locator("[data-account-state='noAccess']");
  await expect(state.getByRole("heading", { level: 1 })).toHaveText("Sul ei ole sellele koolitusele ligipääsu.");
  await expect(state.getByRole("link")).toHaveText(["Vaata koolitust", "Minu konto"]);
  await expect(state.getByRole("link", { name: "Minu konto" })).toHaveAttribute("href", "/konto");
  await expect(state.getByRole("button")).toHaveCount(0);
  await expect(page.getByText(/Proovi uuesti|Ei õnnestunud/)).toHaveCount(0);
  await expect(gate(page)).toHaveCount(0);
  await expect(courseView(page)).toHaveCount(0);
  // the tab bar stays (at the top on a computer, at the bottom on a phone): the page is under "Minu koolitused"
  await expect(page.locator("[data-account-tabs]:visible")).toHaveCount(1);
  await expect(page.locator("[data-account-tabs]:visible").getByRole("link", { name: "Minu koolitused" })).toHaveAttribute("aria-current", "page");
  const link = page.getByRole("link", { name: "Vaata koolitust" });
  await expect(link).toHaveAttribute("href", `/koolitused/${c.slug}`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/koolitused/${c.slug}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(c.title.et);

  // a course that does not exist says the same thing (nothing about what exists is told)
  await page.goto(path("e2e-olematu-kursus"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sul ei ole sellele koolitusele ligipääsu.");
  // Russian
  await page.goto(path(c.slug, true));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("У вас нет доступа к этому курсу.");
  await expect(page.getByRole("link", { name: "Посмотреть курс" })).toHaveAttribute("href", `/ru/koolitused/${c.slug}`);
  // an address that cannot be a course is a 404 page
  const bad = await page.goto("/konto/kursus/Vale_Nimi");
  expect(bad?.status()).toBe(404);
});

test("a signed-out visitor is sent to the login page", async ({ page }) => {
  await page.goto(path(SEED_ECOURSE_SLUG));
  await expect(page).toHaveURL(/\/konto\/sisene$/);
});

test("the notice shows first: title, the text, one checkbox, one button that stays off until the box is ticked; nothing is stored yet", async ({ page }, info) => {
  const c = await signedIn(page, "gate", info.project.name);
  await openFromDashboard(page, c.slug);

  await expect(gate(page).getByRole("heading", { level: 1 })).toHaveText("Enne alustamist");
  // the contract's own title above its text (contracts, ruling R18): the page title of „E-koolituse leping (tingimused)“
  await expect(gate(page).locator("[data-terms-text]").getByRole("heading", { level: 2 })).toHaveText("E-koolituse tingimused");
  await expect(gate(page).locator("[data-legal-body] p")).toHaveText(paragraphs(E2E_TERMS.et));
  await expect(gate(page).getByRole("checkbox")).toHaveCount(1);
  await expect(gate(page).getByRole("textbox")).toHaveCount(0); // her account has a name: no field (R19)
  await expect(gate(page).getByRole("button")).toHaveCount(1);
  await expect(gate(page).getByRole("link")).toHaveCount(0);
  // a notice on the page, not a dialog that can be dismissed
  await expect(page.locator("dialog[open], [role='dialog']:visible")).toHaveCount(0);
  await expect(courseView(page)).toHaveCount(0);

  await expect(start(page)).toBeDisabled();
  await box(page).check();
  await expect(start(page)).toBeEnabled();
  await box(page).uncheck();
  await expect(start(page)).toBeDisabled();
  expect(await storedAcceptances(c.clientId)).toEqual([]);

  // The text is in the public legal pages' column (750 px at most: a computer reads it at that measure; a phone's screen is narrower
  // anyway), the button is directly under the checkbox and starts where it starts, and its targets are big enough.
  const viewport = page.viewportSize()!.width;
  const text = (await page.locator("[data-terms-text]").boundingBox())!;
  const label = (await page.locator("[data-terms-gate] label").boundingBox())!;
  const button = (await start(page).boundingBox())!;
  expect(text.width).toBeLessThanOrEqual(751);
  if (viewport <= 640) expect(text.width).toBeGreaterThan(viewport * 0.85);
  expect(label.y, "the box is under the text").toBeGreaterThan(text.y + text.height);
  expect(button.y, "the button is directly under the box").toBeGreaterThanOrEqual(label.y + label.height);
  expect(button.y - (label.y + label.height), "…and close to it").toBeLessThan(24);
  expect(Math.abs(button.x - label.x), "…starting where it starts").toBeLessThan(2);
  expect(button.height).toBeGreaterThanOrEqual(44);
  expect(label.height).toBeGreaterThanOrEqual(44);
  if (viewport <= 640) expect(button.width, "a phone gets the button across the screen").toBeGreaterThan(viewport * 0.85);
  // the live region for a failure is in the page when it is empty (a screen reader announces what appears in it), with no height
  const alert = page.locator("[data-terms-failed]");
  await expect(alert).toHaveAttribute("role", "alert");
  const shape = await alert.evaluate((el) => ({ display: getComputedStyle(el).display, height: el.getBoundingClientRect().height, visibility: getComputedStyle(el).visibility }));
  expect(shape.display).not.toBe("none");
  expect(shape.visibility).toBe("visible");
  expect(shape.height).toBe(0);
  expect(await noOverflow(page)).toBe(true);
});

test("the notice in Russian shows the Russian text", async ({ page }, info) => {
  const c = await signedIn(page, "gate-ru", info.project.name, { locale: "ru" });
  await page.goto(path(c.slug, true));
  await expect(gate(page).getByRole("heading", { level: 1 })).toHaveText("Перед началом");
  await expect(gate(page).locator("[data-legal-body] p")).toHaveText(paragraphs(E2E_TERMS.ru));
  await expect(gate(page).getByRole("checkbox", { name: "Ознакомлен(а) с условиями и принимаю их" })).toBeVisible();
  await expect(gate(page).getByRole("button", { name: "Начать обучение" })).toBeDisabled();
});

test("accepting shows the course: title, access end, the modules, one sentence (no lessons yet); the focus is on the title; the next visit skips the notice", async ({ page }, info) => {
  const c = await signedIn(page, "accept", info.project.name);
  await openFromDashboard(page, c.slug);
  const answer = await accept(page);
  expect(answer.status()).toBe(200);
  expect(answer.request().postDataJSON()).toEqual({ slug: c.slug, version: "1", locale: "et" }); // the page's language: the contract's (contracts, D6)

  await expect(gate(page)).toHaveCount(0);
  const heading = courseView(page).getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(c.title.et);
  await expect(heading).toBeFocused();
  await expect(page.locator("[data-ecourse-access]")).toHaveText(`Ligipääs kuni ${formatDate(c.expiresAt!, "et")}`);
  // the seed e-course has modules and no lessons yet (phase 3a): the module titles, no progress line and no button
  await expect(page.locator("[data-module]")).toHaveCount(c.modules.length);
  await expect(page.locator("[data-module] [data-module-title]")).toHaveText(c.modules.map((m) => m.et));
  await expect(page.locator("[data-ecourse-soon]")).toHaveText("Sisu lisandub peagi.");
  await expect(page.locator("[data-ecourse-progress]")).toHaveCount(0);
  await expect(page.locator("[data-ecourse-next]")).toHaveCount(0);
  // nothing else on the page: the title, the line, the modules, the sentence
  await expect(courseView(page).locator(":scope > *")).toHaveCount(4);
  await expect(courseView(page).getByRole("button")).toHaveCount(0);
  await expect(courseView(page).getByRole("link")).toHaveCount(0);
  expect(await storedAcceptances(c.clientId)).toEqual([{ slug: c.slug, version: "1" }]);

  // opening it again goes straight to the course, nothing is asked
  await page.reload();
  await expect(courseView(page).getByRole("heading", { level: 1 })).toHaveText(c.title.et);
  await expect(gate(page)).toHaveCount(0);
  expect(await storedAcceptances(c.clientId)).toHaveLength(1);

  // Russian: the Russian title, date line and sentence
  await page.goto(path(c.slug, true));
  await expect(page.locator("[data-ecourse-access]")).toHaveText(`Доступ до ${formatDate(c.expiresAt!, "ru")}`);
  await expect(page.locator("[data-ecourse-soon]")).toHaveText("Материалы скоро появятся.");
  await expect(courseView(page).getByRole("heading", { level: 1 })).toHaveText(c.title.ru);
});

test("rulings R18, R19: the gate shows the contract filled as it is frozen, and an account with no name gives hers — {nimi} fills as she types; it is saved and frozen", async ({ page }, info) => {
  const c = await signedIn(page, "noname", info.project.name, { name: "" });
  const version = (await setTerms({ et: "E2E leping: mina, {nimi} ({e-post}), alustan koolitust {koolitus}.\n\nTeine lõik {tundmatu}.", ru: "E2E договор: {nimi}." }))!;
  await openFromDashboard(page, c.slug);
  await expect(gate(page)).toHaveAttribute("data-terms-version", version);
  const text = gate(page).locator("[data-legal-body] p");
  await expect(text).toHaveText([`E2E leping: mina,  (${c.email}), alustan koolitust ${c.title.et}.`, "Teine lõik {tundmatu}."]);
  const name = gate(page).getByRole("textbox", { name: "Nimi" });
  await expect(name).toBeVisible();
  await expect(name).toHaveAttribute("required", "");
  // the field, the box and the button fit the column; the field is a 44 px target at least
  expect((await name.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await noOverflow(page)).toBe(true);

  // pressed without a name: nothing is sent, the field says so
  await box(page).check();
  await start(page).click();
  await expect(gate(page).locator("[data-terms-name-error]")).toHaveText("Kirjuta oma nimi.");
  await expect(name).toBeFocused();
  expect(await storedAcceptances(c.clientId)).toEqual([]);

  // {nimi} fills as she types, on one line
  await name.fill("  E2E   Nimeta ");
  await expect(text.first()).toHaveText(`E2E leping: mina, E2E Nimeta (${c.email}), alustan koolitust ${c.title.et}.`);
  await expect(gate(page).locator("[data-terms-name-error]")).toHaveText("");
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/konto/tingimused") && r.request().method() === "POST");
  await start(page).click();
  expect((await answer).status()).toBe(200);
  expect((await answer).request().postDataJSON()).toEqual({ slug: c.slug, version, locale: "et", name: "  E2E   Nimeta " });
  await expect(courseView(page).getByRole("heading", { level: 1 })).toHaveText(c.title.et);

  // frozen as shown, with her name in the parties; her account has it now
  const [row] = await onLocalDb(
    (sql) => sql<{ body: string; name: string; account: string }[]>`
      select k.body, k.fields->'student'->>'name' as name, c.name as account from contracts k join clients c on c.id = k.client_id where k.client_id = ${c.clientId}`,
    { marksPages: false },
  );
  expect(row).toEqual({ body: `E2E leping: mina, E2E Nimeta (${c.email}), alustan koolitust ${c.title.et}.\n\nTeine lõik {tundmatu}.`, name: "E2E Nimeta", account: "E2E Nimeta" });
});

test("an unpublished course with active access still opens: the notice, then the course", async ({ page }, info) => {
  const c = await signedIn(page, "hidden", info.project.name, { own: true });
  // it is not on the public site any more, but the student's access stays
  const publicPage = await page.request.get(`/koolitused/${c.slug}`, { failOnStatusCode: false });
  expect(publicPage.status()).toBe(404);
  await openFromDashboard(page, c.slug);
  await expect(gate(page).getByRole("heading", { level: 1 })).toHaveText("Enne alustamist");
  await accept(page);
  await expect(courseView(page).getByRole("heading", { level: 1 })).toHaveText("E2E e-koolitus");
  // its own course: two modules and no lessons
  await expect(page.locator("[data-module] [data-module-title]")).toHaveText(["Sissejuhatus", "Praktika"]);
  await expect(page.locator("[data-ecourse-soon]")).toHaveText("Sisu lisandub peagi.");
  await expect(page.locator("[data-ecourse-progress], [data-ecourse-next]")).toHaveCount(0);
  await expect(page.locator("[data-ecourse-access]")).toHaveText(`Ligipääs kuni ${formatDate(c.expiresAt!, "et")}`);
});

test("accept, then the admin saves new terms in Seaded: the next open shows the notice again with the new text", async ({ page, context, visitorIp }, info) => {
  submitsForms();
  const c = await signedIn(page, "readmin", info.project.name);
  await openFromDashboard(page, c.slug);
  await accept(page);
  await expect(courseView(page)).toBeVisible();
  expect(await storedAcceptances(c.clientId)).toEqual([{ slug: c.slug, version: "1" }]);

  const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
  try {
    await signInAsAdmin(page, context, visitorIp, created);
    await page.goto("/admin/seaded");
    await adminReady(page);
    const editor = page.locator('[data-legal-editor="course_terms"]');
    await expect(editor.getByRole("heading", { level: 2 })).toHaveText("E-koolituse leping (tingimused)");
    // next to privacy and terms; account-only, so no link to a public page
    await expect(page.locator("[data-legal-editor]")).toHaveCount(3);
    await expect(editor.getByRole("link")).toHaveCount(0);
    const body = editor.getByRole("textbox", { name: "Tekst (eesti keeles)", exact: true });
    await expect(body).toHaveValue(E2E_TERMS.et);
    await body.fill("E2E uued tingimused.\n\nTeine lõik muutus.");
    await seadedSave(page).click();
    await expect(page.locator("[data-save-status]")).toHaveText("Salvestatud.");
  } finally {
    await removeAdminRows(created);
  }
  const version = await currentTermsVersion();
  expect(version, "the save time").toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(Math.abs(Date.now() - new Date(version).getTime())).toBeLessThan(120_000);
  const page_ = await onLocalDb((sql) => sql<{ body: { et: string } }[]>`select body from pages where key = 'course_terms'`);
  expect(page_[0].body.et).toBe("E2E uued tingimused.\n\nTeine lõik muutus.");

  // the student opens the course again (a new visit): the notice, the new text, an empty box
  await page.goto(path(c.slug));
  await expect(gate(page).getByRole("heading", { level: 1 })).toHaveText("Enne alustamist");
  await expect(gate(page).locator("[data-legal-body] p")).toHaveText(["E2E uued tingimused.", "Teine lõik muutus."]);
  await expect(box(page)).not.toBeChecked();
  await expect(start(page)).toBeDisabled();
  await expect(courseView(page)).toHaveCount(0);

  // accepting stores the new version next to the old one
  const answer = await accept(page);
  expect(answer.request().postDataJSON()).toEqual({ slug: c.slug, version, locale: "et" });
  await expect(courseView(page).getByRole("heading", { level: 1 })).toHaveText(c.title.et);
  expect(await storedAcceptances(c.clientId)).toEqual([{ slug: c.slug, version: "1" }, { slug: c.slug, version }]);
});

test("a 409: new terms saved after the page loaded, before the click — the fresh text shows, the box is cleared, no message, nothing was stored", async ({ page }, info) => {
  const c = await signedIn(page, "stale", info.project.name);
  await openFromDashboard(page, c.slug);
  await expect(gate(page).locator("[data-legal-body] p")).toHaveText(paragraphs(E2E_TERMS.et));
  await box(page).check();

  // the admin saves new terms now (a DB write: the page does not know)
  const version = (await setTerms({ et: "E2E vahepeal muudetud tingimused.", ru: "E2E изменённые условия." }))!;
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/konto/tingimused") && r.request().method() === "POST");
  await start(page).click();
  expect((await answer).status()).toBe(409);
  expect((await answer).request().postDataJSON()).toEqual({ slug: c.slug, version: "1", locale: "et" }); // the page's language: the contract's (contracts, D6)

  // quietly loaded again: the new text, an empty box, the button off, and no message of any kind
  await expect(gate(page).locator("[data-legal-body] p")).toHaveText(["E2E vahepeal muudetud tingimused."]);
  await expect(gate(page)).toHaveAttribute("data-terms-version", version);
  await expect(box(page)).not.toBeChecked();
  await expect(start(page)).toBeDisabled();
  await expect(page.locator("[data-terms-failed]")).toHaveText("");
  await expect(page.getByText(/Ei õnnestunud|Proovi uuesti|aegunud|muutus/i)).toHaveCount(0);
  await expect(gate(page).getByRole("heading", { level: 1 })).toBeFocused();
  await expect(page.locator("[data-account-state]")).toHaveCount(0); // never went back to a loading state
  expect(await storedAcceptances(c.clientId)).toEqual([]);

  // reading the new text and accepting it works, and stores that version
  const second = await accept(page);
  expect(second.status()).toBe(200);
  expect(second.request().postDataJSON()).toEqual({ slug: c.slug, version, locale: "et" });
  await expect(courseView(page).getByRole("heading", { level: 1 })).toHaveText(c.title.et);
  expect(await storedAcceptances(c.clientId)).toEqual([{ slug: c.slug, version }]);
});

test("a 409 whose reload fails: the plain sentence, the box still ticked, nothing stored; when the server answers again, the new text and an empty box", async ({ page }, info) => {
  const c = await signedIn(page, "stalefail", info.project.name);
  await openFromDashboard(page, c.slug);
  await box(page).check();
  const version = (await setTerms({ et: "E2E uus tekst, kui laadimine õnnestub.", ru: "E2E новый текст." }))!;
  // the page cannot be loaded again right now
  const down = (route: { abort(code: string): Promise<void> }) => route.abort("failed");
  await page.route(`**/api/konto/kursus/${c.slug}`, down);
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/konto/tingimused") && r.request().method() === "POST");
  await start(page).click();
  expect((await answer).status()).toBe(409);
  await expect(page.locator("[data-terms-failed]")).toHaveText("Ei õnnestunud salvestada. Proovi uuesti.");
  await expect(box(page)).toBeChecked(); // not cleared silently
  await expect(gate(page).locator("[data-legal-body] p")).toHaveText(paragraphs(E2E_TERMS.et)); // still the text that was read
  await expect(start(page)).toBeEnabled();
  expect(await storedAcceptances(c.clientId)).toEqual([]);

  // asked again, with the page reachable: the new text, an empty box, no sentence
  await page.unroute(`**/api/konto/kursus/${c.slug}`, down);
  await start(page).click();
  await expect(gate(page)).toHaveAttribute("data-terms-version", version);
  await expect(gate(page).locator("[data-legal-body] p")).toHaveText(["E2E uus tekst, kui laadimine õnnestub."]);
  await expect(box(page)).not.toBeChecked();
  await expect(page.locator("[data-terms-failed]")).toHaveText("");
});

test("with no terms text stored there is nothing to accept: the course opens at once and nothing is recorded; a text added later brings the notice", async ({ page }, info) => {
  const c = await signedIn(page, "notext", info.project.name);
  await removeTermsPage();
  await openFromDashboard(page, c.slug);
  await expect(courseView(page).getByRole("heading", { level: 1 })).toHaveText(c.title.et);
  await expect(gate(page)).toHaveCount(0);
  expect(await storedAcceptances(c.clientId)).toEqual([]);
  // the same through the API, and a POST that arrives anyway is refused as a changed version (the page would load again)
  const view = await page.request.get(`/api/konto/kursus/${c.slug}`);
  expect(((await view.json()) as { terms: unknown }).terms).toEqual({ version: "1", accepted: true, text: null });
  const post = await page.request.post("/api/konto/tingimused", { data: { slug: c.slug, version: "1" }, headers: { origin: new URL(page.url()).origin } });
  expect(post.status()).toBe(409);
  expect(await storedAcceptances(c.clientId)).toEqual([]);

  // the admin writes the terms: from then on the notice shows
  const version = (await setTerms({ et: "E2E tingimused tulid hiljem.", ru: "E2E условия появились позже." }))!;
  await page.reload();
  await expect(gate(page)).toHaveAttribute("data-terms-version", version);
  await expect(gate(page).locator("[data-legal-body] p")).toHaveText(["E2E tingimused tulid hiljem."]);
  await expect(courseView(page)).toHaveCount(0);
});

test("if the answer does not come, one plain sentence stays with the box ticked, and pressing again works", async ({ page }, info) => {
  const c = await signedIn(page, "fail", info.project.name);
  await openFromDashboard(page, c.slug);
  await page.route("**/api/konto/tingimused", (route) => route.abort("failed"), { times: 1 });
  await box(page).check();
  await start(page).click();
  await expect(page.locator("[data-terms-failed]")).toHaveText("Ei õnnestunud salvestada. Proovi uuesti.");
  await expect(box(page)).toBeChecked();
  await expect(start(page)).toBeEnabled();
  expect(await storedAcceptances(c.clientId)).toEqual([]);
  await start(page).click();
  await expect(courseView(page)).toBeVisible();
  expect(await storedAcceptances(c.clientId)).toEqual([{ slug: c.slug, version: "1" }]);
});

test("no sideways scrolling at 390, 834, 1440 and 2560 px: no access, the notice, the course", async ({ page }, info) => {
  const c = await signedIn(page, "overflow", info.project.name);
  const widths = [390, 834, 1440, 2560];
  const sweep = async (what: string) => {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      expect(await noOverflow(page), `${what} at ${width}`).toBe(true);
    }
  };
  await page.goto(path("e2e-olematu-kursus"));
  await expect(page.locator("[data-account-state='noAccess']")).toBeVisible();
  await sweep("no access");
  await page.goto(path(c.slug));
  await expect(gate(page)).toBeVisible();
  await sweep("the notice");
  await accept(page);
  await expect(courseView(page)).toBeVisible();
  await sweep("the course");
});

test("the shell is static: a visit and the dashboard's link ask the API only for this client's own course, after the page has loaded", async ({ page, request }, info) => {
  const c = await signedIn(page, "static", info.project.name);
  // the page itself carries nothing personal and sets no cookie, with or without a session
  const shell = await request.get(path(c.slug));
  expect(shell.status()).toBe(200);
  expect(shell.headers()["set-cookie"]).toBeUndefined();

  const asked: string[] = [];
  const prefetched: Response[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/konto/kursus/")) asked.push(r.url());
  });
  page.on("response", (r) => {
    if (r.url().includes(`/konto/kursus/${c.slug}`) && r.url().includes("_rsc=")) prefetched.push(r);
  });
  await page.goto("/konto");
  await expect(page.locator(`[data-card="course-${c.slug}"]`)).toBeVisible();
  if (PROD_BUILD) {
    // the production build prefetches the link (a visible <Link>): the cached shell answers it, and the prefetch loads nothing personal
    await expect.poll(() => prefetched.length, { message: "the link's prefetch", timeout: 15_000 }).toBeGreaterThan(0);
    expect(prefetched[0].status()).toBe(200);
    expect(prefetched[0].headers()["set-cookie"]).toBeUndefined();
  }
  await page.waitForTimeout(800);
  expect(asked, "no personal request before the link is opened").toEqual([]);
  await page.locator(`[data-card="course-${c.slug}"]`).getByRole("link", { name: "Ava koolitus" }).click();
  await expect(gate(page)).toBeVisible();
  // (the dev server runs every effect twice: the first request is dropped at once)
  if (PROD_BUILD) expect(asked).toHaveLength(1);
  expect([...new Set(asked.map((u) => new URL(u).pathname))]).toEqual([`/api/konto/kursus/${c.slug}`]);
});

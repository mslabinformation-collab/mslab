import type { Browser, Locator, Page } from "@playwright/test";
import { addMonths, defaultExpiryDate, endOfDayTallinn, extendByMonths, tallinnToday } from "../../src/domain/client-access";
import { formatDate } from "../../src/i18n/format";
import { clientEmail, insertAccountFixtures, setPrepayment, signInAsClient, takeTerms, TEST_PREPAYMENT, type AccountCardKind } from "./account";
import { ADMIN, adminReady, seadedStatus, signInAsAdmin, type CreatedRows } from "./admin-login";
import { accountCourseSlug, holdLocalLock, insertStoredPayment, LOCK_WAIT_MS, onLocalDb, removeAdminRows, removeClientRows, snapshotRows } from "./fixtures";
import { insertLessonCourse, markDone, removeLessonFile } from "./lessons";
import { LOCAL_URL, TARGET } from "./target";
import { smallTargets } from "./targets";
import { submitsForms, test, expect } from "./test";

// Phase 2a Task 9: the admin's Õpilased — "Lisa õpilane", e-course access granted and ended (the student then sees it), the
// read-only "Vaata tema vaadet" (her session untouched), a change request in Päringud in words with a working link, and the
// prepayment instructions in Seaded reaching the student's card. The admin signs in as Dim through the devLink (dev server
// only, admin-login.ts); every student is a sample address (`e2e-client-adm-…@example.test`, never mailed) removed after each
// test. The student uses a browser of her own (another context), as she would. Phase 3a Task 10 adds her lessons: "5/24 tehtud" in
// the drawer, "Ava järgmine õppetund", and the read-only page of her course. Admin UX pass, A5 (Task 12): "Lisa õpilane +" opens the small form, the search
// is as she types (no "Otsi"), the form pills carry counts, the drawer lists her courses as cards ("Pikenda ▾", "Veel ▾" with "Ava järgmine õppetund" and
// "Lõpeta ligipääs" asking with a ConfirmPanel) and the rest in folded rows; B12 "Pikenda ▾" extends an access at once, with "Võta tagasi".

/** The addresses this worker's tests made rows for: removed after each test. */
const made = new Set<string>();
const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
/** The lesson files this worker's tests stored: removed after each test. */
const keys = new Set<string>();

test.beforeEach(() => submitsForms());

test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
  for (const key of keys) await removeLessonFile(key);
  keys.clear();
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
});

/** A fresh address for this test (its leftovers removed first). */
async function fresh(label: string, project: string): Promise<string> {
  const email = clientEmail(`adm-${label}`, project);
  made.add(email);
  await removeClientRows(email);
  return email;
}

/** A student's own browser, signed in, on her dashboard. */
async function studentBrowser(browser: Browser, email: string, ip: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL: TARGET || LOCAL_URL, extraHTTPHeaders: { "x-forwarded-for": `${ip}-student` } });
  const page = await context.newPage();
  await signInAsClient(page, email);
  await expect(page.locator("[data-account-dashboard]")).toBeVisible();
  return { page, close: () => context.close() };
}

const clientId = async (email: string): Promise<number> => (await onLocalDb((sql) => sql<{ id: number }[]>`select id from clients where email = ${email}`, { marksPages: false }))[0].id;
const sessions = (id: number) =>
  onLocalDb((sql) => sql<{ idHash: string; endedAt: Date | null; expiresAt: Date }[]>`select id_hash as "idHash", ended_at as "endedAt", expires_at as "expiresAt" from client_sessions where client_id = ${id} order by id_hash`, { marksPages: false });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const drawer = (page: Page) => page.locator("dialog[data-drawer]");
/**
 * A page of the panel that is not there. (panel)/loading.tsx puts every page inside a Suspense boundary, so the page's notFound() is
 * streamed after the shell: the answer is 200, not 404, and Next marks it noindex (the admin root layout has the tag already). So the
 * checks are the not-found text the admin sees and the noindex tag, never the status.
 */
const noindex = (page: Page) => expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
const card = (page: Page, key: string) => page.locator(`[data-card="${key}"]`);
/** „Veel ▾“ of an e-course card, and one of its items chosen from the menu. */
const veel = (row: Locator) => row.locator('[data-more="veel"] button[aria-haspopup="menu"]');
const chooseVeel = async (row: Locator, name: string) => {
  await veel(row).click();
  await row.getByRole("menuitem", { name, exact: true }).click();
};
/** A folded row of the drawer opened (by its title), and its content. */
const fold = (scope: Locator, title: string) => scope.locator("details[data-fold]", { has: scope.page().locator("summary", { hasText: title }) });
const openFold = async (scope: Locator, title: string) => {
  const row = fold(scope, title);
  if ((await row.getAttribute("open")) === null) await row.locator("summary").click();
  return row;
};

/** Opens a student's drawer from the list by searching her address. */
async function openStudent(page: Page, email: string): Promise<Locator> {
  await page.goto("/admin/opilased");
  await adminReady(page);
  await page.getByRole("searchbox", { name: "Otsi nime, e-posti või telefoni järgi" }).fill(email);
  await expect(page).toHaveURL(/[?&]otsi=/); // (as she types: after the toolbar's 300 ms)
  const rows = page.locator("tr[data-client]");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("link").first().click();
  await expect(drawer(page)).toBeVisible();
  return drawer(page);
}

test("guard: Õpilased and the student's view need an admin session", async ({ request }) => {
  for (const path of ["/admin/opilased", "/admin/opilased?id=1", "/admin/opilased/1/vaade", "/admin/opilased/1/vaade/e-koolitus"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect([303, 307, 308], path).toContain(res.status());
    expect(res.headers().location, path).toMatch(/\/admin\/login$/);
  }
});

test("Lisa õpilane by e-mail, Ava ligipääs → she logs in and sees the e-course; Lõpeta ligipääs → it is over", async ({ page, context, browser, visitorIp, isMobile }, info) => {
  const email = await fresh("add", info.project.name);
  // a draft e-course of this test without access months (removeClientRows deletes it): the grant form's default length
  const noLength = `E2E e-koolitus kestuseta ${info.project.name}`;
  await onLocalDb(
    (sql) => sql`insert into courses (slug, type, level, title, summary, body, price, access_months, published, sort)
      values (${accountCourseSlug(email)}, 'e_learning', 'basic', ${sql.json({ et: noLength })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 9500, null, false, 999)`,
    { marksPages: false },
  );
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto("/admin/opilased");
  await adminReady(page);
  await expect(page.locator("aside [data-nav='clients']")).toHaveAttribute("aria-current", "page"); // (a phone has it in the menu drawer)

  // "Lisa õpilane +" opens the small form (the field takes the focus); a bad address says what to do; a good one (as typed, any case) opens her drawer
  await expect(page.locator("[data-add-student]")).toHaveCount(0);
  await page.getByRole("button", { name: "Lisa õpilane +", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Lisa õpilane e-posti järgi" });
  await expect(field).toBeFocused();
  await field.fill("mari@");
  await page.getByRole("button", { name: "Lisa õpilane", exact: true }).click();
  await expect(page.locator("[data-add-student] [role='status']")).toHaveText("Sisesta korrektne e-posti aadress.");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await field.fill(`  ${email.toUpperCase()} `);
  await page.getByRole("button", { name: "Lisa õpilane", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/opilased\?id=\d+$/);
  const id = await clientId(email);
  expect(page.url()).toMatch(new RegExp(`id=${id}$`));
  const d = drawer(page);
  await expect(d).toBeVisible();
  await expect(d.getByRole("heading", { level: 2 })).toHaveText("Nimi puudub");
  await expect(d.getByRole("link", { name: email })).toHaveAttribute("href", `mailto:${email}`);
  await expect(d.locator("[data-client-courses]")).toContainText("Koolitusi veel pole.");
  await expect(page.locator("[data-add-student]")).toHaveCount(0); // the form starts again, closed
  expect(await sessions(id)).toEqual([]); // no session: she has never logged in

  // Ava ligipääs: the course picked, the date filled in with today + its 6 months; one press. A course without its own
  // length is filled in with 12 months, and the hint says so
  const foldRow = await openFold(d, "Ava ligipääs e-koolitusele");
  await expect(foldRow.locator("[data-fold-summary]")).toHaveText("vali koolitus");
  const grant = d.locator("[data-grant-form]");
  await grant.getByLabel("E-koolitus").selectOption({ label: `${noLength} · mustand` });
  await expect(grant.getByLabel("Ligipääs kuni")).toHaveValue(defaultExpiryDate(new Date(), null));
  await expect(grant.locator("[data-grant-hint]")).toHaveText("Koolitusel pole kestust määratud — täidetud 12 kuuga. Võid muuta.");
  await grant.getByLabel("E-koolitus").selectOption({ label: "Kulmumeistri e-koolitus" });
  const until = defaultExpiryDate(new Date(), 6);
  await expect(grant.getByLabel("Ligipääs kuni")).toHaveValue(until);
  await expect(grant.locator("[data-grant-hint]")).toHaveText("Täidetud koolituse ligipääsu kestusega tänasest. Võid muuta.");
  await expect(grant.getByLabel("Ligipääs kuni")).toHaveAttribute("min", tallinnToday(new Date()));
  // a day already gone is refused in plain words; a changed day clears the answer about the old one
  await grant.getByLabel("Ligipääs kuni").fill(addMonths(tallinnToday(new Date()), -1)!);
  await grant.getByRole("button", { name: "Ava ligipääs" }).click();
  await expect(grant.locator("[data-grant-status]")).toHaveText("Vali tänane või hilisem kuupäev.");
  await expect(grant.getByLabel("Ligipääs kuni")).toHaveAttribute("aria-invalid", "true");
  await grant.getByLabel("Ligipääs kuni").fill(until);
  await expect(grant.locator("[data-grant-status]")).toHaveText("");
  await grant.getByRole("button", { name: "Ava ligipääs" }).click();
  await expect(grant.locator("[data-grant-status]")).toHaveText("Ligipääs on avatud.");
  const shown = formatDate(new Date(`${until}T12:00:00Z`), "et");
  const row = d.locator("[data-access]");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-access-state", "active");
  await expect(row).toContainText("Kulmumeistri e-koolitus");
  await expect(row.locator("[data-access-pill]")).toHaveText(`Avatud kuni ${shown}`);
  await expect(row).toContainText(`Avas ${ADMIN}`);
  // a course she has open says until when in the list to pick from (granting it again stays possible)
  await expect(grant.getByLabel("E-koolitus").locator("option", { hasText: "Kulmumeistri e-koolitus" })).toHaveText(`Kulmumeistri e-koolitus · avatud kuni ${shown}`);
  const [stored] = await onLocalDb(
    (sql) => sql<{ grantedBy: string; revokedAt: Date | null }[]>`select granted_by as "grantedBy", revoked_at as "revokedAt" from course_access where client_id = ${id}`,
    { marksPages: false },
  );
  expect(stored).toEqual({ grantedBy: ADMIN, revokedAt: null });

  // she logs in (her own browser) and finds the e-course with its date and "Ava koolitus"
  const student = await studentBrowser(browser, email, visitorIp);
  try {
    const ecourse = card(student.page, "course-kulmumeistri-e-koolitus");
    await expect(ecourse.locator("[data-next-step]")).toHaveText(`Ligipääs kuni ${shown}.`);
    await expect(ecourse.getByRole("link", { name: "Ava koolitus" })).toBeVisible();
    expect(await clientId(email)).toBe(id); // the login found the student the admin added

    // Lõpeta ligipääs (under „Veel ▾“): a ConfirmPanel asks ("Katkesta" goes back to „Veel ▾“), then it is over, here and for her
    await chooseVeel(row, "Lõpeta ligipääs");
    const confirm = row.locator("[data-confirm-panel]");
    await expect(confirm).toBeFocused();
    await expect(confirm.locator("p")).toHaveText("Kas lõpetan ligipääsu koolitusele „Kulmumeistri e-koolitus“?");
    await expect(confirm.locator("li")).toHaveText("Õpilane ei saa seda enam avada.");
    await confirm.getByRole("button", { name: "Katkesta" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(veel(row)).toBeFocused();
    await chooseVeel(row, "Lõpeta ligipääs");
    await row.getByRole("button", { name: "Jah, lõpeta" }).click();
    await expect(row).toHaveAttribute("data-access-state", "revoked");
    await expect(row).toContainText(`Ligipääs lõpetatud ${formatDate(new Date(), "et")}`);
    // the focus goes to the line that now says so: the pill, or on a phone (where the card has no pill) the kicker
    await expect(row.locator(isMobile ? '[id$="-state-phone"]' : '[id$="-state"]')).toBeFocused();
    await expect(row.getByRole("button")).toHaveCount(0);
    await student.page.reload();
    await expect(ecourse.locator("[data-next-step]")).toHaveText("Ligipääs on lõppenud.");
    await expect(ecourse.getByRole("link")).toHaveCount(0);

    // granted again: the same row, open again
    await grant.getByRole("button", { name: "Ava ligipääs" }).click();
    await expect(row).toHaveAttribute("data-access-state", "active");
    await student.page.reload();
    await expect(ecourse.getByRole("link", { name: "Ava koolitus" })).toBeVisible();
    expect(await onLocalDb((sql) => sql`select 1 from course_access where client_id = ${id}`, { marksPages: false })).toHaveLength(1);
  } finally {
    await student.close();
  }

  // the same address again: her drawer, nothing new
  await page.goto("/admin/opilased");
  await adminReady(page);
  await page.getByRole("button", { name: "Lisa õpilane +", exact: true }).click();
  await page.getByRole("textbox", { name: "Lisa õpilane e-posti järgi" }).fill(email);
  await page.getByRole("button", { name: "Lisa õpilane", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/opilased\\?id=${id}$`));
  expect(await onLocalDb((sql) => sql`select 1 from clients where email = ${email}`, { marksPages: false })).toHaveLength(1);
  expect(await noOverflow(page)).toBe(true);
});

test("Lisa õpilane asks about an obvious typo first: Ei, lisa nii adds it as typed; Jah, paranda adds the corrected address", async ({ page, context, visitorIp }, info) => {
  // built at run time, as account-login.spec does: a typo domain is not an example address (nothing is mailed here)
  const typed = [`e2e-client-adm-typo-${info.project.name}`, "gmial.com"].join("@");
  const fixed = typed.replace("gmial.com", "gmail.com");
  const cleanup = () => onLocalDb((sql) => sql`delete from clients where email in (${typed}, ${fixed})`, { marksPages: false });
  await cleanup();
  try {
    await signInAsAdmin(page, context, visitorIp, created);
    await page.goto("/admin/opilased");
    await adminReady(page);
    const open = () => page.getByRole("button", { name: "Lisa õpilane +", exact: true }).click();
    await open();
    const form = page.locator("[data-add-student]");
    const field = form.getByRole("textbox", { name: "Lisa õpilane e-posti järgi" });
    await field.fill(typed);
    await form.getByRole("button", { name: "Lisa õpilane", exact: true }).click();
    const ask = form.locator("[data-add-typo]");
    await expect(ask).toHaveText(new RegExp(`^Kas mõtlesid ${fixed.replace(/\./g, "\\.")}\\?`));
    await expect(ask.getByRole("button", { name: "Jah, paranda" })).toBeFocused();
    await expect(form.getByRole("button", { name: "Lisa õpilane", exact: true })).toHaveCount(0);
    expect(await onLocalDb((sql) => sql`select 1 from clients where email in (${typed}, ${fixed})`, { marksPages: false })).toHaveLength(0); // nothing yet
    // typing again takes the question away
    await field.press("End");
    await field.press("Backspace");
    await expect(ask).toHaveCount(0);
    await field.fill(typed);
    await form.getByRole("button", { name: "Lisa õpilane", exact: true }).click();
    await ask.getByRole("button", { name: "Ei, lisa nii" }).click();
    await expect(page).toHaveURL(/\/admin\/opilased\?id=\d+$/);
    await expect(drawer(page).getByRole("link", { name: typed })).toBeVisible();

    await page.goto("/admin/opilased");
    await adminReady(page);
    await open();
    await field.fill(typed);
    await form.getByRole("button", { name: "Lisa õpilane", exact: true }).click();
    await ask.getByRole("button", { name: "Jah, paranda" }).click();
    await expect(page).toHaveURL(/\/admin\/opilased\?id=\d+$/);
    await expect(drawer(page).getByRole("link", { name: fixed })).toBeVisible();
    expect((await onLocalDb((sql) => sql<{ email: string }[]>`select email from clients where email in (${typed}, ${fixed}) order by email`, { marksPages: false })).map((r) => r.email)).toEqual([fixed, typed].sort());
  } finally {
    await cleanup();
  }
});

test("the list: search as she types, Kõik / E-õpe / Kontaktõpe with their counts, the number of courses and what it counts; the drawer lists her courses", async ({ page, context, visitorIp }, info) => {
  const eStudent = await fresh("list-e", info.project.name);
  const kStudent = await fresh("list-k", info.project.name);
  await insertAccountFixtures(eStudent, { name: `Eva E2E ${info.project.name}`, cards: ["ecourse"] });
  const k = await insertAccountFixtures(kStudent, { name: `Kai E2E ${info.project.name}`, cards: ["confirmed", "cancelled"] });
  // the e-learning cart's request ("E-õppe huvi")
  await onLocalDb(
    (sql) => sql`insert into requests (kind, payload, client_id)
      values ('contact', ${sql.json({ course: "kulmumeistri-e-koolitus", intent: "purchase", email: kStudent, locale: "et" })}, ${k.clientId})`,
    { marksPages: false },
  );
  // Kai signed up for the newsletter and has not confirmed yet (removed with the other rows of her address)
  await onLocalDb((sql) => sql`insert into subscribers (email, locale, token) values (${kStudent}, 'et', ${`e2e-adm-nl-${info.project.name}`})`, { marksPages: false });
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto("/admin/opilased");
  await adminReady(page);

  // the search is as she types (the toolbar's 300 ms), over name, e-mail and phone; there is no „Otsi“ button
  const search = page.getByRole("searchbox", { name: "Otsi nime, e-posti või telefoni järgi" });
  await expect(page.getByRole("button", { name: "Otsi", exact: true })).toHaveCount(0);
  await search.fill(`e2e-client-adm-list-`);
  await expect(page).toHaveURL(/\?otsi=e2e-client-adm-list-$/);
  const rows = page.locator("tr[data-client]");
  const mine = rows.filter({ hasText: info.project.name.toLowerCase() });
  await expect(mine).toHaveCount(2);
  await expect(mine.filter({ hasText: eStudent }).locator("[data-client-courses]")).toHaveText("1");
  await expect(mine.filter({ hasText: kStudent }).locator("[data-client-courses]")).toHaveText("1"); // the cancelled one does not count
  // what "Koolitusi" counts is the column header's title and its description (no line above the list)
  const hint = "Koolitusi: tema registreerimised (tühistatuid arvestamata) ja e-koolitused (lõpetatud ligipääse arvestamata, aegunuid arvestatakse).";
  const head = page.locator("[data-courses-head]");
  await expect(head).toHaveText("Koolitusi");
  await expect(head).toHaveAttribute("title", hint);
  await expect(head).toHaveAttribute("aria-describedby", "clients-courses-hint");
  await expect(page.locator("#clients-courses-hint")).toHaveText(hint);
  await expect(mine.filter({ hasText: kStudent }).getByRole("link")).toHaveText(`Kai E2E ${info.project.name}`); // the registration's name

  // the form pills carry their counts, and a count is what its pill then lists ("Õpilasi: n" above the table)
  const filters = page.getByRole("navigation", { name: "Õppevorm" });
  for (const name of ["Kõik", "E-õpe", "Kontaktõpe"]) {
    const pill = filters.getByRole("link", { name: new RegExp(`^${name}\\s*\\d+$`) });
    await pill.click();
    await expect(pill).toHaveAttribute("aria-current", "true");
    await expect(page).toHaveURL(/otsi=/); // the search stays
    const n = (await pill.textContent())!.replace(/\D/g, "");
    await expect(page.getByText(`Õpilasi: ${n}`, { exact: true })).toBeVisible();
    if (name !== "Kõik") await expect(page).toHaveURL(new RegExp(`vorm=${name === "E-õpe" ? "e" : "k"}`));
    if (name === "E-õpe") {
      await expect(mine).toHaveCount(1);
      await expect(mine).toContainText(eStudent);
    }
    if (name === "Kontaktõpe") {
      await expect(mine).toHaveCount(1);
      await expect(mine).toContainText(kStudent);
    }
  }
  await filters.getByRole("link", { name: /^Kõik\s*\d+$/ }).click();
  await expect(mine).toHaveCount(2);

  // by name, any case; nothing found says so, and the way out clears the search and the filters
  await search.fill(`kai e2e ${info.project.name.toUpperCase()}`);
  await expect(page).toHaveURL(/otsi=kai/);
  await expect(rows).toHaveCount(1);
  await search.fill("ei-ole-sellist-õpilast-%");
  await expect(page).toHaveURL(/otsi=ei-ole/);
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("„ei-ole-sellist-õpilast-%“ järgi õpilasi ei leitud.")).toBeVisible();
  await page.getByRole("link", { name: "Tühjenda otsing ja filtrid" }).click();
  await expect(page).toHaveURL(/\/admin\/opilased$/);
  await expect(search).toHaveValue("");

  // the drawer: her registrations (named as her cards name them), each opening its own drawer
  const d = await openStudent(page, kStudent);
  await expect(d.getByRole("heading", { level: 2 })).toHaveText(`Kai E2E ${info.project.name}`);
  await expect(d.locator("[data-client-newsletter]")).toHaveText("Uudiskiri: ootab kinnitust"); // phase 2c
  // the folded rows, in README's order, each with what is in it (a request: "1")
  await expect(d.locator("details[data-fold] summary > span > span:first-child")).toHaveText(["Ava ligipääs e-koolitusele", "Maksed", "Lepingud", "Päringud", "Tagasiside"]);
  await expect(fold(d, "Päringud").locator("[data-fold-summary]")).toHaveText("1");
  await expect(fold(d, "Lepingud").locator("[data-fold-summary]")).toHaveText("0");
  const reqs = (await openFold(d, "Päringud")).locator("[data-client-request]");
  await expect(reqs).toHaveCount(1);
  await expect(reqs.locator("strong")).toHaveText("E-õppe huvi");
  await expect(reqs).toContainText("Kulmumeistri e-koolitus");
  // "Koolitused": her registrations as cards, newest first, the kicker with the day and the place
  const regs = d.locator("[data-client-registration]");
  await expect(regs).toHaveCount(2);
  const start = k.session.startsAt;
  await expect(regs.first()).toContainText(`Kulmude lamineerimine`);
  await expect(regs.first().locator("[data-registration-kicker] [data-wide]")).toHaveText(`Kontaktõpe · ${formatDate(start, "et")} Pärnu`);
  expect(await smallTargets(page.locator("main"))).toEqual([]);
  expect(await smallTargets(d)).toEqual([]);
  await d.locator(`[data-client-registration="${k.registrations.confirmed}"] [data-registration-open]`).click();
  await expect(page).toHaveURL(new RegExp(`/admin/registreerimised\\?id=${k.registrations.confirmed}$`));
  await expect(page.locator(`[data-registration-detail="${k.registrations.confirmed}"]`)).toBeVisible();
  expect(await noOverflow(page)).toBe(true);

  // „Vaata päringutes“ (the fold „Päringud“) takes her request's own card in Päringud: its tab, and the card itself (#p-{id}), which is marked for a moment
  const again = await openStudent(page, kStudent);
  const link = (await openFold(again, "Päringud")).getByRole("link", { name: "Vaata päringutes" });
  await expect(link).toHaveAttribute("href", /^\/admin\/paringud\?liik=kontakt#p-\d+$/);
  await link.click();
  await expect(page).toHaveURL(/\/admin\/paringud\?liik=kontakt#p-\d+$/);
  const card = page.locator(`#${new URL(page.url()).hash.slice(1)}`);
  await expect(card).toBeVisible();
  await expect(card.locator("[data-request-tag]")).toHaveText("E-õppe huvi");
  await expect(card.locator("[data-request-message]")).toHaveText("Huvi: Kulmumeistri e-koolitus");
  await expect(card).toHaveAttribute("data-flash", "");
});

test("the whole row is the link: at 1360 px Õpilased stays a table and a click anywhere on a row opens its drawer; in a narrow card the rows are blocks and it works there too", async ({ page, context, visitorIp }, info) => {
  const email = await fresh("row", info.project.name);
  const name = `Rita E2E ${info.project.name}`;
  await insertAccountFixtures(email, { name, cards: ["ecourse"] });
  await signInAsAdmin(page, context, visitorIp, created);
  const own = page.viewportSize()!;

  // a click at the middle of a cell, away from the name (the name's own link would be too easy): the cell's text is not the link, the row is
  // (ListRows.tsx listens once the page is hydrated: the click is repeated until the drawer's address answers it)
  const clickCell = async (cell: Locator) => {
    await expect(async () => {
      const box = (await cell.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page).toHaveURL(/[?&]id=\d+/, { timeout: 1500 });
    }).toPass({ timeout: 15_000 });
  };
  const open = async () => {
    await expect(page).toHaveURL(/[?&]id=\d+/);
    await expect(drawer(page).getByRole("heading", { level: 2 })).toHaveText(name);
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]id=/);
  };

  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(`/admin/opilased?otsi=${encodeURIComponent(email)}`);
  await adminReady(page);
  const table = page.locator("table").first();
  const row = page.locator("tr[data-client]");
  await expect(row).toHaveCount(1);
  await expect(table).toHaveCSS("display", "table"); // 1360 px is still a table (the cards begin below a 760 px card)
  await expect(row).toHaveCSS("display", "table-row");
  const link = row.getByRole("link", { name: `Ava ${name}` });
  const [cell, linkBox] = [row.locator("[data-client-courses]"), (await link.boundingBox())!];
  expect((await cell.boundingBox())!.x, "the courses cell sits beside the name, not under it").toBeGreaterThan(linkBox.x + linkBox.width);
  // the row looks like a link: a pointer, and (for a mouse) the row highlight under it
  await expect(row).toHaveCSS("cursor", "pointer");
  if (await page.evaluate(() => matchMedia("(hover: hover)").matches)) {
    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + 24, box.y + box.height / 2);
    await expect(row).toHaveCSS("background-color", "rgb(250, 246, 248)");
  }
  await clickCell(row.locator("[data-client-courses]"));
  await open();
  await clickCell(row.locator("td").nth(1)); // the date
  await open();
  await link.click(); // the name itself still works
  await open();
  expect(await noOverflow(page)).toBe(true);

  // a card narrower than 760 px: each row a block of label + value lines
  await page.setViewportSize({ width: 700, height: 900 });
  await page.reload();
  await adminReady(page);
  await expect(table).toHaveCSS("display", "block");
  await expect(row).toHaveCSS("display", "block");
  await clickCell(row.locator("[data-client-courses]"));
  await open();
  expect(await noOverflow(page)).toBe(true);

  await page.setViewportSize(own);
});

test("Vaata tema vaadet: her cards, every action disabled and doing nothing; her own session untouched and still working", async ({ page, context, browser, visitorIp }, info) => {
  info.setTimeout(info.timeout + LOCK_WAIT_MS); // the wait for the shared prepayment setting is not taken from the test's own time
  const release = await holdLocalLock("e2e-prepayment-setting");
  const restore = await snapshotRows("settings", { column: "key", value: "prepayment" });
  const email = await fresh("view", info.project.name);
  const cards: AccountCardKind[] = ["awaiting", "confirmed", "practice", "ecourse"];
  try {
    await setPrepayment(TEST_PREPAYMENT); // so the unpaid card has its "Vaata juhiseid" to press
    const f = await insertAccountFixtures(email, { name: "Kati Tamm", cards });
    const student = await studentBrowser(browser, email, visitorIp);
    try {
      // what she sees
      const keys = await student.page.locator("[data-card]").evaluateAll((els) => els.map((e) => e.getAttribute("data-card")));
      const sentences = await student.page.locator("[data-next-step]").allTextContents();
      expect(keys).toHaveLength(cards.length);
      const before = await sessions(f.clientId);
      expect(before).toHaveLength(1);
      expect(before[0].endedAt).toBeNull();

      // the admin's view of it
      await signInAsAdmin(page, context, visitorIp, created);
      const d = await openStudent(page, email);
      const asked: string[] = [];
      page.on("request", (r) => {
        if (new URL(r.url()).pathname.startsWith("/api/konto")) asked.push(r.url());
      });
      await d.getByRole("link", { name: "Vaata tema vaadet", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/admin/opilased/${f.clientId}/vaade$`));
      await adminReady(page);
      const view = page.locator("[data-view-as]");
      await expect(view.locator("[data-account-banner]")).toHaveText("Vaatad kliendi Kati Tamm vaadet — muuta ei saa");
      await expect(view.getByRole("heading", { level: 1 })).toHaveText("Tere, Kati!");
      expect(await view.locator("[data-card]").evaluateAll((els) => els.map((e) => e.getAttribute("data-card")))).toEqual(keys);
      expect(await view.locator("[data-next-step]").allTextContents()).toEqual(sentences);

      // every button and link of her page (the tabs, the menu, Vaata juhiseid, Tühista või muuda aega, Ava koolitus) is
      // aria-disabled, and pressing them does nothing; only the filter chips (they only change what is shown) work
      const actions = view.locator("[data-account-shell] a, [data-account-shell] button:not([data-filter])");
      const n = await actions.count();
      expect(n).toBeGreaterThanOrEqual(6);
      for (let i = 0; i < n; i++) await expect(actions.nth(i)).toHaveAttribute("aria-disabled", "true");
      await view.getByRole("button", { name: "Vaata juhiseid" }).click({ force: true });
      await view.getByRole("button", { name: "Tühista või muuda aega" }).click({ force: true });
      await view.locator("[data-card='course-kulmumeistri-e-koolitus']").getByRole("link", { name: "Ava koolitus" }).click({ force: true });
      await view.getByRole("button", { name: "Konto menüü" }).first().click({ force: true });
      await expect(page).toHaveURL(new RegExp(`/admin/opilased/${f.clientId}/vaade$`));
      await expect(view.locator("[data-prepayment]")).toHaveCount(0);
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await expect(page.locator("[data-account-logout]")).toHaveCount(0);
      expect(asked, "the view asks the account API nothing").toEqual([]);
      expect(await noOverflow(page)).toBe(true);
      // an admin page: never stored by a shared cache (next.config.ts sends no-store for /admin; `next dev` answers no-cache)
      const answer = await page.request.get(`/admin/opilased/${f.clientId}/vaade`);
      expect(answer.status()).toBe(200);
      expect(answer.headers()["cache-control"]).toMatch(/no-store|no-cache/);
      expect(answer.headers()["cache-control"]).not.toMatch(/public|s-maxage/);
      expect(answer.headers()["set-cookie"] ?? "").not.toMatch(/mslab_client|mslab_in/);

      // her session as it was, and it still works
      expect(await sessions(f.clientId)).toEqual(before);
      await student.page.reload();
      await expect(student.page.locator("[data-account-dashboard]")).toBeVisible();
      await expect(student.page.getByRole("heading", { level: 1 })).toHaveText("Tere, Kati!");
      expect((await sessions(f.clientId)).map((s) => s.endedAt)).toEqual([null]);
      expect(await onLocalDb((sql) => sql`select 1 from requests where kind = 'change_request' and client_id = ${f.clientId}`, { marksPages: false })).toHaveLength(0);
    } finally {
      await student.close();
    }

    // "Tagasi" goes back to her drawer
    await page.getByRole("link", { name: "Tagasi õpilase juurde" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/opilased\\?id=${f.clientId}$`));
    await expect(drawer(page)).toBeVisible();

    // a student who does not exist: the not-found card with the way back
    await page.goto("/admin/opilased/2147483646/vaade");
    await noindex(page);
    await expect(page.getByText("Seda õpilast ei leitud.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Õpilaste juurde" })).toHaveAttribute("href", "/admin/opilased");
  } finally {
    await restore();
    await release();
  }
});

test("her lessons in the drawer: Õppetunnid 1/3, Ava järgmine õppetund under Veel ▾ (the student then has it), Vaata tema vaadet (read-only, her session untouched), nothing of it after the access ends", async ({ page, context, browser, visitorIp }, info) => {
  // the lesson API checks the course terms, shared by every client: the test takes them (and the wait is not taken from its own time)
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  const restoreTerms = await takeTerms();
  try {
    const email = await fresh("prog", info.project.name);
    const course = await insertLessonCourse(email);
    keys.add(course.fileKey);
    await markDone(course.clientId, course.lessons.video); // lesson 1 done, 2 open, 3 locked
    const student = await studentBrowser(browser, email, visitorIp);
    try {
      const studentLesson = (id: number) => student.page.locator(`[data-lesson="${id}"]`);
      await student.page.goto(`/konto/kursus/${course.slug}`);
      await expect(studentLesson(course.lessons.last)).toHaveAttribute("data-state", "locked");

      // the admin's drawer: the steps (the lessons done of all), and under „Veel ▾“ her page of the course and the first locked lesson to open
      await signInAsAdmin(page, context, visitorIp, created);
      const d = await openStudent(page, email);
      const row = d.locator("[data-access]");
      await expect(row).toHaveCount(1);
      const lessons = row.locator("[data-access-steps] [data-wide]");
      await expect(lessons).toContainText("Õppetunnid 1/3");
      await expect(row.locator("[data-access-steps] [data-swap]")).toHaveAttribute("data-short", "1/3"); // (the phone's line: no word for the lessons)
      await veel(row).click();
      const menu = row.getByRole("menu");
      await expect(menu.getByRole("menuitem")).toHaveText(["Ava järgmine õppetund", "Lisa protokoll", "Vaata tema vaadet", "Lõpeta ligipääs"]);
      const viewLink = menu.getByRole("menuitem", { name: "Vaata tema vaadet" });
      await expect(viewLink).toHaveAttribute("href", `/admin/opilased/${course.clientId}/vaade/${course.slug}`);
      await veel(row).click(); // closed again
      expect(await smallTargets(row)).toEqual([]);

      // a ConfirmPanel asks ("Katkesta" goes back to „Veel ▾“), then exactly that lesson is open: the line says so, and she has it
      await chooseVeel(row, "Ava järgmine õppetund");
      const confirm = row.locator("[data-confirm-panel]");
      await expect(confirm).toBeFocused();
      await expect(confirm.locator("p")).toHaveText("Kas avan õpilasele õppetunni „Kolmas tund“?");
      await expect(confirm.locator("li")).toHaveText("Ta saab selle kohe vaadata.");
      expect(await smallTargets(row)).toEqual([]);
      await confirm.getByRole("button", { name: "Katkesta" }).click();
      await expect(confirm).toHaveCount(0);
      await expect(veel(row)).toBeFocused();
      await chooseVeel(row, "Ava järgmine õppetund");
      await confirm.getByRole("button", { name: "Jah, ava" }).click();
      const done = row.locator("[data-unlock-done]");
      await expect(done).toHaveText("Õppetund „Kolmas tund“ on avatud.");
      await expect(done).toHaveAttribute("role", "status");
      await expect(done).toBeFocused();
      await expect(confirm).toHaveCount(0);
      await veel(row).click();
      await expect(row.getByRole("menuitem", { name: "Ava järgmine õppetund" })).toHaveCount(0); // nothing is locked now
      await veel(row).click();
      await expect(lessons).toContainText("Õppetunnid 1/3"); // opened, not done
      const lastRow = (id: number) =>
        onLocalDb(
          (sql) => sql<{ unlockedBy: string | null; doneAt: Date | null; watchedSec: number }[]>`select unlocked_by as "unlockedBy", done_at as "doneAt", watched_sec as "watchedSec" from lesson_progress where client_id = ${course.clientId} and lesson_id = ${id}`,
          { marksPages: false },
        );
      expect(await lastRow(course.lessons.last)).toEqual([{ unlockedBy: ADMIN, doneAt: null, watchedSec: 0 }]);
      await student.page.reload();
      await expect(studentLesson(course.lessons.last)).toHaveAttribute("data-state", "current");
      await expect(studentLesson(course.lessons.text)).toHaveAttribute("data-state", "current");

      // her page of the course as she sees it: every action aria-disabled and doing nothing, nothing asked of her account, her session as it was
      const before = await sessions(course.clientId);
      expect(before).toHaveLength(1);
      expect(before[0].endedAt).toBeNull();
      const asked: string[] = [];
      page.on("request", (r) => {
        if (new URL(r.url()).pathname.startsWith("/api/konto")) asked.push(r.url());
      });
      await veel(row).click();
      await row.getByRole("menuitem", { name: "Vaata tema vaadet" }).click();
      const viewPath = `/admin/opilased/${course.clientId}/vaade/${course.slug}`;
      await expect(page).toHaveURL(new RegExp(`${viewPath}$`));
      await adminReady(page);
      const view = page.locator("[data-view-as]");
      await expect(view.locator("[data-account-banner]")).toHaveText(`Vaatad kliendi ${email} vaadet — muuta ei saa`);
      await expect(view.getByRole("heading", { level: 1 })).toHaveText("E2E õppetunnid");
      await expect(view.locator("[data-ecourse-progress]")).toHaveText("1 / 3 õppetundi tehtud");
      expect(await view.locator("[data-lesson]").evaluateAll((els) => els.map((e) => e.getAttribute("data-state")))).toEqual(["done", "current", "current"]);
      await expect(view.locator("[data-terms-gate]")).toHaveCount(0); // the admin looks; nothing is accepted
      await expect(view.locator("[data-ecourse] a")).toHaveCount(0);
      await expect(view.locator("[data-ecourse-next]")).toHaveText("Jätka");
      const actions = view.locator("[data-account-shell] a, [data-account-shell] button, [data-ecourse-next], [data-lesson] [aria-disabled]");
      const n = await actions.count();
      expect(n).toBeGreaterThanOrEqual(5);
      for (let i = 0; i < n; i++) await expect(actions.nth(i)).toHaveAttribute("aria-disabled", "true");
      await view.locator("[data-ecourse-next]").click({ force: true });
      await view.locator(`[data-lesson="${course.lessons.text}"] [aria-disabled]`).click({ force: true });
      await expect(page).toHaveURL(new RegExp(`${viewPath}$`));
      expect(asked, "the view asks the account API nothing").toEqual([]);
      expect(await noOverflow(page)).toBe(true);
      // an admin page: never stored by a shared cache (next.config.ts sends no-store for /admin; `next dev` answers no-cache), and no cookie of hers is set
      const answer = await page.request.get(viewPath);
      expect(answer.status()).toBe(200);
      expect(answer.headers()["cache-control"]).toMatch(/no-store|no-cache/);
      expect(answer.headers()["cache-control"]).not.toMatch(/public|s-maxage/);
      expect(answer.headers()["set-cookie"] ?? "").not.toMatch(/mslab_client|mslab_in/);
      expect(await sessions(course.clientId)).toEqual(before);
      expect((await student.page.request.get("/api/konto/me")).status()).toBe(200);
      await student.page.reload();
      await expect(student.page.locator("[data-ecourse]")).toBeVisible(); // she is still signed in, on her own page of the course
      expect((await sessions(course.clientId)).map((s) => s.endedAt)).toEqual([null]);
      expect(await lastRow(course.lessons.last)).toHaveLength(1); // looking changed no progress
      // a bad address, a course she does not have or a student who is not there: the not-found card (her own page answers 404)
      for (const bad of [`/admin/opilased/${course.clientId}/vaade/${course.slug}-x`, `/admin/opilased/${course.clientId}/vaade/BAD_slug`, `/admin/opilased/2147483646/vaade/${course.slug}`, `/admin/opilased/0${course.clientId}/vaade/${course.slug}`]) {
        await page.goto(bad);
        await noindex(page);
        // the wording does not blame the student: she is there, this view is not (the way back goes to the list)
        await expect(page.getByText("Seda vaadet ei leitud.")).toBeVisible();
        await expect(page.getByText("Seda õpilast ei leitud.")).toHaveCount(0);
        await expect(page.getByRole("link", { name: "Õpilaste juurde" })).toHaveAttribute("href", "/admin/opilased");
      }

      // "Tagasi" goes back to her drawer; lesson 3 locked again by hand gives the button back, and ending the access takes it and the link away
      await page.goto(viewPath);
      await page.getByRole("link", { name: "Tagasi õpilase juurde" }).click();
      await expect(page).toHaveURL(new RegExp(`/admin/opilased\\?id=${course.clientId}$`));
      await expect(drawer(page)).toBeVisible();
      await onLocalDb((sql) => sql`delete from lesson_progress where client_id = ${course.clientId} and lesson_id = ${course.lessons.last}`, { marksPages: false });
      await page.reload();
      await adminReady(page);
      await veel(row).click();
      await expect(row.getByRole("menuitem", { name: "Ava järgmine õppetund" })).toBeVisible();
      await expect(row.getByRole("menuitem", { name: "Vaata tema vaadet" })).toBeVisible();
      await veel(row).click();
      await chooseVeel(row, "Lõpeta ligipääs");
      await row.getByRole("button", { name: "Jah, lõpeta" }).click();
      await expect(row).toHaveAttribute("data-access-state", "revoked");
      await expect(row.locator("[data-access-steps] [data-wide]")).toContainText("Õppetunnid 1/3"); // (her history stays)
      await expect(veel(row)).toHaveCount(0); // nothing opens from an ended access
      await expect(row.getByRole("button")).toHaveCount(0);
      await page.goto(viewPath); // no active access: the not-found card, as for her
      await noindex(page);
      await expect(page.getByText("Seda vaadet ei leitud.")).toBeVisible();
      expect(await noOverflow(page)).toBe(true);
    } finally {
      await student.close();
    }
  } finally {
    await restoreTerms();
  }
});

test("„Pikenda ▾“ (B12): +1 kuu applies at once and the bar takes it back; „Kuupäev…“ refuses a day that is not later; who opened it stays; the menu stays inside a 375 px screen", async ({ page, context, visitorIp, isMobile }, info) => {
  const email = await fresh("extend", info.project.name);
  const name = `Eha E2E ${info.project.name}`;
  const f = await insertAccountFixtures(email, { name, cards: ["ecourse"] });
  // a known end: the end of the day three months from today in Tallinn, as the grant form stores it
  const start = endOfDayTallinn(addMonths(tallinnToday(new Date()), 3)!)!;
  await onLocalDb((sql) => sql`update course_access set expires_at = ${start} where client_id = ${f.clientId}`, { marksPages: false });
  const stored = async () =>
    (await onLocalDb((sql) => sql<{ expiresAt: Date; grantedBy: string; revokedAt: Date | null }[]>`select expires_at as "expiresAt", granted_by as "grantedBy", revoked_at as "revokedAt" from course_access where client_id = ${f.clientId}`, { marksPages: false }))[0];
  await signInAsAdmin(page, context, visitorIp, created);
  if (isMobile) await page.setViewportSize({ width: 375, height: 812 });
  const d = await openStudent(page, email);
  const row = d.locator("[data-access]");
  await expect(row).toContainText(`Avatud kuni ${formatDate(start, "et")}`);
  const pill = row.getByRole("button", { name: "Pikenda: Kulmumeistri e-koolitus" });
  await expect(pill).toHaveText(/^Pikenda/);
  expect((await pill.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // the menu names the end it counts from, and lists the four ways
  await pill.click();
  const menu = row.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText(`Pikenda ligipääsu (praegu kuni ${formatDate(start, "et")})`);
  await expect(menu.getByRole("menuitem")).toHaveText(["+1 kuu", "+3 kuud", "+6 kuud", "Kuupäev…"]);
  if (isMobile) {
    const place = (await menu.boundingBox())!;
    expect([place.x >= 0, place.x + place.width <= 375, place.y >= 0, place.y + place.height <= 812], "the menu is inside the screen").toEqual([true, true, true, true]);
    expect(await noOverflow(page)).toBe(true);
  }

  // +1 kuu: done at once; the bar says until when; the card and the database have the new end; who opened it is as it was
  await menu.getByRole("menuitem", { name: "+1 kuu" }).click();
  const plusOne = extendByMonths(start, new Date(), 1);
  const bar = page.locator("[data-undo-bar]");
  await expect(bar).toContainText(`Ligipääs pikendatud kuni ${formatDate(plusOne, "et")}.`);
  await expect(row).toContainText(`Avatud kuni ${formatDate(plusOne, "et")}`);
  await expect(row).toContainText("Avas e2e,"); // (the fixture's own opener: granted_by is not touched)
  expect(await stored()).toEqual({ expiresAt: plusOne, grantedBy: "e2e", revokedAt: null });

  // „Võta tagasi“: the end it replaced is back
  await bar.getByRole("button", { name: "Võta tagasi" }).click();
  await expect(bar).toHaveCount(0);
  await expect(row).toContainText(`Avatud kuni ${formatDate(start, "et")}`);
  expect((await stored()).expiresAt).toEqual(start);

  // „Kuupäev…“: the picker starts at the first day the server takes (the day after the current end); a day before the end is refused where it was typed;
  // that first day goes through and is taken back too
  await pill.click();
  await menu.getByRole("menuitem", { name: "Kuupäev…" }).click();
  const form = row.locator("[data-extend-form]");
  await expect(form.getByLabel("Ligipääs kuni")).toBeFocused();
  const firstDay = tallinnToday(new Date(start.getTime() + 1)); // (the end is the end of a day: the next one)
  expect(firstDay > tallinnToday(start)).toBe(true);
  await expect(form.getByLabel("Ligipääs kuni")).toHaveAttribute("min", firstDay);
  await form.getByLabel("Ligipääs kuni").fill(addMonths(tallinnToday(new Date()), 1)!);
  await form.getByRole("button", { name: "Pikenda", exact: true }).click();
  await expect(form.locator("[role='status']")).toHaveText("Vali kuupäev, mis on hilisem kui praegune lõpp.");
  await expect(form.getByLabel("Ligipääs kuni")).toHaveAttribute("aria-invalid", "true");
  expect((await stored()).expiresAt).toEqual(start);
  await form.getByLabel("Ligipääs kuni").fill(firstDay);
  await form.getByRole("button", { name: "Pikenda", exact: true }).click();
  await expect(bar).toContainText(`Ligipääs pikendatud kuni ${formatDate(endOfDayTallinn(firstDay)!, "et")}.`);
  await expect(form).toHaveCount(0);
  await expect(pill).toBeFocused();
  await expect(row).toContainText(`Avatud kuni ${formatDate(endOfDayTallinn(firstDay)!, "et")}`); // (the page's refresh has come)
  expect((await stored()).expiresAt).toEqual(endOfDayTallinn(firstDay));
  await bar.getByRole("button", { name: "Võta tagasi" }).click();
  await expect(row).toContainText(`Avatud kuni ${formatDate(start, "et")}`);
  expect((await stored()).expiresAt).toEqual(start);

  // „Katkesta“ closes the field, and the focus is on the pill again
  await pill.click();
  await menu.getByRole("menuitem", { name: "Kuupäev…" }).click();
  await form.getByRole("button", { name: "Katkesta" }).click();
  await expect(form).toHaveCount(0);
  await expect(pill).toBeFocused();
  expect(await smallTargets(d)).toEqual([]);

  // an access an admin ended has no „Pikenda“
  await chooseVeel(row, "Lõpeta ligipääs");
  await row.getByRole("button", { name: "Jah, lõpeta" }).click();
  await expect(row).toHaveAttribute("data-access-state", "revoked");
  await expect(pill).toHaveCount(0);
  expect(await noOverflow(page)).toBe(true);
});

test("the phone drawer (375 × 812): a card has no pill — its state is in the kicker —, a registration's buttons are „Registreering“ and „Lisa protokoll“, both menus and the folded rows stay inside the screen, nothing scrolls sideways", async ({ page, context, visitorIp, isMobile }, info) => {
  test.skip(!isMobile, "the phone project only");
  const email = await fresh("phone", info.project.name);
  const f = await insertAccountFixtures(email, { name: `Pille E2E ${info.project.name}`, cards: ["ecourse", "confirmed"] });
  await signInAsAdmin(page, context, visitorIp, created);
  await page.setViewportSize({ width: 375, height: 812 });
  const d = await openStudent(page, email);
  await drawer(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // (it slides in: measured in place)
  const inside = async (what: string, locator: Locator) => {
    const box = (await locator.boundingBox())!;
    expect([box.x >= 0, box.x + box.width <= 375, box.y >= 0, box.y + box.height <= 812], what).toEqual([true, true, true, true]);
  };

  // the phone's words are the stylesheet's generated content (one text in the page): read from there, and as the accessible name
  const shown = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el, "::after").content);

  // the e-course card: no pill, the state in the kicker (the wide kicker is only "E-õpe")
  const row = d.locator("[data-access]");
  const until = formatDate(f.ecourse.expiresAt!, "et");
  await expect(row.locator("[data-access-pill]")).toBeHidden();
  await expect(row.locator("[data-access-kicker] [data-wide]")).toBeHidden();
  expect(await shown(row.locator("[data-access-kicker] [data-swap]"))).toBe(`"E-õpe · Avatud kuni ${until}"`);
  // the registration's card: the state in the kicker too, and the two buttons share the width
  const reg = d.locator(`[data-client-registration="${f.registrations.confirmed}"]`);
  await expect(reg.locator("[data-reg-status]")).toBeHidden();
  expect(await shown(reg.locator("[data-registration-kicker] [data-swap]"))).toBe(`"Kontaktõpe · ${formatDate(f.session.startsAt, "et").slice(0, 5)} Pärnu · Kinnitatud"`);
  await expect(reg.getByRole("link", { name: "Registreering", exact: true })).toBeVisible();
  await expect(reg.locator("[data-registration-protocol]")).toHaveText("Lisa protokoll");
  const [open, protocol] = [(await reg.locator("[data-registration-open]").boundingBox())!, (await reg.locator("[data-registration-protocol]").boundingBox())!];
  expect([open.height >= 44, protocol.height >= 44, open.x + open.width <= protocol.x + 1, protocol.x + protocol.width <= 375]).toEqual([true, true, true, true]);
  expect(await smallTargets(d)).toEqual([]);

  // the menus open inside the screen
  await row.getByRole("button", { name: /^Pikenda:/ }).click();
  await inside("Pikenda ▾", row.getByRole("menu"));
  await row.getByRole("button", { name: /^Pikenda:/ }).click();
  await veel(row).click();
  await inside("Veel ▾", row.getByRole("menu"));
  await veel(row).click();
  // „Kuupäev…“ and a ConfirmPanel fit the card too
  await row.getByRole("button", { name: /^Pikenda:/ }).click();
  await row.getByRole("menuitem", { name: "Kuupäev…" }).click();
  await inside("the day field of Pikenda", row.locator("[data-extend-form]"));
  await row.locator("[data-extend-form]").getByRole("button", { name: "Katkesta" }).click();
  await chooseVeel(row, "Lõpeta ligipääs");
  await inside("the question of Lõpeta ligipääs", row.locator("[data-confirm-panel]"));
  await row.getByRole("button", { name: "Katkesta" }).click();

  // the folded rows are 52 px rows of the drawer's width
  for (const title of ["Ava ligipääs e-koolitusele", "Maksed", "Lepingud", "Päringud", "Tagasiside"]) {
    const summary = d.locator("details[data-fold] > summary", { hasText: title });
    await expect(summary).toBeVisible();
    const box = (await summary.boundingBox())!;
    expect(box.height, title).toBeGreaterThanOrEqual(52);
    expect(box.x + box.width, title).toBeLessThanOrEqual(375);
  }
  await openFold(d, "Ava ligipääs e-koolitusele");
  await d.locator("[data-grant-form]").scrollIntoViewIfNeeded();
  await inside("the grant form", d.locator("[data-grant-form]"));
  expect(await noOverflow(page)).toBe(true);
});

test("the phone drawer (375 × 812) with „Hinda“ on the card: „Hinda“ and „Pikenda ▾“ are two equal columns, „Veel ▾“ the next row, both menus open inside the screen and nothing scrolls sideways", async ({ page, context, visitorIp, isMobile }, info) => {
  test.skip(!isMobile, "the phone project only");
  const email = await fresh("hinda", info.project.name);
  const course = await insertLessonCourse(email);
  keys.add(course.fileKey);
  // her practical work is sent and waits for Maria: the card has „Hinda“ before „Pikenda ▾“
  const stages = [{ title: "Ettevalmistus", note: "" }, { title: "Värvimine", note: "" }];
  await onLocalDb((sql) => sql`update courses set protocol_stages = ${sql.json(stages.map((s) => s.title))} where slug = ${course.slug}`, { marksPages: false });
  const [access] = await onLocalDb(
    (sql) => sql<{ id: number }[]>`
      insert into protocols (access_id, stages, verdicts, round, submitted_at)
      select id, ${sql.json(stages)}, ${sql.json([null, null])}, 1, now() - interval '2 hours' from course_access where client_id = ${course.clientId}
      returning access_id as id`,
    { marksPages: false },
  );
  await signInAsAdmin(page, context, visitorIp, created);
  await page.setViewportSize({ width: 375, height: 812 });
  const d = await openStudent(page, email);
  await drawer(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // (it slides in: measured in place)
  const row = d.locator("[data-access]");
  const hinda = row.locator("[data-access-assess]");
  await expect(hinda).toBeVisible();
  await expect(hinda).toHaveAttribute("href", `/admin/protokollid?ligipaas=${access.id}`);
  const pill = row.getByRole("button", { name: /^Pikenda:/ });
  const menuInside = async (what: string) => {
    const box = (await row.getByRole("menu").boundingBox())!;
    expect([box.x >= 0, box.x + box.width <= 375, box.y >= 0, box.y + box.height <= 812], `${what}: the menu is inside the screen`).toEqual([true, true, true, true]);
    expect(await noOverflow(page), `${what}: the page does not scroll sideways`).toBe(true);
    // (nor does the drawer, the dialog that scrolls)
    expect(await drawer(page).evaluate((el) => el.scrollWidth <= el.clientWidth), `${what}: the drawer does not scroll sideways`).toBe(true);
  };

  // the phone frame's two columns: „Hinda“ and „Pikenda ▾“ on one line, as wide as each other; „Veel ▾“ under them
  const [h, p, v] = [(await hinda.boundingBox())!, (await pill.boundingBox())!, (await veel(row).boundingBox())!];
  expect(Math.abs(h.y - p.y), "Hinda and Pikenda on one line").toBeLessThan(2);
  expect(p.x, "Pikenda is the second column").toBeGreaterThan(h.x + h.width);
  expect(Math.abs(h.width - p.width), "two equal columns").toBeLessThan(2);
  expect(v.y, "Veel is the next row").toBeGreaterThan(h.y + h.height - 1);
  expect(p.x + p.width, "the pill's right edge is inside the card").toBeLessThanOrEqual(375);

  // „Pikenda ▾“ — the menu that overflowed when the pill sat after „Hinda“ in a flex row (its right edge was at 381)
  await pill.click();
  await expect(row.getByRole("menu")).toContainText("Pikenda ligipääsu (praegu kuni");
  await menuInside("Pikenda ▾");
  await pill.click();
  await veel(row).click();
  await menuInside("Veel ▾");
  await veel(row).click();
  // the day field takes the full width under the buttons
  await pill.click();
  await row.getByRole("menuitem", { name: "Kuupäev…" }).click();
  const form = row.locator("[data-extend-form]");
  const f = (await form.boundingBox())!;
  const c = (await row.boundingBox())!;
  expect([f.x >= c.x, f.x + f.width <= c.x + c.width, f.y > v.y], "the day field is under the buttons, inside the card").toEqual([true, true, true]);
  expect(await noOverflow(page)).toBe(true);
  expect(await smallTargets(row)).toEqual([]);
});

test("a change request in Päringud: the registration's name as the heading, the wish and the course with its day in the facts line, a link that opens the registration", async ({ page, context, visitorIp }, info) => {
  const email = await fresh("change", info.project.name);
  const f = await insertAccountFixtures(email, { name: "Mari Maasikas", cards: ["confirmed", "awaiting"] });
  const [cancel] = await onLocalDb(
    (sql) => sql<{ id: number }[]>`insert into requests (kind, payload, client_id)
      values ('change_request', ${sql.json({ registrationId: f.registrations.confirmed!, kind: "cancel", message: "Jään haigeks.", email })}, ${f.clientId}) returning id`,
    { marksPages: false },
  );
  const [change] = await onLocalDb(
    (sql) => sql<{ id: number }[]>`insert into requests (kind, payload, client_id)
      values ('change_request', ${sql.json({ registrationId: f.registrations.awaiting!, kind: "change", message: "", email })}, ${f.clientId}) returning id`,
    { marksPages: false },
  );
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto("/admin/paringud?liik=muutmine");
  await adminReady(page);

  const start = f.session.startsAt;
  const facts = (wish: string) => `${wish} · Kulmude lamineerimine, ${formatDate(start, "et")} Pärnu`;
  const first = page.locator(`[data-request="${cancel.id}"]`);
  // her name on the registration is the heading (a request has no name of its own); under it the date, her language (the registration's) and her address
  await expect(first.getByRole("heading", { level: 3 })).toHaveText("Mari Maasikas");
  await expect(first.locator("[data-request-meta]")).toHaveText(new RegExp(`^\\d{2}\\.\\d{2}\\.\\d{4} \\d{2}:\\d{2} · ET · ${email}$`));
  await expect(first.locator("[data-request-tag]")).toHaveText("Muutmine");
  // the wish in words and the course with its day, no raw payload keys (registrationId, kind)
  await expect(first.locator("[data-request-message]")).toHaveText("Jään haigeks.");
  await expect(first.locator("[data-request-facts]")).toHaveText(facts("Soovib tühistada"));
  await expect(first).not.toContainText("registrationId");
  const second = page.locator(`[data-request="${change.id}"]`);
  await expect(second.getByRole("heading", { level: 3 })).toHaveText("Mari Maasikas");
  await expect(second.locator("[data-request-facts]")).toHaveText(facts("Soovib muuta aega"));
  await expect(second.locator("[data-request-message]")).toHaveCount(0); // no message: no line
  // „Vasta e-kirjaga ↗“ writes to the address she sent the request from, under the registration's course
  expect(decodeURIComponent((await first.locator("[data-request-reply]").getAttribute("href"))!)).toBe(`mailto:${email}?subject=Vastus sinu päringule — Kulmude lamineerimine`);

  // done as every request: at once, with the bar, and the card is in the fold
  await first.getByRole("button", { name: "Märgi tehtuks" }).click();
  await expect(page.locator("[data-undo-bar]")).toContainText("Märgitud tehtuks.");
  await expect(first).toBeHidden();
  await expect(page.locator("details[data-fold] summary")).toContainText("Tehtud (1)");

  // the link opens that registration's own drawer
  await second.getByRole("link", { name: "Ava registreering →" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/registreerimised\\?id=${f.registrations.awaiting}$`));
  const reg = page.locator(`[data-registration-detail="${f.registrations.awaiting}"]`);
  await expect(reg).toBeVisible();
  await expect(reg.getByRole("heading", { level: 2 })).toHaveText("Mari Maasikas");
  expect(await noOverflow(page)).toBe(true);
});

test("Maksmine's bank fields in Seaded: autosaved (the IBAN without spaces), her unpaid card shows it in groups of four; cleared, only 'Maksa' is left on the card (online payments are on, phase 2b)", async ({ page, context, browser, visitorIp }, info) => {
  // The prepayment instructions are one shared setting (the dashboard tests use it too): the runs take turns.
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  const release = await holdLocalLock("e2e-prepayment-setting");
  const restore = await snapshotRows("settings", { column: "key", value: "prepayment" });
  try {
    await setPrepayment(null);
    const email = await fresh("pay", info.project.name);
    const f = await insertAccountFixtures(email, { cards: ["awaiting"] });
    const student = await studentBrowser(browser, email, visitorIp);
    try {
      const unpaid = card(student.page, `registration-${f.registrations.awaiting}`);
      // no instructions yet: with online payments (the e2e server has the fake Montonio) the card still says what is due, and "Maksa 175 €" is its only button
      await expect(unpaid.locator("[data-next-step]")).toHaveText("Koha kinnitamiseks tasu ettemaks 175 €.");
      await expect(unpaid.locator("button, a")).toHaveText(["Maksa 175 €"]);

      await signInAsAdmin(page, context, visitorIp, created);
      page.on("dialog", (dialog) => void dialog.accept());
      await page.goto("/admin/seaded");
      await adminReady(page);
      // Seaded → „Maksmine“'s bank fields (admin UX pass piece 3b, Task 4): they save as they are left, under the page's one status
      const box = page.locator("[data-prepayment-editor]");
      await expect(box.getByText("Juhised on õpilasele näha ainult siis, kui saaja ja IBAN on täidetud.", { exact: false })).toBeVisible();
      const iban = box.getByRole("textbox", { name: "IBAN", exact: true });
      const storedPay = async () => (await onLocalDb((sql) => sql<{ value: Record<string, string> }[]>`select value from settings where key = 'prepayment'`, { marksPages: false }))[0]?.value;
      await box.getByRole("textbox", { name: "Saaja", exact: true }).fill("MS LAB OÜ");
      await iban.fill("EE38 12");
      await iban.press("Tab");
      await expect(seadedStatus(page)).toHaveAttribute("data-save-kind", "invalid");
      await expect(iban).toHaveAttribute("aria-invalid", "true");
      await expect(box.getByText("Kontrolli IBANi: kaks tähte, kaks numbrit ja konto number, nt EE38 2200 2210 2014 5685.")).toBeVisible();
      await iban.fill("ee38 2200 2210 2014 5685");
      await box.getByRole("textbox", { name: "Pank", exact: true }).fill("Swedbank");
      await box.getByRole("textbox", { name: "Selgituse algus", exact: true }).fill("MSLAB-");
      await box.getByRole("textbox", { name: "Selgituse algus", exact: true }).press("Tab");
      await expect(seadedStatus(page)).toHaveAttribute("data-save-kind", "saved");
      await expect.poll(storedPay).toEqual({ receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" }); // (stored without spaces, in capitals)

      await student.page.reload();
      await expect(unpaid.locator("[data-next-step]")).toHaveText("Koha kinnitamiseks tasu ettemaks 175 €.");
      await expect(unpaid.locator("button, a")).toHaveText(["Maksa 175 €", "Vaata juhiseid"]); // the transfer is the text button under "Maksa"
      await unpaid.getByRole("button", { name: "Vaata juhiseid" }).click();
      const panel = unpaid.locator("[data-prepayment]");
      await expect(panel.locator("[data-pay-row]")).toHaveText([
        /^Saaja\s*MS LAB OÜ$/,
        /^IBAN\s*EE38 2200 2210 2014 5685\s*Kopeeri/, // stored without spaces, read in groups of four
        /^Pank\s*Swedbank$/,
        /^Summa\s*175 €$/,
        new RegExp(`^Selgitus\\s*MSLAB-${f.registrations.awaiting}\\s*Kopeeri`),
      ]);

      // all four emptied: no instructions, so no "Vaata juhiseid"; "Maksa 175 €" is all that is left to press
      for (const name of ["Saaja", "IBAN", "Pank", "Selgituse algus"]) await box.getByRole("textbox", { name, exact: true }).fill("");
      await box.getByRole("textbox", { name: "Selgituse algus", exact: true }).press("Tab");
      await expect.poll(storedPay).toEqual({ receiver: "", iban: "", bank: "", referencePrefix: "" });
      await expect(seadedStatus(page)).toHaveAttribute("data-save-kind", "saved");
      await student.page.reload();
      await expect(unpaid.locator("[data-next-step]")).toHaveText("Koha kinnitamiseks tasu ettemaks 175 €.");
      await expect(unpaid.locator("button, a")).toHaveText(["Maksa 175 €"]);
    } finally {
      await student.close();
    }
  } finally {
    await restore();
    await release();
  }
});

test("her online payments in the drawer: a prepayment made before she had an account and an e-course purchase, in Maria's words; the access the purchase opened says 'Avas veebimakse' (phase 2b)", async ({ page, context, visitorIp }, info) => {
  const email = await fresh("pay", info.project.name);
  const name = `Pia E2E ${info.project.name}`;
  const f = await insertAccountFixtures(email, { name, cards: ["awaiting", "ecourse"] });
  const [seed] = await onLocalDb((sql) => sql<{ id: number }[]>`select id from courses where slug = ${f.ecourse.slug}`, { marksPages: false });
  // the prepayment was made before she had an account: it carries no client of its own, only its registration (which her login linked to her)
  const prepayment = await insertStoredPayment({ email, name, kind: "prepayment", status: "paid", amountCents: 17500, registrationId: f.registrations.awaiting, courseId: f.course.id, method: "paymentInitiation", bank: "Swedbank", paid: true, minutesAgo: 30 });
  const ecourse = await insertStoredPayment({ email, name, kind: "ecourse", status: "paid", amountCents: 19000, courseId: seed.id, clientId: f.clientId, method: "cardPayments", paid: true, minutesAgo: 5 });
  const voided = await insertStoredPayment({ email, name, kind: "balance", status: "failed", amountCents: 17500, registrationId: f.registrations.awaiting, courseId: f.course.id, method: "paymentInitiation", bank: "LHV", paid: true, minutesAgo: 10 });
  // the e-course purchase opened her access ("payment" is who opened it)
  await onLocalDb((sql) => sql`update course_access set granted_by = 'payment' where client_id = ${f.clientId}`, { marksPages: false });
  await signInAsAdmin(page, context, visitorIp, created);
  const d = await openStudent(page, email);

  // „Maksed“ is a folded row with its count and the sum paid (the paid ones: 190 € + 175 €; the voided one is not money in)
  await expect(fold(d, "Maksed").locator("[data-fold-summary]")).toHaveText("3 · 365 €");
  const paymentsRow = await openFold(d, "Maksed");
  const payments = paymentsRow.locator("[data-client-payments]");
  const shown = await payments.locator("[data-payment]").evaluateAll((lines) => lines.map((l) => l.getAttribute("data-payment")));
  expect(shown).toEqual([ecourse.reference, voided.reference, prepayment.reference]); // newest first: hers, and her registration's
  const line = (ref: string) => payments.locator(`[data-payment="${ref}"]`);
  await expect(line(ecourse.reference)).toContainText("190 €");
  await expect(line(ecourse.reference)).toContainText("E-koolitus · Kulmumeistri e-koolitus");
  await expect(line(ecourse.reference)).toContainText("Kaart");
  await expect(line(ecourse.reference)).toContainText("Makstud");
  await expect(line(prepayment.reference)).toContainText("175 €");
  await expect(line(prepayment.reference)).toContainText(`Ettemaks · ${f.course.title}`);
  await expect(line(prepayment.reference)).toContainText("Pangalink · Swedbank");
  await expect(line(voided.reference)).toContainText("Tühistatud pangas");
  await expect(line(voided.reference).locator("[data-payment-check]")).toHaveText("Kontrolli Montonios");
  await expect(line(prepayment.reference).locator("[data-payment-check]")).toHaveCount(0);
  await expect(payments).not.toContainText(/paymentInitiation|cardPayments/);
  await expect(d.locator("[data-access]")).toContainText("Avas veebimakse,");
  await expect(d.locator("[data-access]")).not.toContainText("Avas payment");
  expect(await smallTargets(d)).toEqual([]);
  expect(await noOverflow(page)).toBe(true);
});

test("a student with no online payments: the drawer says so", async ({ page, context, visitorIp }, info) => {
  const email = await fresh("nopay", info.project.name);
  await insertAccountFixtures(email, { name: `Nora E2E ${info.project.name}`, cards: ["confirmed"] });
  await signInAsAdmin(page, context, visitorIp, created);
  const d = await openStudent(page, email);
  await expect(fold(d, "Maksed").locator("[data-fold-summary]")).toHaveText("0");
  await expect((await openFold(d, "Maksed")).locator("[data-client-payments]")).toContainText("Makseid pole.");
  await expect(d.locator("[data-client-payments] [data-payment]")).toHaveCount(0);
});

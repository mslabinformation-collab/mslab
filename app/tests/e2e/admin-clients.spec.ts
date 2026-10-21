import type { Browser, Locator, Page } from "@playwright/test";
import { addMonths, defaultExpiryDate, tallinnToday } from "../../src/domain/client-access";
import { formatDate, formatTime } from "../../src/i18n/format";
import { clientEmail, insertAccountFixtures, setPrepayment, signInAsClient, takeTerms, TEST_PREPAYMENT, type AccountCardKind } from "./account";
import { ADMIN, adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
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
// the drawer, "Ava järgmine õppetund", and the read-only page of her course.

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

/** Opens a student's drawer from the list by searching her address. */
async function openStudent(page: Page, email: string): Promise<Locator> {
  await page.goto("/admin/opilased");
  await adminReady(page);
  await page.getByRole("searchbox", { name: "Otsi nime või e-posti järgi" }).fill(email);
  await page.getByRole("button", { name: "Otsi", exact: true }).click();
  await expect(page).toHaveURL(/[?&]otsi=/);
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

test("Lisa õpilane by e-mail, Ava ligipääs → she logs in and sees the e-course; Lõpeta ligipääs → it is over", async ({ page, context, browser, visitorIp }, info) => {
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

  // a bad address says what to do; a good one (as typed, any case) opens her drawer
  const field = page.getByRole("textbox", { name: "Lisa õpilane e-posti järgi" });
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
  await expect(d.locator("[data-client-access]")).toContainText("E-koolitusi pole avatud.");
  await expect(field).toHaveValue(""); // the form starts again
  expect(await sessions(id)).toEqual([]); // no session: she has never logged in

  // Ava ligipääs: the course picked, the date filled in with today + its 6 months; one press. A course without its own
  // length is filled in with 12 months, and the hint says so
  const grant = d.locator("[data-grant-form]");
  await grant.getByLabel("E-koolitus").selectOption({ label: `${noLength} (mustand)` });
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
  await expect(row).toContainText(`Avatud kuni ${shown}`);
  await expect(row).toContainText(`Avas ${ADMIN}`);
  // a course she has open says until when in the list to pick from (granting it again stays possible)
  await expect(grant.getByLabel("E-koolitus").locator("option", { hasText: "Kulmumeistri e-koolitus" })).toHaveText(`Kulmumeistri e-koolitus (avatud kuni ${shown})`);
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

    // Lõpeta ligipääs: one confirming step ("Ei" goes back), then it is over, here and for her
    await row.getByRole("button", { name: "Lõpeta ligipääs" }).click();
    const confirm = row.locator("[data-revoke-confirm]");
    await expect(confirm.getByText("Kas lõpetan ligipääsu koolitusele „Kulmumeistri e-koolitus“? Õpilane ei saa seda enam avada.")).toBeFocused();
    await confirm.getByRole("button", { name: "Ei" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Lõpeta ligipääs" })).toBeFocused();
    await row.getByRole("button", { name: "Lõpeta ligipääs" }).click();
    await row.getByRole("button", { name: "Jah, lõpeta" }).click();
    await expect(row).toHaveAttribute("data-access-state", "revoked");
    await expect(row).toContainText(`Lõpetatud ${formatDate(new Date(), "et")}`);
    await expect(row.locator(`[id$="-state"]`)).toBeFocused();
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

test("the list: Kõik / E-õpe / Kontaktõpe, search by name or e-mail, the number of courses; the drawer lists her courses", async ({ page, context, visitorIp }, info) => {
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

  const search = page.getByRole("searchbox", { name: "Otsi nime või e-posti järgi" });
  await search.fill(`e2e-client-adm-list-`);
  await page.getByRole("button", { name: "Otsi", exact: true }).click();
  await expect(page).toHaveURL(/\?otsi=e2e-client-adm-list-$/);
  const rows = page.locator("tr[data-client]");
  const mine = rows.filter({ hasText: info.project.name.toLowerCase() });
  await expect(mine).toHaveCount(2);
  await expect(mine.filter({ hasText: eStudent }).locator("[data-client-courses]")).toHaveText("1");
  await expect(mine.filter({ hasText: kStudent }).locator("[data-client-courses]")).toHaveText("1"); // the cancelled one does not count
  await expect(page.locator("[data-courses-hint]")).toHaveText("Koolitusi: tema registreerimised (tühistatuid arvestamata) ja e-koolitused (lõpetatud ligipääse arvestamata, aegunuid arvestatakse).");
  await expect(mine.filter({ hasText: kStudent }).getByRole("link")).toHaveText(`Kai E2E ${info.project.name}`); // the registration's name

  const filters = page.locator("[data-type-filter]");
  await filters.getByRole("link", { name: "E-õpe" }).click();
  await expect(page).toHaveURL(/vorm=e/);
  await expect(page).toHaveURL(/otsi=/); // the search stays
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(eStudent);
  await filters.getByRole("link", { name: "Kontaktõpe" }).click();
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(kStudent);
  await filters.getByRole("link", { name: "Kõik" }).click();
  await expect(mine).toHaveCount(2);

  // by name, any case; nothing found says so
  await search.fill(`kai e2e ${info.project.name.toUpperCase()}`);
  await page.getByRole("button", { name: "Otsi", exact: true }).click();
  await expect(page).toHaveURL(/otsi=kai/);
  await expect(rows).toHaveCount(1);
  await search.fill("ei-ole-sellist-õpilast-%");
  await page.getByRole("button", { name: "Otsi", exact: true }).click();
  await expect(page).toHaveURL(/otsi=ei-ole/);
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("Selle valikuga õpilasi pole.")).toBeVisible();
  await page.getByRole("link", { name: "Tühjenda otsing" }).click();
  await expect(page).toHaveURL(/\/admin\/opilased$/);

  // the drawer: her registrations (named as her cards name them), each opening its own drawer
  const d = await openStudent(page, kStudent);
  await expect(d.getByRole("heading", { level: 2 })).toHaveText(`Kai E2E ${info.project.name}`);
  await expect(d.locator("[data-client-newsletter]")).toHaveText("Uudiskiri: ootab kinnitust"); // phase 2c
  const reqs = d.locator("[data-client-request]");
  await expect(reqs).toHaveCount(1);
  await expect(reqs.locator("strong")).toHaveText("E-õppe huvi");
  await expect(reqs).toContainText("Kulmumeistri e-koolitus");
  const regs = d.locator("[data-client-registration]");
  await expect(regs).toHaveCount(2);
  const start = k.session.startsAt;
  await expect(regs.first()).toContainText(`Kulmude lamineerimine`);
  await expect(regs.first()).toContainText(`${formatDate(start, "et")} · ${formatTime(start, "et")}, Pärnu, MS LAB stuudio`);
  expect(await smallTargets(page.locator("main"))).toEqual([]);
  expect(await smallTargets(d)).toEqual([]);
  await d.locator(`[data-client-registration="${k.registrations.confirmed}"]`).getByRole("link", { name: "Ava registreerimine" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/registreerimised\\?id=${k.registrations.confirmed}$`));
  await expect(page.locator(`[data-registration-detail="${k.registrations.confirmed}"]`)).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
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

test("her lessons in the drawer: 1/3 tehtud, Ava järgmine õppetund (the student then has it), Vaata tema vaadet (read-only, her session untouched), nothing of it after the access ends", async ({ page, context, browser, visitorIp }, info) => {
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

      // the admin's drawer: done of all, her page of the course, and the button for the first locked lesson
      await signInAsAdmin(page, context, visitorIp, created);
      const d = await openStudent(page, email);
      const row = d.locator("[data-access]");
      await expect(row).toHaveCount(1);
      await expect(row.locator("[data-access-progress]")).toHaveText("1/3 tehtud");
      const viewLink = row.locator("[data-view-course]");
      await expect(viewLink).toHaveText("Vaata tema vaadet");
      await expect(viewLink).toHaveAttribute("href", `/admin/opilased/${course.clientId}/vaade/${course.slug}`);
      await expect(viewLink).toHaveAccessibleName("Vaata tema vaadet: E2E õppetunnid");
      const unlock = row.getByRole("button", { name: "Ava järgmine õppetund" });
      await expect(unlock).toBeVisible();
      expect(await smallTargets(row)).toEqual([]);

      // one confirming step ("Ei" goes back), then exactly that lesson is open: the line says so, and she has it
      await unlock.click();
      const confirm = row.locator("[data-unlock-confirm]");
      await expect(confirm.getByText("Kas avan õpilasele õppetunni „Kolmas tund“? Ta saab selle kohe vaadata.")).toBeFocused();
      expect(await smallTargets(row)).toEqual([]);
      await confirm.getByRole("button", { name: "Ei" }).click();
      await expect(confirm).toHaveCount(0);
      await expect(unlock).toBeFocused();
      await unlock.click();
      await confirm.getByRole("button", { name: "Jah, ava" }).click();
      const done = row.locator("[data-unlock-done]");
      await expect(done).toHaveText("Õppetund „Kolmas tund“ on avatud.");
      await expect(done).toHaveAttribute("role", "status");
      await expect(done).toBeFocused();
      await expect(confirm).toHaveCount(0);
      await expect(unlock).toHaveCount(0); // nothing is locked now
      await expect(row.locator("[data-access-progress]")).toHaveText("1/3 tehtud"); // opened, not done
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
      await viewLink.click();
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
      await expect(row.getByRole("button", { name: "Ava järgmine õppetund" })).toBeVisible();
      await expect(viewLink).toBeVisible();
      await row.getByRole("button", { name: "Lõpeta ligipääs" }).click();
      await row.getByRole("button", { name: "Jah, lõpeta" }).click();
      await expect(row).toHaveAttribute("data-access-state", "revoked");
      await expect(row.locator("[data-access-progress]")).toHaveText("1/3 tehtud");
      await expect(row.locator("[data-view-course]")).toHaveCount(0);
      await expect(row.getByRole("button", { name: "Ava järgmine õppetund" })).toHaveCount(0);
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

test("a change request in Päringud: the course and its date as the heading, the wish in words, a link that opens the registration", async ({ page, context, visitorIp }, info) => {
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
  const heading = `Kulmude lamineerimine — ${formatDate(start, "et")} · ${formatTime(start, "et")}`;
  const first = page.locator(`[data-request="${cancel.id}"]`);
  await expect(first.getByRole("heading", { level: 3 })).toHaveText(heading);
  // in words, no raw payload keys (registrationId, kind)
  await expect(first.locator("dt")).toHaveText(["Soov", "Toimumine", "Nimi", "E-post", "Sõnum"]);
  await expect(first.locator("dd")).toHaveText(["Soovib tühistada", "Pärnu, MS LAB stuudio", "Mari Maasikas", email, "Jään haigeks."]);
  await expect(first.locator("dl").getByRole("link", { name: email })).toHaveAttribute("href", `mailto:${email}`);
  const second = page.locator(`[data-request="${change.id}"]`);
  await expect(second.getByRole("heading", { level: 3 })).toHaveText(heading);
  await expect(second.locator("dt")).toHaveText(["Soov", "Toimumine", "Nimi", "E-post"]); // no message: no row
  await expect(second.locator("dd").first()).toHaveText("Soovib muuta aega");

  // handled / not handled as every request
  await first.getByRole("button", { name: "Märgi tehtuks" }).click();
  await expect(first.locator("[data-request-state]")).toHaveText("Tehtud");

  // the link opens that registration's own drawer
  await second.getByRole("link", { name: "Ava registreerimine" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/registreerimised\\?id=${f.registrations.awaiting}$`));
  const reg = page.locator(`[data-registration-detail="${f.registrations.awaiting}"]`);
  await expect(reg).toBeVisible();
  await expect(reg.getByRole("heading", { level: 2 })).toHaveText("Mari Maasikas");
  expect(await noOverflow(page)).toBe(true);
});

test("Ettemaksu juhised in Seaded: saved (the IBAN without spaces), her unpaid card shows it in groups of four; cleared, only 'Maksa' is left on the card (online payments are on, phase 2b)", async ({ page, context, browser, visitorIp }, info) => {
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
      const box = page.locator("[data-prepayment-editor]");
      await expect(box.getByText("Juhised on õpilasele näha ainult siis, kui saaja ja IBAN on täidetud.", { exact: false })).toBeVisible();
      const iban = box.getByRole("textbox", { name: "IBAN", exact: true });
      await box.getByRole("textbox", { name: "Saaja", exact: true }).fill("MS LAB OÜ");
      await iban.fill("EE38 12");
      await page.getByRole("button", { name: "Salvesta", exact: true }).click();
      await expect(page.locator("[data-save-status]")).toHaveText("Kontrolli märgitud välju.");
      await expect(iban).toHaveAttribute("aria-invalid", "true");
      await expect(box.getByText("Kontrolli IBANi: kaks tähte, kaks numbrit ja konto number, nt EE38 2200 2210 2014 5685.")).toBeVisible();
      await iban.fill("ee38 2200 2210 2014 5685");
      await box.getByRole("textbox", { name: "Pank", exact: true }).fill("Swedbank");
      await box.getByRole("textbox", { name: "Selgituse algus", exact: true }).fill("MSLAB-");
      await page.getByRole("button", { name: "Salvesta", exact: true }).click();
      await expect(page.locator("[data-save-status]")).toHaveText("Salvestatud.");
      await expect(iban).toHaveValue("EE382200221020145685");

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
      await page.getByRole("button", { name: "Salvesta", exact: true }).click();
      await expect(page.locator("[data-save-status]")).toHaveText("Salvestatud.");
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

  const payments = d.locator("[data-client-payments]");
  await expect(payments.getByRole("heading", { level: 3 })).toHaveText("Maksed");
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
  await expect(d.locator("[data-client-payments]")).toContainText("Makseid pole.");
  await expect(d.locator("[data-client-payments] [data-payment]")).toHaveCount(0);
});

import { readFileSync } from "node:fs";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { submitsForms, test, expect } from "./test";
import { adminReady, editLang, signInAsAdmin } from "./admin-login";
import { PROD_ENV } from "./prod-build";
import { DEV_ENV } from "./server";
import { PROD_BUILD } from "./target";
import { LABELLED, smallPills, smallTargets } from "./targets";
import {
  deleteStoredRequest,
  E2E_CAMPAIGN_PREFIX,
  insertAdminFixtures,
  insertAdminPayments,
  openRequestCount,
  removeAdminFixtures,
  removeAdminRows,
  removeCampaignRows,
  requestHandled,
  onLocalDb,
  setStoredStatus,
  storeRequestHandled,
  storedAdminRegistration,
  storedCampaigns,
  type AdminFixtures,
} from "./fixtures";

// Task 12: the admin shell (prototype B sidebar), the overview and the inboxes (registrations, requests, newsletter).
// The signed-in tests run against the local dev server only: they sign in as Dim through the devLink (no e-mail: global
// setup refuses a dev environment with RESEND_API_KEY) and look at rows each test inserts for itself (tests/e2e/
// fixtures.ts, an unpublished fixture course with its own session) and deletes again. The guard tests are GET-only and
// also run against a deployment.

// the grouped menu (admin UX pass, README §1.1), in the order it is drawn
const MENU = ["Ülevaade", "Registreerimised", "Protokollid", "Hindamine", "Päringud", "Õpilased", "Tagasiside", "Maksed ja arved", "Koolitused", "Kalender", "Praktika", "Avaleht", "Koolitaja", "Uudised", "Hüpikaken", "Uudiskiri", "Seaded", "Testimine"];
const GROUPS = ["Igapäevane töö", "Koolitused", "Koduleht ja uudiskiri", "Haldus"];

const created = { tokens: new Set<string>(), sessions: new Set<string>() };
let fx: AdminFixtures | null = null;

test.afterEach(async () => {
  await removeAdminRows({ tokens: created.tokens, sessions: created.sessions }).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
  if (fx) expect(await removeAdminFixtures(fx.tag)).toBe(0);
  fx = null;
});

/** Inserts this test's rows. */
async function fixtures(project: string, opts: { extraSubscribers?: number } = {}): Promise<AdminFixtures> {
  fx = await insertAdminFixtures(project, opts);
  return fx;
}

/** Signs in as Dim through the devLink, under the login lock shared by all workers (admin-login.ts); lands on /admin. */
const signIn = (page: Page, context: BrowserContext, ip: string) => signInAsAdmin(page, context, ip, created);

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/**
 * The admin menu: the sidebar on a wide screen (its folding group „Koduleht ja uudiskiri“ opened here, when it is closed), the menu panel (opened
 * here) on a phone, where every group is open.
 */
async function menu(page: Page, isMobile: boolean): Promise<Locator> {
  if (isMobile) {
    await page.getByRole("button", { name: "Ava menüü" }).click();
    const drawer = page.locator("[data-admin-drawer]");
    await expect(drawer).toBeVisible();
    return drawer.getByRole("navigation", { name: "Halduse menüü" });
  }
  const nav = page.locator("aside").getByRole("navigation", { name: "Halduse menüü" });
  const fold = nav.locator("button[data-nav-fold]");
  if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  return nav;
}

test.describe("guard (GET only, also against a deployment)", () => {
  test("the inbox pages and the CSV export need a session", async ({ request }) => {
    for (const path of ["/admin/registreerimised", "/admin/maksed", "/admin/paringud", "/admin/uudiskiri", "/admin/koolitused", "/admin/seaded"]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect([302, 303, 307], path).toContain(res.status());
      expect(new URL(res.headers()["location"], "http://x").pathname, path).toBe("/admin/login");
    }
    const csv = await request.get("/api/admin/subscribers.csv", { maxRedirects: 0 });
    expect(csv.status()).toBe(401);
    expect(csv.headers()["content-type"]).toContain("application/json");
    expect(csv.headers()["cache-control"]).toContain("no-store");
    expect(await csv.text()).not.toContain("@");
  });
});

test.describe("signed in", () => {
  test.beforeEach(() => submitsForms());

  test("overview: greeting, the numbers, the B menu with badges, quick links", async ({ page, context, visitorIp, isMobile }, info) => {
    await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tere, Dim.");
    await expect(page).toHaveTitle(/Ülevaade — Haldus/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    expect(Number(await page.locator('[data-stat="awaiting"] strong').textContent())).toBeGreaterThanOrEqual(1);
    expect(Number(await page.locator('[data-stat="requests"] strong').textContent())).toBeGreaterThanOrEqual(5);
    await expect(page.locator('[data-stat="sessions"]')).toContainText("Koolitused järgmise 30 päeva jooksul");
    await expect(page.locator('[data-stat="awaiting"]')).toHaveAttribute("href", "/admin/registreerimised?staatus=ootab");
    for (const key of ["contact", "interest", "individual", "practice", "waitlist"]) await expect(page.locator(`[data-inbox="${key}"]`)).toContainText("tegemata");
    await expect(page.getByRole("link", { name: "Lae alla kinnitatud tellijad (CSV)" })).toHaveAttribute("href", "/api/admin/subscribers.csv?kinnitatud=1");
    // "Kiirlingid → Vaata lehte ↗" goes through api/admin/preview like the top line's: with the coming-soon
    // gate on, a plain "/" would show the coming-soon page to an admin who has no preview cookie yet
    const quickSite = page.locator('section[aria-labelledby="links-title"]').getByRole("link", { name: /Vaata lehte/ });
    await expect(quickSite).toHaveAttribute("href", "/api/admin/preview");
    await expect(quickSite).toHaveAttribute("target", "_blank");
    await expect(quickSite).toHaveAttribute("rel", "noopener");
    expect(await noOverflow(page)).toBe(true);

    const nav = await menu(page, isMobile);
    const links = nav.getByRole("link");
    await expect(links).toHaveCount(MENU.length);
    for (const [i, label] of MENU.entries()) await expect(links.nth(i)).toContainText(label);
    await expect(nav.locator("[data-nav-group]")).toHaveText(GROUPS);
    await expect(nav.locator('[data-nav="overview"]')).toHaveAttribute("aria-current", "page");
    await expect(nav.locator('[data-badge="registrations"]')).toBeVisible();
    await expect(nav.locator('[data-badge="requests"]')).toBeVisible();
    // the footer: who is signed in, then the way out (a phone's menu adds „Vaata kodulehte ↗“)
    const side = page.locator(isMobile ? "[data-admin-drawer]" : "aside");
    await expect(side.locator("[data-nav-foot]")).toContainText("Sisse logitud");
    await expect(side.getByRole("button", { name: "Logi välja" })).toBeVisible();
    if (isMobile) {
      const site = side.getByRole("link", { name: /Vaata kodulehte/ });
      // through api/admin/preview: the coming-soon gate's preview cookie, then the home page (src/lib/site-gate.ts)
      await expect(site).toHaveAttribute("href", "/api/admin/preview");
      await expect(site).toHaveAttribute("target", "_blank");
      await expect(site).toHaveAttribute("rel", "noopener");
      // a phone has no top line: the link is on the screen once, in the menu
      await expect(page.locator("[data-admin-preview]")).toBeHidden();
    } else {
      // the sidebar has no „Vaata lehte“ any more: the top line's „Vaata kodulehte ↗“ is the only one
      await expect(side.getByRole("link", { name: /Vaata/ })).toHaveCount(0);
      const site = page.locator("[data-admin-preview]");
      await expect(site).toHaveCount(1);
      await expect(site).toHaveAttribute("href", "/api/admin/preview");
      await expect(site).toHaveAttribute("target", "_blank");
      await expect(site).toHaveAttribute("rel", "noopener");
      await expect(page.locator("[data-admin-top] [title]")).toHaveCount(0); // the avatar has no tooltip (a touch screen has none)
    }
    for (const target of await side.locator("nav a, nav button, [data-nav-foot] a, [data-nav-foot] button").all()) expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test("every content section opens its editor from the menu; none says 'Tulekul' any more", async ({ page, context, visitorIp, isMobile }) => {
    await signIn(page, context, visitorIp);
    // Task 13B replaced the last "Tulekul" pages with their editors
    const sections = [
      ["Praktika", "/admin/praktika", "Praktikapaketid", "[data-practice-editor]"],
      ["Avaleht", "/admin/avaleht", "Avaleht", "[data-home-editor]"],
      ["Koolitaja", "/admin/koolitaja", "Koolitaja", "[data-trainer-editor]"],
      ["Uudised", "/admin/uudised", "Uudised", "[data-add-post]"],
      ["Hüpikaken", "/admin/kampaania", "Hüpikaken", "[data-campaign-editor]"],
      ["Seaded", "/admin/seaded", "Seaded", "[data-settings-editor]"],
    ] as const;
    for (const [label, path, h1, marker] of sections) {
      await (await menu(page, isMobile)).getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(h1);
      await expect(page.locator(marker)).toBeVisible();
      await expect(page.getByText("Tulekul", { exact: true })).toHaveCount(0);
      if (isMobile) await expect(page.locator("[data-admin-drawer]")).toBeHidden(); // the link closed the drawer
    }
    const again = await menu(page, isMobile);
    await expect(again.locator('[data-nav="settings"]')).toHaveAttribute("aria-current", "page");
  });

  test("registrations: the fixture is under Kontaktõpe as 'Ootab ettemaksu'; 50% paid confirms it", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/registreerimised");
    // the form pills, light and with no count (A2; the whole list's columns and search are in the next test)
    const typeFilter = page.getByRole("navigation", { name: "Õppevorm", exact: true });
    await expect(typeFilter.getByRole("link")).toHaveText(["Kõik vormid", "E-õpe", "Kontaktõpe"]); // (the form pills carry no count: README A2)
    await expect(typeFilter.getByRole("link", { name: /^Kõik vormid/ })).toHaveAttribute("aria-current", "true");

    await typeFilter.getByRole("link", { name: /^Kontaktõpe/ }).click();
    await expect(page).toHaveURL(/\?vorm=k$/);
    const row = page.locator(`[data-registration="${f.registration.id}"]`);
    await expect(row).toContainText(f.registration.name);
    await expect(row).toContainText(f.course.title);
    await expect(row).toContainText("Pärnu");
    await expect(row).toContainText("0 / 350 €");
    await expect(row.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");
    expect(await noOverflow(page)).toBe(true);

    // the drawer: details, price 350 €, half 175 €
    await row.getByRole("link", { name: `Ava ${f.registration.name}` }).click();
    await expect(page).toHaveURL(new RegExp(`vorm=k&id=${f.registration.id}$`));
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    await expect(drawer).toBeVisible();
    // a contact course's registration: one tap to its protocol (phase protocols)
    await expect(drawer.locator("[data-registration-protocol]")).toHaveText("Ava protokoll");
    await expect(drawer.locator("[data-registration-protocol]")).toHaveAttribute("href", `/admin/protokollid?registreering=${f.registration.id}`);
    await expect(drawer).toContainText("350 €");
    await expect(drawer).toContainText("175 €");
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");

    const amount = drawer.getByLabel("Laekunud summa (€)");
    const save = drawer.getByRole("button", { name: "Salvesta summa" });
    await expect(amount).toHaveValue(""); // nothing paid yet: an empty field, not "0"
    // not an amount: an error on the field, nothing stored
    await amount.fill("palju");
    await save.click();
    await expect(drawer.getByText("Sisesta summa eurodes, näiteks 175 või 175,50.")).toBeVisible();
    await expect(amount).toHaveAttribute("aria-invalid", "true");
    expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 0, status: "awaiting_prepayment" });
    // below 50%: stays awaiting
    await amount.fill("174,99");
    await save.click();
    await expect(drawer.getByText("Summa salvestatud.")).toBeVisible();
    await expect(drawer.locator("[data-paid]")).toHaveText("174,99 €");
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");
    expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 17499, status: "awaiting_prepayment" });
    // 50%: confirmed
    await amount.fill("175");
    await save.click();
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Kinnitatud");
    await expect(drawer.locator("[data-paid]")).toHaveText("175 €");
    expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
    // the status choice follows the new status (a later note save must not undo the confirmation)
    await expect(drawer.getByRole("radio", { name: "Kinnitatud" })).toBeChecked();

    // Esc closes the drawer; the list shows the new status and the focus is back on the row's link
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/\?vorm=k$/);
    await expect(row.locator("[data-reg-status]")).toHaveText("Kinnitatud");
    await expect(row.getByRole("link", { name: `Ava ${f.registration.name}` })).toBeFocused();

    // E-õpe: not listed there; the old note "E-õppe ostud lisanduvad koos maksetega." is gone (the purchases are on Maksed and in the student's drawer)
    await typeFilter.getByRole("link", { name: /^E-õpe/ }).click();
    await expect(page).toHaveURL(/\?vorm=e$/);
    await expect(page.locator("[data-e-note]")).toHaveCount(0);
    await expect(page.getByText("lisanduvad koos maksetega")).toHaveCount(0);
    await expect(page.locator(`[data-registration="${f.registration.id}"]`)).toHaveCount(0);

    // status filter
    await page.goto("/admin/registreerimised?vorm=k&staatus=kinnitatud");
    await expect(page.locator(`[data-registration="${f.registration.id}"]`)).toBeVisible();
    await page.goto("/admin/registreerimised?vorm=k&staatus=ootab");
    await expect(page.locator(`[data-registration="${f.registration.id}"]`)).toHaveCount(0);
  });

  test("registrations list (B7): search by name, e-mail and phone, the session scope and the pills with counts; the drawer returns to the same list", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    // (the fixture's name and e-mail hold its tag; its phone is „+372 5555 0101“; its course has one session)
    const tag = f.course.slug.replace(/^e2e-admin-/, "");
    await page.goto("/admin/registreerimised");
    await adminReady(page);
    const field = page.getByRole("searchbox", { name: "Otsi nime, e-posti või telefoni järgi" });
    const row = page.locator(`[data-registration="${f.registration.id}"]`);
    const rows = page.locator("tbody tr");
    const status = page.getByRole("navigation", { name: "Staatus", exact: true });
    const forms = page.getByRole("navigation", { name: "Õppevorm", exact: true });
    /** Types into the search field and waits until the address holds the text (one line, the spaces squeezed) and the list on the screen is the one for it (its pills carry it). */
    const search = async (text: string) => {
      await field.fill(text);
      const q = text.replace(/\s+/g, " ").trim();
      await expect.poll(() => new URL(page.url()).searchParams.get("otsi")).toBe(q);
      await expect.poll(async () => new URL((await status.getByRole("link").first().getAttribute("href"))!, "http://localhost").searchParams.get("otsi")).toBe(q);
    };

    // the name (a part of it, in capitals), the e-mail address, and a phone typed with other spaces: the search finds it as she types
    await search(tag.toUpperCase());
    await expect(row).toBeVisible();
    await expect(rows).toHaveCount(1);
    await search(f.registration.email);
    await expect(rows).toHaveCount(1);
    await expect(row).toBeVisible();
    await search("5555  0101"); // (the address holds one space: what the page read)
    await expect(row).toBeVisible();
    await search("+372 5555-0101");
    await expect(row).toBeVisible();
    await search("5555 0101"); // (and the same number without the country code finds it: it is stored with „+372“)
    await expect(row).toBeVisible();

    // the columns and what a row says
    await search(tag);
    await expect(rows).toHaveCount(1);
    await expect(page.locator("thead th")).toHaveText(["Kuupäev", "Nimi ja kontakt", "Koolitus ja toimumine", "Laekunud", "Staatus"]);
    await expect(row).toContainText(f.registration.name);
    await expect(row).toContainText(f.course.title);
    await expect(row).toContainText(/\d{2}\.\d{2} · Pärnu/);
    await expect(row).toContainText("0 / 350 €");
    await expect(row.locator("a[href^='mailto:']")).toHaveCount(0);
    await expect(row.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");

    // the status pills count under the search: this one registration is awaiting its prepayment
    await expect(status.getByRole("link")).toHaveText([/^Kõik\s*1$/, /^Ootab ettemaksu\s*1$/, /^Kinnitatud\s*0$/, /^Tühistatud\s*0$/]);
    await expect(forms.getByRole("link")).toHaveText(["Kõik vormid", "E-õpe", "Kontaktõpe"]);
    await expect(forms).toHaveAttribute("data-tone", "light");
    // the chosen form pill is the light one (first-light fill, ink border), the chosen status pill the ink one
    const fill = (link: Locator) => link.evaluate((a) => getComputedStyle(a).backgroundColor);
    expect(await fill(forms.getByRole("link", { name: "Kõik vormid" }))).toBe("rgb(235, 232, 233)");
    expect(await fill(status.getByRole("link", { name: /^Kõik/ }))).toBe("rgb(34, 34, 34)");
    await status.getByRole("link", { name: /^Kinnitatud/ }).click();
    await expect(page).toHaveURL(new RegExp(`otsi=${tag}.*staatus=kinnitatud|staatus=kinnitatud.*otsi=${tag}`));
    await expect(page.locator("[data-list-empty] p")).toHaveText(`„${tag}“ järgi registreerimisi ei leitud.`);
    await page.getByRole("link", { name: "Tühjenda otsing ja filtrid" }).click();
    await expect(page).toHaveURL(/\/admin\/registreerimised$/);
    await expect(field).toHaveValue("");

    // the scope: the course, then its sessions indented under it; choosing a session keeps the search and starts at page 1
    await search(tag);
    await expect(rows).toHaveCount(1);
    const scope = page.getByRole("combobox", { name: "Koolitus ja toimumine" });
    await expect(scope.locator("option").first()).toHaveText("Kõik koolitused ja toimumised");
    await expect(scope.locator(`option[value="k${f.course.id}"]`)).toHaveText(f.course.title);
    await expect(scope.locator(`option[value="s${f.session.id}"]`)).toHaveText(/^\s*\d{2}\.\d{2}\.\d{4} Pärnu$/);
    await scope.selectOption(`s${f.session.id}`);
    await expect(page).toHaveURL(new RegExp(`toimumine=${f.session.id}`));
    await expect(page).toHaveURL(new RegExp(`otsi=${tag}`));
    await expect(rows).toHaveCount(1);
    await scope.selectOption(`k${f.course.id}`);
    await expect(page).toHaveURL(new RegExp(`koolitus=${f.course.id}`));
    await expect(page).not.toHaveURL(/toimumine=/);
    await expect(row).toBeVisible();
    // a scope with nothing in it
    const other = await scope.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v.startsWith("k")));
    const elsewhere = other.find((v) => v !== `k${f.course.id}`)!;
    await scope.selectOption(elsewhere);
    await expect(page.locator("[data-list-empty]")).toBeVisible();
    await scope.selectOption(`s${f.session.id}`);
    await expect(row).toBeVisible();

    // the drawer opens over the same list and closes back to it (search and scope kept)
    await row.getByRole("link", { name: `Ava ${f.registration.name}` }).click();
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`otsi=${tag}.*toimumine=${f.session.id}.*id=${f.registration.id}$`));
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`otsi=${tag}.*toimumine=${f.session.id}$`));
    await expect(row).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
  });

  test("registrations list on a phone: a card of the name and the status, the course, then „session · laekunud x“ (no label rows)", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(!isMobile, "the phone project only");
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    const tag = f.course.slug.replace(/^e2e-admin-/, "");
    await page.goto(`/admin/registreerimised?otsi=${tag}`);
    await adminReady(page);
    const row = page.locator(`[data-registration="${f.registration.id}"]`);
    await expect(row).toBeVisible();
    const box = async (selector: string) => (await row.locator(selector).first().boundingBox())!;
    const name = await box(`a[aria-label="Ava ${f.registration.name}"]`);
    const pill = await box("[data-reg-status]");
    const course = await box("td:nth-child(3) span:first-child");
    const session = await box("td:nth-child(3) span:last-child");
    const paid = await box("td:nth-child(4)");
    // line 1: the name and the status pill side by side; line 2: the course; line 3: the session and the money, one after the other
    expect(Math.abs(name.y + name.height / 2 - (pill.y + pill.height / 2)), "the name and the pill share a line").toBeLessThan(24);
    expect(pill.x).toBeGreaterThan(name.x);
    expect(course.y, "the course is under the name").toBeGreaterThan(name.y + name.height - 14);
    expect(session.y, "the session is under the course").toBeGreaterThan(course.y);
    expect(Math.abs(paid.y + paid.height / 2 - (session.y + session.height / 2)), "the money is on the session's line").toBeLessThan(6);
    expect(paid.x, "the money follows the session").toBeGreaterThan(session.x + session.width - 2);
    // no label rows, no date, no phone
    await expect(row.locator("td").first()).toBeHidden();
    await expect(row.locator("a[href^='tel:']")).toBeHidden();
    const before = await row.locator("td:nth-child(4)").evaluate((td) => getComputedStyle(td, "::before").content);
    // (the money follows the session with „· laekunud“: the bullet is CSS, the word the dictionary's, from the cell's data-paid-word)
    expect(before.replace(/[^\p{L}·]/gu, "")).toBe("·laekunud");
    await expect(row.locator("td:nth-child(2)")).not.toContainText("Nimi ja kontakt");
    expect(await noOverflow(page)).toBe(true);
    // a tap on the card opens the drawer
    await expect(async () => {
      const b = (await row.locator("td:nth-child(3) span:first-child").boundingBox())!;
      await page.mouse.click(b.x + 20, b.y + b.height / 2);
      await expect(page).toHaveURL(new RegExp(`id=${f.registration.id}$`), { timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    // (the list behind the drawer never makes the page scroll sideways: contracts.spec.ts checks the drawer at 390 with it open)
    await expect(page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
  });

  test("registrations list at 375 px with a very long city: the card wraps it and the page never scrolls sideways", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(!isMobile, "the phone project only");
    const f = await fixtures(info.project.name);
    // 45 letters with no place to break, the worst a city can be (a public page shows nothing of this unpublished course's session)
    const city = "Pneumonoultramicroscopicsilicovolcanoconiosis";
    await onLocalDb((sql) => sql`update course_sessions set city = ${city} where id = ${f.session.id}`, { marksPages: false });
    await signIn(page, context, visitorIp);
    await page.setViewportSize({ width: 375, height: 812 });
    const tag = f.course.slug.replace(/^e2e-admin-/, "");
    await page.goto(`/admin/registreerimised?otsi=${tag}`);
    await adminReady(page);
    const row = page.locator(`[data-registration="${f.registration.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(city.slice(0, 10));
    expect(await noOverflow(page)).toBe(true);
    // the session line and the money stay inside the row (the line breaks inside the long word, and the money goes under it)
    const card = (await row.boundingBox())!;
    const inside = async (selector: string, what: string) => {
      const b = (await row.locator(selector).first().boundingBox())!;
      expect(b.x, `${what}: left edge`).toBeGreaterThanOrEqual(card.x - 1);
      expect(b.x + b.width, `${what}: right edge`).toBeLessThanOrEqual(card.x + card.width + 1);
    };
    await inside("td:nth-child(3) span:last-child", "the session");
    await inside("td:nth-child(4)", "the money");
    await inside("[data-reg-status]", "the status pill");
  });

  test("registrations: status and note by hand, then 'Tühista'", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/registreerimised?id=${f.registration.id}`);
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("radio", { name: "Kinnitatud" }).check();
    await drawer.getByLabel("Märkus").fill("Maksis kohapeal sularahas");
    await drawer.getByRole("button", { name: "Salvesta staatus" }).click();
    await expect(drawer.getByText("Staatus salvestatud.")).toBeVisible();
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Kinnitatud");
    expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ status: "confirmed", note: "Maksis kohapeal sularahas", paidCents: 0 });

    await drawer.getByRole("button", { name: "Tühista registreerimine" }).click();
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Tühistatud");
    await expect(drawer.locator("[data-cancelled]")).toBeFocused();
    expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ status: "cancelled", note: "Maksis kohapeal sularahas" });
    // a payment does not revive a cancelled registration
    await drawer.getByLabel("Laekunud summa (€)").fill("350");
    await drawer.getByRole("button", { name: "Salvesta summa" }).click();
    await expect(drawer.locator("[data-paid]")).toHaveText("350 €");
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Tühistatud");

    await drawer.getByRole("button", { name: "Sulge" }).click();
    await expect(drawer).toBeHidden();
    await expect(page.locator(`[data-registration="${f.registration.id}"] [data-reg-status]`)).toHaveText("Tühistatud");
  });

  test("registrations: a status form that saw an old status does not overwrite the change made meanwhile", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/registreerimised?vorm=k&id=${f.registration.id}`);
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");
    await setStoredStatus(f.registration.id, "cancelled"); // e.g. Maria cancelled it in another tab
    await drawer.getByRole("radio", { name: "Kinnitatud" }).check();
    await drawer.getByRole("button", { name: "Salvesta staatus" }).click();
    await expect(drawer.getByText("Staatus muutus vahepeal (näed nüüd kehtivat). Vaata üle ja salvesta uuesti.")).toBeVisible();
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Tühistatud");
    await expect(drawer.getByRole("radio", { name: "Tühistatud" })).toBeChecked();
    expect((await storedAdminRegistration(f.registration.id)).status).toBe("cancelled");
    // now that it shows the stored status, a change goes through
    await drawer.getByRole("radio", { name: "Kinnitatud" }).check();
    await drawer.getByRole("button", { name: "Salvesta staatus" }).click();
    await expect(drawer.getByText("Staatus salvestatud.")).toBeVisible();
    expect((await storedAdminRegistration(f.registration.id)).status).toBe("confirmed");
  });

  test("payments: Maksed after Registreerimised — newest first, Maria's words, 'Kontrolli Montonios', the filter", async ({ page, context, visitorIp, isMobile }, info) => {
    const f = await fixtures(info.project.name);
    const p = await insertAdminPayments(f);
    await signIn(page, context, visitorIp);
    await (await menu(page, isMobile)).getByRole("link", { name: /^Maksed ja arved/ }).click(); // (its badge, when there is one, is part of the name)
    await expect(page).toHaveURL(/\/admin\/maksed$/);
    if (isMobile) await expect(page.locator("[data-admin-drawer]")).toBeHidden(); // the link closed the drawer
    await expect(page).toHaveTitle(/Maksed ja arved — Haldus/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Maksed");
    await expect(page.locator("aside [data-nav='payments']")).toHaveAttribute("aria-current", "page"); // (a phone has it in the menu drawer)
    await expect(page.getByText("Veebimaksed Montonio kaudu, uuemad eespool. Tagastused tehakse Montonio halduses;")).toBeVisible();
    await expect(page.getByText("töölaual")).toHaveCount(0);

    const row = (reference: string) => page.locator(`[data-payment="${reference}"]`);
    const cell = (reference: string, label: string) => row(reference).locator(`[data-label="${label}"]`);
    // newest first: the e-course purchase, the pending one, the voided one, the held one, the paid one (other tests' payments may lie between)
    const shown = await page.locator("tr[data-payment]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-payment")));
    const mine = [p.ecourse, p.pending, p.voided, p.held, p.paid];
    expect(shown.filter((ref) => mine.includes(ref!))).toEqual(mine);

    // Eest / Makseviis, the method in Maria's Estonian (never Montonio's code), the kind and the amount
    await expect(cell(p.paid, "Maksja")).toContainText(f.registration.name);
    await expect(cell(p.paid, "Maksja").getByRole("link", { name: f.registration.email })).toHaveAttribute("href", `mailto:${f.registration.email}`);
    await expect(cell(p.paid, "Eest")).toContainText(f.course.title);
    await expect(cell(p.paid, "Liik")).toHaveText("Ettemaks");
    await expect(cell(p.paid, "Summa")).toHaveText("175 €");
    await expect(cell(p.paid, "Makseviis")).toHaveText("Pangalink · Swedbank");
    await expect(cell(p.held, "Makseviis")).toHaveText("Kaart");
    await expect(cell(p.voided, "Makseviis")).toHaveText("Pangalink · LHV");
    await expect(cell(p.ecourse, "Makseviis")).toHaveText("Apple Pay");
    await expect(cell(p.pending, "Makseviis")).toHaveText("—");
    await expect(cell(p.ecourse, "Eest")).toContainText("Kulmumeistri e-koolitus");
    await expect(cell(p.ecourse, "Liik")).toHaveText("E-koolitus");
    await expect(cell(p.held, "Liik")).toHaveText("Ülejäänud");
    await expect(cell(p.paid, "Montonio id")).not.toHaveText("—");
    await expect(page.locator("main")).not.toContainText(/paymentInitiation|cardPayments|applePay/);

    // statuses in Estonian; "Kontrolli Montonios" on the held and the voided row only, with a tinted row
    await expect(cell(p.paid, "Staatus")).toHaveText("Makstud");
    await expect(cell(p.pending, "Staatus")).toHaveText("Pooleli");
    await expect(cell(p.held, "Staatus")).toContainText("Ootel kontrollil");
    await expect(cell(p.voided, "Staatus")).toContainText("Tühistatud pangas");
    for (const ref of [p.held, p.voided]) await expect(row(ref).locator("[data-payment-check]")).toHaveText("Kontrolli Montonios");
    for (const ref of [p.paid, p.pending, p.ecourse]) await expect(row(ref).locator("[data-payment-check]")).toHaveCount(0);
    const tint = (ref: string) => cell(ref, "Staatus").evaluate((td) => getComputedStyle(td).backgroundColor);
    expect(await tint(p.held)).not.toBe("rgba(0, 0, 0, 0)");
    expect(await tint(p.voided)).not.toBe("rgba(0, 0, 0, 0)");
    expect(await tint(p.paid)).toBe("rgba(0, 0, 0, 0)");

    expect(await noOverflow(page)).toBe(true);
    expect(await smallTargets(page.locator("main"))).toEqual([]);
    if (!isMobile) {
      await page.setViewportSize({ width: 834, height: 1112 }); // a tablet: between the phone and the desktop
      expect(await noOverflow(page)).toBe(true);
      expect(await smallTargets(page.locator("main"))).toEqual([]);
      await page.setViewportSize({ width: 1440, height: 900 });
    }

    // the filter: Kõik / Makstud / Pooleli / Ebaõnnestunud / Tagastatud / Ootel kontrollil, each its own address
    const filter = page.locator("[data-payment-filter]");
    await expect(filter.getByRole("link")).toHaveText(["Kõik", "Makstud", "Pooleli", "Ebaõnnestunud", "Tagastatud", "Ootel kontrollil"]);
    await expect(filter.getByRole("link", { name: "Kõik" })).toHaveAttribute("aria-current", "true");
    await filter.getByRole("link", { name: "Ootel kontrollil" }).click();
    await expect(page).toHaveURL(/\?staatus=kontroll$/);
    await expect(filter.getByRole("link", { name: "Ootel kontrollil" })).toHaveAttribute("aria-current", "true");
    await expect(row(p.held)).toBeVisible();
    await expect(row(p.paid)).toHaveCount(0);
    await filter.getByRole("link", { name: "Ebaõnnestunud" }).click();
    await expect(page).toHaveURL(/\?staatus=ebaonnestunud$/);
    await expect(row(p.voided)).toBeVisible(); // the bank's reversal is a failure that carries the note
    await expect(row(p.held)).toHaveCount(0);
    await page.goto("/admin/maksed?staatus=makstud");
    await expect(row(p.paid)).toBeVisible();
    await expect(row(p.ecourse)).toBeVisible();
    await expect(row(p.pending)).toHaveCount(0);
    await page.goto("/admin/maksed?staatus=midagi&leht=zzz"); // not a status, not a page: everything, page 1
    await expect(row(p.paid)).toBeVisible();
  });

  test("payments: the registration's drawer lists its online payments under 'Laekunud'; Maria's amount form stays", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    const p = await insertAdminPayments(f);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/registreerimised?id=${f.registration.id}`);
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    await expect(drawer).toBeVisible();
    const online = drawer.locator("[data-registration-payments]");
    await expect(online.getByRole("heading", { level: 3 })).toHaveText("Veebimaksed");
    // its own four, newest first; the e-course purchase of another address is not among them
    const shown = await online.locator("[data-payment]").evaluateAll((lines) => lines.map((l) => l.getAttribute("data-payment")));
    expect(shown).toEqual([p.pending, p.voided, p.held, p.paid]);
    const line = (ref: string) => online.locator(`[data-payment="${ref}"]`);
    await expect(line(p.paid)).toContainText("175 €");
    await expect(line(p.paid)).toContainText("Ettemaks");
    await expect(line(p.paid)).toContainText("Pangalink · Swedbank");
    await expect(line(p.paid)).toContainText("Makstud");
    await expect(line(p.held)).toContainText("Ülejäänud");
    await expect(line(p.held)).toContainText("Kaart");
    await expect(line(p.held)).toContainText("Ootel kontrollil");
    await expect(line(p.voided)).toContainText("Tühistatud pangas");
    await expect(line(p.pending)).toContainText("Pooleli");
    for (const ref of [p.held, p.voided]) await expect(line(ref).locator("[data-payment-check]")).toHaveText("Kontrolli Montonios");
    for (const ref of [p.paid, p.pending]) await expect(line(ref).locator("[data-payment-check]")).toHaveCount(0);
    await expect(online).not.toContainText(/paymentInitiation|cardPayments/);
    // Maria's own "amount received" form is still there and still works
    await drawer.getByLabel("Laekunud summa (€)").fill("175");
    await drawer.getByRole("button", { name: "Salvesta summa" }).click();
    await expect(drawer.getByText("Summa salvestatud.")).toBeVisible();
    await expect(drawer.locator("[data-paid]")).toHaveText("175 €");
    expect(await smallTargets(online)).toEqual([]); // (Maria's own status radios are the registration forms' business, unchanged)
    expect(await noOverflow(page)).toBe(true);
  });

  test("payments: a registration with no online payments has no such block", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/registreerimised?id=${f.registration.id}`);
    await expect(page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` })).toBeVisible();
    await expect(page.locator("[data-registration-payments]")).toHaveCount(0);
  });

  test("requests: tabs Kontakt / Individuaal / Praktika / Ootenimekiri / Muutmine, the practice request, 'Märgi tehtuks'", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/paringud");
    const tabs = page.locator("[data-request-tabs]");
    await expect(tabs.getByRole("link")).toHaveText([/^Kontakt/, /^Individuaal/, /^Praktika/, /^Ootenimekiri/, /^Muutmine/]);
    await expect(tabs.locator('[data-tab="kontakt"]')).toHaveAttribute("aria-current", "page");

    // Kontakt: the message and the e-learning purchase interest (tagged)
    const contact = page.locator(`[data-request="${f.contact.id}"]`);
    await expect(contact).toContainText(f.contact.name);
    await expect(contact).toContainText("Kas jaanuaris on veel kohti?");
    const interest = page.locator(`[data-request="${f.interest.id}"]`);
    await expect(interest).toContainText("E-õppe huvi");
    await expect(interest).toContainText("Kulmumeistri e-koolitus");
    await expect(interest).toContainText("RU");
    await expect(contact).not.toContainText("E-õppe huvi");
    expect(await noOverflow(page)).toBe(true);

    // Praktika
    await tabs.getByRole("link", { name: /^Praktika/ }).click();
    await expect(page).toHaveURL(/\?liik=praktika$/);
    const practice = page.locator(`[data-request="${f.practice.id}"]`);
    await expect(practice).toContainText(f.practice.name);
    await expect(practice).toContainText("MINI");
    await expect(practice).toContainText("Tööpäeviti pärast kella 17");
    await expect(practice).toContainText("Kulmumeistri baaskoolitus");
    await expect(practice.locator("[data-request-state]")).toHaveText("Uus");
    await practice.getByRole("button", { name: "Märgi tehtuks" }).click();
    await expect(practice.locator("[data-request-state]")).toHaveText("Tehtud");
    await expect.poll(() => requestHandled(f.practice.id)).toBe(true);
    await practice.getByRole("button", { name: "Märgi tegemata" }).click();
    await expect(practice.locator("[data-request-state]")).toHaveText("Uus");
    await expect.poll(() => requestHandled(f.practice.id)).toBe(false);

    // Individuaal and Ootenimekiri: course names (and the session) instead of slugs and ids
    await tabs.getByRole("link", { name: /^Individuaal/ }).click();
    const individual = page.locator(`[data-request="${f.individual.id}"]`);
    await expect(individual).toContainText(f.course.title);
    await expect(individual).toContainText("Jaanuari teine pool");
    await tabs.getByRole("link", { name: /^Ootenimekiri/ }).click();
    const waitlist = page.locator(`[data-request="${f.waitlist.id}"]`);
    await expect(waitlist).toContainText(f.waitlist.name);
    await expect(waitlist).toContainText(f.course.title);
    await expect(waitlist).toContainText(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}, Pärnu/);
  });

  test("e-mail and phone links are 44 px touch targets: the registrations list's phone, the drawer, requests (item 12)", async ({ page, context, visitorIp, isMobile }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    const targets = async (scope: Locator, min: number) => {
      const links = scope.locator("a[href^='mailto:'], a[href^='tel:']");
      await expect(links.nth(min - 1)).toBeVisible();
      for (const a of await links.all()) {
        const box = (await a.boundingBox())!;
        expect(box.height, (await a.getAttribute("href")) ?? "").toBeGreaterThanOrEqual(44);
        expect(box.width, (await a.getAttribute("href")) ?? "").toBeGreaterThanOrEqual(44);
      }
    };
    const disjoint = async (row: Locator) => {
      // the name, e-mail and phone targets of one row never overlap (a tap reaches the one it is on)
      const boxes = await row.locator("a").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const [a, b] = [boxes[i], boxes[j]];
          expect(a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5 && a.left < b.right - 0.5 && b.left < a.right - 0.5, `${i}/${j}`).toBe(false);
        }
    };
    await page.goto("/admin/registreerimised?vorm=k");
    const row = page.locator(`[data-registration="${f.registration.id}"]`);
    // the list row has the name and the phone (A2: the e-mail is in the drawer, and the search finds it); a phone card has neither the phone nor the date
    const phone = row.locator("a[href^='tel:']");
    if (isMobile) await expect(phone).toBeHidden();
    else {
      await targets(row, 1);
      await disjoint(row.locator('[data-label="Nimi ja kontakt"]'));
    }
    // The whole row is one link (ListRows.tsx, Task 13): a click on the row away from the name and its controls opens the row's drawer (the click is
    // repeated until the page is hydrated enough to answer it), a click on the phone is the phone's own and opens no drawer.
    const nameLink = row.getByRole("link", { name: `Ava ${f.registration.name}` });
    if (!isMobile) {
      await phone.evaluate((a) => a.addEventListener("click", (e) => e.preventDefault())); // no phone program is to open
      await phone.click();
      await expect(page).not.toHaveURL(/[?&]id=/);
    }
    await expect(async () => {
      const box = (await row.locator('[data-label="Koolitus ja toimumine"] span').first().boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page).toHaveURL(new RegExp(`[?&]id=${f.registration.id}$`), { timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    await expect(page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]id=/); // closed: the address has followed
    await nameLink.click();
    await targets(page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` }), 2);
    await page.goto("/admin/paringud?liik=individuaal");
    await targets(page.locator(`[data-request="${f.individual.id}"]`), 2);
    expect(await noOverflow(page)).toBe(true);
  });

  test("menu badges follow a client-side move: the Päringud badge counts what is open now after a click on the menu and after Back", async ({ page, context, visitorIp, isMobile }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/paringud?liik=praktika");
    // the badge as the sidebar (hidden on a phone, where the menu is in the panel) shows it: the number, or none
    const shown = async () => {
      const badge = page.locator('aside [data-badge="requests"] [aria-hidden]');
      return (await badge.count()) === 0 ? 0 : Number(await badge.textContent());
    };
    // the sidebar's question to the server (a move, or the window coming back, asks it)
    const answered = () => page.waitForResponse((res) => new URL(res.url()).pathname === "/api/admin/margid" && res.status() === 200);
    // The badge is what the database says. Other tests' rows come and go meanwhile, so while the two differ the window "comes back" and the
    // sidebar asks again.
    const rightNow = () =>
      expect
        .poll(async () => {
          if ((await shown()) === (await openRequestCount())) return true;
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          return false;
        })
        .toBe(true);
    const practice = page.locator(`[data-request="${f.practice.id}"]`);
    await expect(practice).toBeVisible();
    expect(await shown()).toBeGreaterThanOrEqual(5);
    await practice.getByRole("button", { name: "Märgi tehtuks" }).click(); // (the page is refreshed by its action)
    await expect.poll(() => requestHandled(f.practice.id)).toBe(true);

    // a request done elsewhere (the other tab, the other admin) is behind this page's back; a move through the menu is client-side, so the layout
    // does not render again: the sidebar asks for the numbers
    await storeRequestHandled(f.individual.id, true);
    await page.evaluate(() => ((window as unknown as { __stays: boolean }).__stays = true));
    const nav = await menu(page, isMobile);
    // a badged row opens its page already filtered (the fixture's registration is waiting for its prepayment)
    await expect(nav.locator('a[data-nav="registrations"]')).toHaveAttribute("href", "/admin/registreerimised?staatus=ootab");
    const moved = answered();
    await nav.getByRole("link", { name: "Kalender" }).click();
    await moved;
    await expect(page).toHaveURL(/\/admin\/kalender/);
    await rightNow();

    // and again, and Back
    await storeRequestHandled(f.individual.id, false);
    const back = answered();
    await page.goBack();
    await back;
    await expect(page).toHaveURL(/\/admin\/paringud\?liik=praktika/);
    await rightNow();
    expect(await page.evaluate(() => (window as unknown as { __stays?: boolean }).__stays)).toBe(true); // no full load on the way
  });

  test("requests: a failed 'Märgi tehtuks' says so instead of failing silently", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/paringud?liik=praktika");
    const practice = page.locator(`[data-request="${f.practice.id}"]`);
    await expect(practice).toBeVisible();
    await deleteStoredRequest(f.practice.id); // gone behind the open page
    await practice.getByRole("button", { name: "Märgi tehtuks" }).click();
    await expect(practice.getByRole("status")).toHaveText("Salvestamine ei õnnestunud. Proovi uuesti.");
  });

  test("newsletter: 50 subscribers a page, Järgmine / Eelmine, an out-of-range ?leht= shows the last page", async ({ page, context, visitorIp }, info) => {
    // The desktop and phone projects run side by side and both put their 55 subscribers into this one table, and every other admin test adds two:
    // how many pages there are is whatever the whole table makes of it at the moment a page is read. So no page count is carried from one page
    // view to the next (it once was, and "Lehekülg 2 / 3" followed a first page that had said "/ 2"); each view is checked against itself: 50 on
    // the first page, a second page that says "2 / N", and the page the address 9999 lands on is the last one, "N / N".
    await fixtures(info.project.name, { extraSubscribers: 55 });
    await signIn(page, context, visitorIp);
    await page.goto("/admin/uudiskiri");
    const pager = page.locator("[data-pager]");
    await expect(pager).toContainText(/Lehekülg 1 \/ \d+/);
    expect(Number((await pager.textContent())!.match(/Lehekülg 1 \/ (\d+)/)![1])).toBeGreaterThanOrEqual(2); // (our 55 alone are more than a page)
    await expect(page.locator("[data-subscriber]")).toHaveCount(50);
    await expect(pager.getByRole("link", { name: /Eelmine/ })).toHaveCount(0);
    await pager.getByRole("link", { name: /Järgmine/ }).click();
    await expect(page).toHaveURL(/\/admin\/uudiskiri\?leht=2$/);
    await expect(pager).toContainText(/Lehekülg 2 \/ \d+/);
    await expect(pager.getByRole("link", { name: /Eelmine/ })).toHaveAttribute("href", "/admin/uudiskiri");
    await page.goto("/admin/uudiskiri?leht=9999");
    await expect(pager).toContainText(/Lehekülg (\d+) \/ \1(?!\d)/); // the last page: N / N
    expect(Number((await pager.textContent())!.match(/Lehekülg (\d+) \/ \1(?!\d)/)![1])).toBeGreaterThanOrEqual(2);
    await expect(pager.getByRole("link", { name: /Järgmine/ })).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
  });

  test("newsletter: the subscribers and the CSV downloads (formula cells defused)", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/uudiskiri");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Uudiskirja tellijad");
    const ok = page.locator("tr", { hasText: f.subscribers.confirmed });
    const waiting = page.locator("tr", { hasText: f.subscribers.pending });
    await expect(ok).toBeVisible();
    await expect(waiting).toContainText("Ootab kinnitust");
    expect(await noOverflow(page)).toBe(true);

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Lae alla kõik (CSV)" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^mslab-uudiskiri-\d{4}-\d{2}-\d{2}\.csv$/);
    const all = readFileSync((await download.path())!, "utf8");
    expect(all.startsWith("\uFEFFE-post,Keel,Nõusolek,Kinnitatud,Kinnitamise aeg\r\n")).toBe(true);
    expect(all).toContain(`${f.subscribers.confirmed},ET,`);
    expect(all).toContain(`${f.subscribers.pending},'=1+1,`); // a formula-like cell gets an apostrophe

    const confirmed = await page.request.get("/api/admin/subscribers.csv?kinnitatud=1");
    expect(confirmed.status()).toBe(200);
    expect(confirmed.headers()["content-type"]).toContain("text/csv");
    expect(confirmed.headers()["cache-control"]).toContain("no-store");
    expect(confirmed.headers()["content-disposition"]).toMatch(/^attachment; filename="mslab-uudiskiri-kinnitatud-\d{4}-\d{2}-\d{2}\.csv"$/);
    const body = await confirmed.text();
    expect(body).toContain(f.subscribers.confirmed);
    expect(body).not.toContain(f.subscribers.pending);
  });

  // „Kampaaniad“ (newsletter campaigns, Task 4): the editor with the live preview of both languages, saved. Its sends („Saada proov“, „Saada kõigile“;
  // the 20.10 design) are there and wait for a save; the run presses neither and sends no mail (tests/local-secrets.ts LOCAL_ENV has no RESEND_API_KEY).
  test("newsletter campaigns: a new campaign, the preview of the real mail in both languages, saved; its sends wait for the save", async ({ page, context, visitorIp }, info) => {
    const name = `${E2E_CAMPAIGN_PREFIX} ${info.project.name} ${Date.now()}`;
    // the mail's logo and links hang on the server's SITE_URL (the dev server's own address, or the production build's: headers.spec.ts)
    const site = PROD_BUILD ? PROD_ENV.SITE_URL : DEV_ENV.SITE_URL;
    try {
      await signIn(page, context, visitorIp);
      await page.goto("/admin/uudiskiri");
      await page.locator("[data-newsletter-views]").getByRole("link", { name: "Kampaaniad" }).click();
      await expect(page).toHaveURL(/\/admin\/uudiskiri\?vaade=kampaaniad$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kampaaniad");
      await page.locator("[data-campaign-new]").click();
      await expect(page).toHaveURL(/kampaania=uus$/);
      const form = page.locator("[data-campaign-form]");
      await expect(form).toHaveAttribute("data-campaign-form", "new");

      await form.locator('[data-field="name"]').fill(name);
      await form.locator('[data-i18n="subject"]').fill("E2E teema");
      await form.locator('[data-i18n="body"]').fill("E2E esimene lõik.\n\nE2E teine lõik.");
      await form.locator('[data-field="code"]').fill("e2e-kood");
      await form.locator('[data-i18n="buttonLabel"]').fill("Vaata koolitusi");
      await form.locator('[data-field="buttonHref"]').fill("/koolitused");
      await expect(form.locator('[data-campaign-count="subject"]')).toHaveText("ET 9 / 150 · RU 0 / 150");

      // the Estonian preview: the real mail, its links on SITE_URL, the unsubscribe link the test page's
      const et = page.frameLocator('[data-campaign-preview-frame="et"]');
      await expect(et.getByText("E2E teine lõik.")).toBeVisible();
      await expect(et.getByText("E2E-KOOD")).toBeVisible();
      await expect(et.locator('img[alt="MS LAB"]')).toHaveAttribute("src", `${site}/brand/logo.png`);
      await expect(et.getByRole("link", { name: "Vaata koolitusi" }).first()).toHaveAttribute("href", `${site}/koolitused`);
      await expect(et.getByRole("link", { name: "Loobu uudiskirjast" })).toHaveAttribute("href", `${site}/api/newsletter/loobu?proov=1`);
      await expect(page.locator("[data-campaign-preview-subject]")).toHaveText("E2E teema");

      // the Russian preview without a Russian text: the Estonian text under the Russian footer, and it says so
      const preview = page.locator("[data-campaign-preview]");
      await preview.locator('[data-lang="ru"]').click();
      await expect(page.locator("[data-campaign-preview-fallback]")).toHaveText("Vene keeles tellijad saavad eestikeelse kirja.");
      const ru = page.frameLocator('[data-campaign-preview-frame="ru"]');
      await expect(ru.getByText("E2E teine lõik.")).toBeVisible();
      await expect(ru.getByText("Отписаться от рассылки")).toBeVisible();

      // with its Russian texts (the page's switch: every field of the editor in Russian): the Russian preview follows the typing
      await editLang(page, "ru");
      for (const [key, value] of [
        ["subject", "E2E тема"],
        ["body", "E2E русский абзац."],
        ["buttonLabel", "Смотреть курсы"],
      ] as const) {
        await form.locator(`[data-i18n="${key}"]`).fill(value);
      }
      await expect(ru.getByText("E2E русский абзац.")).toBeVisible();
      await expect(page.locator("[data-campaign-preview-fallback]")).toHaveCount(0);
      await expect(page.locator("[data-campaign-preview-subject]")).toHaveText("E2E тема");

      // the sends are closed until the campaign is saved
      await expect(page.locator("[data-campaign-save-first]")).toHaveText("Salvesta muudatused enne saatmist.");
      await expect(page.locator("[data-test-send]")).toHaveAttribute("aria-disabled", "true");
      await expect(page.locator("[data-send-all]")).toHaveAttribute("aria-disabled", "true");
      await page.getByRole("button", { name: "Salvesta" }).click();
      await expect(page).toHaveURL(/kampaania=\d+$/);
      await expect(page.locator("[data-save-status]")).toHaveText("Salvestatud.");
      const [row] = await storedCampaigns(name);
      expect(row).toMatchObject({ status: "draft", code: "E2E-KOOD", subject: { et: "E2E teema", ru: "E2E тема" }, body: { et: "E2E esimene lõik.\n\nE2E teine lõik.", ru: "E2E русский абзац." } });
      await expect(form).toHaveAttribute("data-campaign-form", String(row.id));
      await expect(page.locator(`[data-campaign-row="${row.id}"] [data-campaign-status]`)).toHaveText("Mustand");
      // saved: both are open; nothing was pressed, so it is still a draft
      await expect(page.locator("[data-campaign-save-first]")).toHaveCount(0);
      await expect(page.locator("[data-test-send]")).not.toHaveAttribute("aria-disabled", "true");
      await expect(page.locator("[data-send-all]")).not.toHaveAttribute("aria-disabled", "true");
      await expect(page.locator("[data-send-confirm]")).toHaveCount(0);
      expect((await storedCampaigns(name))[0].status).toBe("draft");

      // opened again: the stored fields
      await page.reload();
      await expect(form.locator('[data-field="name"]')).toHaveValue(name);
      await expect(form.locator('[data-field="code"]')).toHaveValue("E2E-KOOD");
      expect(await noOverflow(page)).toBe(true);
      // (the picture's file input is pressed through its label, as in admin-site.spec.ts's phone check)
      if (info.project.name === "mobile") {
        expect((await smallTargets(page.locator("main"))).filter((html) => !LABELLED.test(html))).toEqual([]);
        expect(await smallPills(page.locator("main"))).toEqual([]); // (the radios of „Saada proov“: their labels are the targets)
      }
    } finally {
      expect(await removeCampaignRows(name)).toBe(0);
    }
  });

  test("phone: the sidebar is a top bar with a menu panel (Esc closes it)", async ({ page, context, visitorIp, isMobile }) => {
    await signIn(page, context, visitorIp);
    const button = page.getByRole("button", { name: "Ava menüü" });
    if (!isMobile) {
      await expect(button).toBeHidden();
      await expect(page.locator("aside").getByRole("navigation", { name: "Halduse menüü" })).toBeVisible();
      return;
    }
    await expect(page.locator("aside")).toBeHidden();
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    const drawer = page.locator("[data-admin-drawer]");
    await expect(drawer).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(drawer.getByRole("link", { name: /^Registreerimised/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    await drawer.getByRole("button", { name: "Sulge menüü" }).click();
    await expect(drawer).toBeHidden();
    await button.click();
    await drawer.getByRole("link", { name: /^Päringud/ }).click();
    await expect(page).toHaveURL(/\/admin\/paringud$/);
    await expect(drawer).toBeHidden();
    // the bar names the page it is on (the overview shows the logo instead)
    await expect(page.locator("header [data-admin-bar-title]")).toHaveText("Päringud");
    expect(await noOverflow(page)).toBe(true);
  });
});

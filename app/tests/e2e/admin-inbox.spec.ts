import { readFileSync } from "node:fs";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { submitsForms, test, expect } from "./test";
import { adminReady, editLang, signInAsAdmin } from "./admin-login";
import { formatDayMonth } from "../../src/i18n/format";
import { expectFits, openRow, today } from "./invoices";
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
 * „Koosta kviitung“ unticked when the „Lisa laekumine“ panel offers it (this database's Seaded → Arve andmed may have a seller): these tests record
 * money only, and make no invoice (the receipt's path is admin-invoices.spec.ts, which holds the invoice settings).
 */
async function noReceipt(panel: Locator): Promise<void> {
  const box = panel.locator("[data-receipt]");
  if ((await box.count()) > 0) await box.uncheck();
}

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

  test("overview: greeting, „Sinu järjekord“, the B menu with badges", async ({ page, context, visitorIp, isMobile }, info) => {
    await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tere, Dim.");
    await expect(page).toHaveTitle(/Ülevaade — Haldus/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    // „Sinu järjekord“ (A1): a row for each thing to do, each to its list; this test's registration and its five open requests are among them
    const queue = page.locator("[data-overview-queue]");
    await expect(queue.getByRole("heading", { name: "Sinu järjekord" })).toBeVisible();
    const awaiting = queue.locator('[data-overview-row="awaiting"]');
    await expect(awaiting).toContainText("Ootab ettemaksu");
    await expect(awaiting).toHaveAttribute("href", "/admin/registreerimised?staatus=ootab");
    expect(Number(await awaiting.locator("strong").textContent())).toBeGreaterThanOrEqual(1);
    const requests = queue.locator('[data-overview-row="requests"]');
    await expect(requests).toContainText("Päringut tegemata");
    await expect(requests).toHaveAttribute("href", "/admin/paringud");
    expect(Number(await requests.locator("strong").textContent())).toBeGreaterThanOrEqual(5);
    // gone: the four tiles, the Päringud card, Kiirlingid (the site link is the top line's) and the button to the registrations
    for (const gone of ["[data-stat]", "[data-inbox]", "[data-overview-assessment]", 'section[aria-labelledby="links-title"]']) await expect(page.locator(gone)).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Vaata registreerimisi/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Lae alla kinnitatud tellijad/ })).toHaveCount(0);
    await expect(page.locator("[data-overview-upcoming]")).toContainText(/järgmise 30 päeva jooksul: \d+/);
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

  test("overview: a row of „Tulevased koolitused“ opens that session's Kalender drawer", async ({ page, context, visitorIp }) => {
    await signIn(page, context, visitorIp);
    const rows = page.locator("[data-overview-upcoming] [data-upcoming-session]");
    expect(await rows.count()).toBeLessThanOrEqual(5);
    const first = rows.first(); // (the sample sessions are scheduled from today on at the start of every run)
    const id = await first.getAttribute("data-upcoming-session");
    await expect(first).toHaveAttribute("href", `/admin/kalender?id=${id}`);
    await first.click();
    await expect(page).toHaveURL(new RegExp(`/admin/kalender\\?id=${id}$`));
    await expect(page.locator("[data-drawer]")).toBeVisible();
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

    // the drawer (README A2 drawer 1–2): the header, then Raha at 0 of 350 €, the place confirmed from 175 €
    await row.getByRole("link", { name: `Ava ${f.registration.name}` }).click();
    await expect(page).toHaveURL(new RegExp(`vorm=k&id=${f.registration.id}$`));
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    await expect(drawer).toBeVisible();
    await adminReady(page);
    // a contact course's registration: one tap to its protocol (phase protocols)
    await expect(drawer.locator("[data-registration-protocol]")).toHaveText("Ava protokoll");
    await expect(drawer.locator("[data-registration-protocol]")).toHaveAttribute("href", `/admin/protokollid?registreering=${f.registration.id}`);
    await expect(drawer.locator("[data-registration-line]")).toHaveText(/ · \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} · Pärnu, E2E saal · Grupp$/);
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");
    const card = drawer.locator("[data-money-card]");
    await expect(card.locator("[data-paid]")).toHaveText("0 €");
    await expect(card.locator("[data-money-total]")).toHaveText("/ 350 € laekunud");
    await expect(card.locator("[data-money-choice]")).toHaveText("Valitud: ettemaks 50%");
    await expect(card.locator("[data-money-seat]")).toHaveText("Koht kinnitub 175 € juures · vabu kohti 4 / 4");

    // „Lisa laekumine“ (B4): the panel opens in place of the button, the 50 % preselected
    const add = card.locator("[data-add-payment]");
    const panel = card.locator("[data-add-payment-panel]");
    const submit = panel.locator("[data-add-payment-submit]");
    const other = panel.locator("[data-other-amount]");
    await add.click();
    await expect(panel.getByRole("radio", { name: "175 € · ettemaks" })).toBeChecked();
    await expect(panel.getByRole("radio", { name: "350 € · kogu summa" })).not.toBeChecked();
    await expect(submit).toHaveText("Lisa 175 € · koht kinnitub");
    await expect(panel.locator("[data-paid-date]")).toHaveValue(today());
    await expect(panel.getByRole("radio", { name: "Pangaülekanne" })).toBeChecked();
    // „Muu summa“ that is no amount, then more than is left: the field says so, nothing stored
    await panel.getByRole("radio", { name: "Muu summa" }).check();
    await other.fill("palju");
    await submit.click();
    await expect(panel.locator("[data-other-amount-error]")).toHaveText("Sisesta summa eurodes, näiteks 175 või 175,50.");
    await expect(other).toHaveAttribute("aria-invalid", "true");
    await other.fill("400");
    await submit.click();
    await expect(panel.locator("[data-other-amount-error]")).toHaveText("Summa on suurem kui tasumata osa (350 €).");
    expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 0, status: "awaiting_prepayment" });
    // below 50 %: added, stays awaiting (S3-b; no receipt here: the receipt's path is admin-invoices.spec.ts)
    await other.fill("174,99");
    await expect(submit).toHaveText("Lisa 174,99 €");
    await noReceipt(panel);
    await submit.click();
    await expect(card.locator("[data-add-payment-result]")).toHaveText("174,99 € lisatud. Koht kinnitub 175 € juures.");
    await expect(panel).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(card.locator("[data-paid]")).toHaveText("174,99 €");
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");
    expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 17499, status: "awaiting_prepayment" });
    // 50 %: the missing cent is preselected, the submit says the place confirms, and it does
    await add.click();
    await expect(panel.getByRole("radio", { name: "0,01 € · ettemaks" })).toBeChecked();
    await expect(panel.getByRole("radio", { name: "175,01 € · ülejäänud summa" })).not.toBeChecked();
    await expect(submit).toHaveText("Lisa 0,01 € · koht kinnitub");
    await noReceipt(panel);
    await submit.click();
    await expect(card.locator("[data-add-payment-result]")).toHaveText("0,01 € lisatud · koht kinnitatud.");
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Kinnitatud");
    await expect(card.locator("[data-paid]")).toHaveText("175 €");
    expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ paidCents: 17500, status: "confirmed" });
    // the status pills follow the new status
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

  test("registrations: the status pills save at once, the note autosaves (its SaveStatus in the header), then 'Tühista'", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/registreerimised?id=${f.registration.id}`);
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    await expect(drawer).toBeVisible();
    await adminReady(page);
    const part = drawer.locator("[data-status-form]");
    await expect(part.getByRole("heading", { level: 3 })).toHaveText("Staatus ja märkus");
    await expect(part.getByRole("button", { name: "Salvesta staatus" })).toHaveCount(0);
    await expect(part.getByText("Näeb ainult haldus.")).toBeVisible();
    // a pill is a manual override, saved at once: the header's pill follows
    await part.getByRole("radio", { name: "Kinnitatud" }).check();
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Kinnitatud");
    await expect.poll(async () => (await storedAdminRegistration(f.registration.id)).status).toBe("confirmed");
    // the note saves itself; the header's chip says when
    const chip = drawer.locator("header [data-save-status]");
    await drawer.getByRole("textbox", { name: "Märkus" }).fill("Maksis kohapeal sularahas");
    await expect(chip.locator("[data-save-text]")).toHaveText(/^✓ Salvestatud \d\d:\d\d$/, { timeout: 20_000 });
    expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ status: "confirmed", note: "Maksis kohapeal sularahas", paidCents: 0 });
    // and the next status press does not touch it
    await expect(part.locator("[data-status-choice]")).not.toHaveAttribute("aria-busy", "true");
    await part.getByRole("radio", { name: "Ootab ettemaksu" }).check();
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");
    await expect.poll(async () => (await storedAdminRegistration(f.registration.id)).status).toBe("awaiting_prepayment");
    expect((await storedAdminRegistration(f.registration.id)).note).toBe("Maksis kohapeal sularahas");

    await drawer.getByRole("button", { name: "Tühista registreerimine" }).click();
    await drawer.getByRole("button", { name: "Jah, tühista", exact: true }).click(); // (B10: it asks first)
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Tühistatud");
    await expect(drawer.locator("[data-cancelled]")).toBeFocused();
    expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ status: "cancelled", note: "Maksis kohapeal sularahas" });
    // a cancelled registration takes no money from the drawer and is not put back by the pills (spec §10)
    await expect(drawer.locator("[data-add-payment]")).toHaveCount(0);
    for (const name of ["Ootab ettemaksu", "Kinnitatud"]) {
      await expect(part.getByRole("radio", { name })).toBeDisabled();
      await expect(part.getByRole("radio", { name })).not.toBeChecked();
    }

    await drawer.getByRole("button", { name: "Sulge" }).click();
    await expect(drawer).toBeHidden();
    await expect(page.locator(`[data-registration="${f.registration.id}"] [data-reg-status]`)).toHaveText("Tühistatud");
  });

  test("registrations: „Tühista registreerimine“ asks first (B10): the question with her name, the lines that are true, „Katkesta“ and Esc leave it, „Jah, tühista“ cancels and frees the seat", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    // a confirmed place with 175 € received: the seat line and the money line are both true (no invoice: the money line says so)
    await onLocalDb((sql) => sql`update registrations set status = 'confirmed', paid_cents = 17500 where id = ${f.registration.id}`, { marksPages: false });
    const [{ startsAt }] = await onLocalDb((sql) => sql<{ startsAt: Date }[]>`select starts_at as "startsAt" from course_sessions where id = ${f.session.id}`, { marksPages: false });
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/registreerimised?id=${f.registration.id}`);
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    await expect(drawer).toBeVisible();
    await adminReady(page);
    const button = drawer.getByRole("button", { name: "Tühista registreerimine" });
    const ask = drawer.locator("[data-confirm-panel]");
    const seats = async () => (await onLocalDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from registrations where course_session_id = ${f.session.id} and status = 'confirmed'`, { marksPages: false }))[0].n;
    expect(await seats()).toBe(1);

    // the button asks: the panel takes its place and the focus, and nothing is cancelled yet
    await button.click();
    await expect(button).toHaveCount(0);
    await expect(ask).toBeFocused();
    await expect(ask.locator("> p")).toHaveText(`Kas tühistan registreerimise: ${f.registration.name}?`);
    await expect(ask.locator("li")).toHaveText([
      `Koht ${formatDayMonth(startsAt, "et")} Pärnu koolitusel vabaneb kohe avalikus kalendris.`,
      "Laekunud 175 € jääb alles.",
      "Õpilasele kirja ei saadeta.",
    ]);
    await expect(ask.getByRole("button")).toHaveText(["Jah, tühista", "Katkesta"]);
    expect((await storedAdminRegistration(f.registration.id)).status).toBe("confirmed");

    // „Katkesta“ and Esc: the question goes, the focus is back on the button, the drawer stays, the registration is as it was
    await ask.getByRole("button", { name: "Katkesta" }).click();
    await expect(ask).toHaveCount(0);
    await expect(button).toBeFocused();
    await button.click();
    await expect(ask).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(button).toBeFocused();
    expect((await storedAdminRegistration(f.registration.id)).status).toBe("confirmed");
    expect(await seats()).toBe(1);

    // „Jah, tühista“: today's line takes the focus, the registration is cancelled with its money kept, and the seat is free
    await button.click();
    await ask.getByRole("button", { name: "Jah, tühista" }).click();
    await expect(drawer.locator("[data-cancelled]")).toHaveText("Registreerimine on tühistatud.");
    await expect(drawer.locator("[data-cancelled]")).toBeFocused();
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Tühistatud");
    expect(await storedAdminRegistration(f.registration.id)).toMatchObject({ status: "cancelled", paidCents: 17500 });
    expect(await seats()).toBe(0);
    expect(await noOverflow(page)).toBe(true);
  });

  test("registrations: a status press built on an old status does not overwrite the change made meanwhile", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/registreerimised?vorm=k&id=${f.registration.id}`);
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");
    await adminReady(page);
    const stale = "Staatus muutus vahepeal (näed nüüd kehtivat). Vaata üle ja salvesta uuesti.";
    // Maria cancelled it in another tab: the press is refused, the drawer now shows the stored status, and the cancelled one stays cancelled
    await setStoredStatus(f.registration.id, "cancelled");
    await drawer.getByRole("radio", { name: "Kinnitatud" }).click();
    await expect(drawer.locator("[data-status-line]")).toHaveText(stale);
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Tühistatud");
    await expect(drawer.getByRole("radio", { name: "Kinnitatud" })).not.toBeChecked();
    await expect(drawer.getByRole("radio", { name: "Kinnitatud" })).toBeDisabled();
    expect((await storedAdminRegistration(f.registration.id)).status).toBe("cancelled");
    // a payment confirmed it meanwhile: a press that still saw „Ootab ettemaksu“ is refused too; once it shows „Kinnitatud“, a change goes through
    await setStoredStatus(f.registration.id, "awaiting_prepayment");
    await page.reload();
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");
    await adminReady(page);
    await setStoredStatus(f.registration.id, "confirmed");
    await drawer.getByRole("radio", { name: "Kinnitatud" }).click();
    await expect(drawer.locator("[data-status-line]")).toHaveText(stale);
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Kinnitatud");
    await expect(drawer.getByRole("radio", { name: "Kinnitatud" })).toBeChecked();
    await expect(drawer.locator("[data-status-choice]")).not.toHaveAttribute("aria-busy", "true"); // (the refused press and its refresh are done)
    await drawer.getByRole("radio", { name: "Ootab ettemaksu" }).check();
    await expect(drawer.locator("[data-reg-status]")).toHaveText("Ootab ettemaksu");
    await expect(drawer.locator("[data-status-line]")).toHaveText("");
    await expect.poll(async () => (await storedAdminRegistration(f.registration.id)).status).toBe("awaiting_prepayment");
  });

  test("registrations drawer at 375 × 812: the first screen holds the header, Raha's „Lisa laekumine“ and the status pills; the open panel never scrolls sideways", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(!isMobile, "the phone project only");
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/admin/registreerimised?id=${f.registration.id}`);
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    await expect(drawer).toBeVisible();
    await adminReady(page);
    // the phone drawer's first screen (README A2): the header, Raha with only its button, and the status, without scrolling
    for (const [what, el] of [
      ["the name", drawer.locator("header h2")],
      ["„Lisa laekumine“", drawer.locator("[data-add-payment]")],
      ["the status pills", drawer.locator("[data-status-choice]")],
    ] as const) {
      const box = (await el.boundingBox())!;
      expect(box.y + box.height, what).toBeLessThanOrEqual(812);
    }
    await expect(drawer.locator("[data-add-payment-panel]")).toHaveCount(0);
    // the button is the card's width on a phone
    const card = drawer.locator("[data-money-card]");
    const [button, cardBox] = [(await drawer.locator("[data-add-payment]").boundingBox())!, (await card.boundingBox())!];
    expect(button.width).toBeGreaterThan(cardBox.width - 40);
    // the panel open, with „Muu summa“ and its field: nothing scrolls sideways, every control a 44 px target
    await drawer.locator("[data-add-payment]").click();
    const panel = card.locator("[data-add-payment-panel]");
    await panel.getByRole("radio", { name: "Muu summa" }).check();
    await expect(panel.locator("[data-other-amount]")).toBeVisible();
    await expectFits(page, card, "the Raha card with „Lisa laekumine“ open");
    expect(await drawer.evaluate((d) => d.scrollWidth <= d.clientWidth + 1), "the drawer scrolls sideways").toBe(true);
    // a refusal's words and a long „Muu summa“ error wrap inside it too
    await panel.locator("[data-other-amount]").fill("99999");
    await panel.locator("[data-add-payment-submit]").click();
    await expect(panel.locator("[data-other-amount-error]")).toHaveText("Summa on suurem kui tasumata osa (350 €).");
    expect(await drawer.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
    expect(await noOverflow(page)).toBe(true);
  });

  test("registrations: a note typed offline holds the drawer — ✕, Back, a menu click and a link each ask first (the leave guard, ledger L136)", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(isMobile, "the desktop project: the menu is beside the drawer there");
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/registreerimised?vorm=k");
    await adminReady(page);
    // opened from the list, so Back would close it
    await page.locator(`[data-registration="${f.registration.id}"]`).getByRole("link", { name: `Ava ${f.registration.name}` }).click();
    await expect(page).toHaveURL(new RegExp(`id=${f.registration.id}$`));
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    await expect(drawer).toBeVisible();
    const note = drawer.getByRole("textbox", { name: "Märkus" });
    const chip = drawer.locator("header [data-save-status]");
    const notice = drawer.locator('[data-leave-notice="drawer"]');
    /** The guard asked instead of leaving: its notice names „Märkus“ and the reason; „Jää siia“ puts her back in the note, with her text. */
    const asks = async (what: string) => {
      await expect(notice, what).toBeVisible();
      await expect(notice.locator("[data-leave-title]")).toHaveText("Muudatust „Märkus“ ei saanud veel salvestada.");
      await expect(notice.locator("[data-leave-reason]")).toHaveText("Ühendus puudub. Proovin uuesti, kuni jääd siia.");
      await expect(drawer, what).toBeVisible();
      await expect(page, what).toHaveURL(new RegExp(`/admin/registreerimised[?]vorm=k&id=${f.registration.id}$`));
      await notice.getByRole("button", { name: "Jää siia" }).click();
      await expect(notice).toHaveCount(0);
      await expect(note, what).toBeFocused();
      await expect(note).toHaveValue("Helistab reedel");
    };
    await context.setOffline(true);
    try {
      await note.fill("Helistab reedel");
      await expect(chip).toHaveAttribute("data-save-kind", "retry", { timeout: 20_000 });
      await drawer.getByRole("button", { name: "Sulge", exact: true }).click();
      await asks("the drawer's ✕");
      await page.evaluate(() => history.back());
      await asks("Back");
      // the menu beside the drawer: the drawer's backdrop takes the click
      const menuLink = (await page.locator('aside [data-nav="overview"]').boundingBox())!;
      await page.mouse.click(menuLink.x + menuLink.width / 2, menuLink.y + menuLink.height / 2);
      await asks("a click on the menu");
      await drawer.locator("[data-registration-protocol]").click();
      await asks("a link to another page");
    } finally {
      await context.setOffline(false);
    }
    // back online: the note goes, and ✕ closes at once
    await expect(chip.locator("[data-save-text]")).toHaveText(/^✓ Salvestatud \d\d:\d\d$/, { timeout: 40_000 });
    expect((await storedAdminRegistration(f.registration.id)).note).toBe("Helistab reedel");
    await drawer.getByRole("button", { name: "Sulge", exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/\/admin\/registreerimised\?vorm=k$/);
  });

  test("payments: Maksed after Registreerimised — newest first, Maria's words, 'Kontrolli Montonios', the filter", async ({ page, context, visitorIp, isMobile }, info) => {
    const f = await fixtures(info.project.name);
    const p = await insertAdminPayments(f);
    await signIn(page, context, visitorIp);
    await (await menu(page, isMobile)).getByRole("link", { name: /^Maksed ja arved/ }).click(); // (its badge, when there is one, is part of the name)
    await expect(page).toHaveURL(/\/admin\/maksed$/);
    if (isMobile) await expect(page.locator("[data-admin-drawer]")).toBeHidden(); // the link closed the drawer
    await expect(page).toHaveTitle(/Maksed ja arved — Haldus/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Maksed ja arved");
    await expect(page.locator("aside [data-nav='payments']")).toHaveAttribute("aria-current", "page"); // (a phone has it in the menu drawer)
    await expect(page.getByText("Veebimaksed Montonio kaudu, uuemad eespool. Tagastused tehakse Montonio halduses;")).toBeVisible();
    await expect(page.getByText("töölaual")).toHaveCount(0);
    // the tabs Maksed | Arved (A6): Maksed is the current one; the old header button is gone
    const tabs = page.getByRole("navigation", { name: "Maksed ja arved" });
    await expect(tabs.getByRole("link")).toHaveText(["Maksed", "Arved"]);
    await expect(tabs.getByRole("link", { name: "Maksed" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("[data-payments-invoices]")).toHaveCount(0);

    const row = (reference: string) => page.locator(`[data-payment="${reference}"]`);
    const cell = (reference: string, label: string) => row(reference).locator(`[data-label="${label}"]`);
    // newest first: the e-course purchase, the pending one, the voided one, the held one, the paid one (other tests' payments may lie between)
    const shown = await page.locator("tr[data-payment]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-payment")));
    const mine = [p.ecourse, p.pending, p.voided, p.held, p.paid];
    expect(shown.filter((ref) => mine.includes(ref!))).toEqual(mine);

    // Eest (the kind under the course) / Summa (the method, in Maria's Estonian and never Montonio's code, under the amount)
    await expect(cell(p.paid, "Maksja")).toContainText(f.registration.name);
    // (the e-mail is a mail link; the phone card leaves it out — it is in the drawer — so it is looked for by its address, not as a visible link)
    await expect(cell(p.paid, "Maksja").locator('a[href^="mailto:"]')).toHaveAttribute("href", `mailto:${f.registration.email}`);
    await expect(cell(p.paid, "Maksja").locator('a[href^="mailto:"]')).toBeVisible({ visible: !isMobile });
    await expect(cell(p.paid, "Eest")).toContainText(f.course.title);
    await expect(row(p.paid).locator("[data-payment-kind]")).toHaveText("Ettemaks");
    await expect(cell(p.paid, "Summa")).toContainText("175 €");
    const method = (ref: string) => row(ref).locator("[data-payment-method]");
    await expect(method(p.paid)).toHaveText("Pangalink · Swedbank");
    await expect(method(p.held)).toHaveText("Kaart");
    await expect(method(p.voided)).toHaveText("Pangalink · LHV");
    await expect(method(p.ecourse)).toHaveText("Apple Pay");
    await expect(method(p.pending)).toHaveCount(0);
    await expect(cell(p.ecourse, "Eest")).toContainText("Kulmumeistri e-koolitus");
    await expect(row(p.ecourse).locator("[data-payment-kind]")).toHaveText("E-koolitus");
    await expect(row(p.held).locator("[data-payment-kind]")).toHaveText("Ülejäänud");
    // the row leads to the registration's drawer (the e-course stand-in has neither a registration nor a student: no link)
    await expect(cell(p.paid, "Maksja").getByRole("link", { name: `Ava ${f.registration.name}` })).toHaveAttribute("href", `/admin/registreerimised?id=${f.registration.id}`);
    await expect(cell(p.ecourse, "Maksja").getByRole("link", { name: /^Ava / })).toHaveCount(0);
    // the Montonio id is „Montonios ↗“, not text
    await expect(cell(p.paid, "Montonio id").locator("[data-montonio-link]")).toHaveText("Montonios ↗");
    await expect(page.locator("main")).not.toContainText(/paymentInitiation|cardPayments|applePay/);

    // statuses in Estonian; "Kontrolli Montonios" on the held and the voided row only, with a tinted row (and a 3 px left border on a phone)
    await expect(cell(p.paid, "Staatus")).toHaveText("Makstud");
    await expect(cell(p.pending, "Staatus")).toHaveText("Pooleli");
    await expect(cell(p.held, "Staatus")).toContainText("Ootel kontrollil");
    await expect(cell(p.voided, "Staatus")).toContainText("Tühistatud pangas");
    for (const ref of [p.held, p.voided]) await expect(row(ref).locator("[data-payment-check]")).toHaveText("Kontrolli Montonios");
    for (const ref of [p.paid, p.pending, p.ecourse]) await expect(row(ref).locator("[data-payment-check]")).toHaveCount(0);
    // (on a phone the card is tinted, on a laptop its cells are)
    const tint = (ref: string) => row(ref).evaluate((tr) => [tr, ...Array.from(tr.querySelectorAll("td"))].some((e) => getComputedStyle(e).backgroundColor !== "rgba(0, 0, 0, 0)"));
    expect(await tint(p.held)).toBe(true);
    expect(await tint(p.voided)).toBe(true);
    expect(await cell(p.paid, "Staatus").evaluate((td) => getComputedStyle(td).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    const border = (ref: string) => row(ref).evaluate((tr) => `${getComputedStyle(tr).borderLeftWidth} ${getComputedStyle(tr).borderLeftColor}`);
    if (isMobile) {
      expect(await border(p.held)).toBe("3px rgb(158, 137, 147)"); // #9e8993
      expect(await border(p.voided)).toBe("3px rgb(158, 137, 147)");
      expect(await border(p.paid)).toBe("3px rgba(0, 0, 0, 0)"); // (every card has the border; only these two show it)
      expect(await border(p.pending)).toBe("3px rgba(0, 0, 0, 0)");
      // the phone card: the name and the sum, then "{day} · {course} · {way}", the status and where the row leads
      await expect(row(p.paid).locator("[data-payment-meta]")).toContainText(`${f.course.title} · Pangalink · Swedbank`);
      await expect(row(p.paid)).toContainText("Ava registreering →");
    }

    expect(await noOverflow(page)).toBe(true);
    expect(await smallTargets(page.locator("main"))).toEqual([]);
    if (!isMobile) {
      await page.setViewportSize({ width: 834, height: 1112 }); // a tablet: between the phone and the desktop
      expect(await noOverflow(page)).toBe(true);
      expect(await smallTargets(page.locator("main"))).toEqual([]);
      await page.setViewportSize({ width: 1440, height: 900 });
    }

    // the pills with their counts (Kõik first, each its own address): Kõik / Makstud / Pooleli / Ebaõnnestunud / Tagastatud / Ootel kontrollil
    const filter = page.locator("[data-list-pill-row]");
    await expect(filter.getByRole("link")).toHaveText([/^Kõik\d+$/, /^Makstud\d+$/, /^Pooleli\d+$/, /^Ebaõnnestunud\d+$/, /^Tagastatud\d+$/, /^Ootel kontrollil\d+$/]);
    await expect(filter.getByRole("link", { name: /^Kõik/ })).toHaveAttribute("aria-current", "true");
    await filter.getByRole("link", { name: /^Ootel kontrollil/ }).click();
    await expect(page).toHaveURL(/\?staatus=kontroll$/);
    await expect(filter.getByRole("link", { name: /^Ootel kontrollil/ })).toHaveAttribute("aria-current", "true");
    await expect(row(p.held)).toBeVisible();
    await expect(row(p.voided)).toBeVisible(); // B14: the bank's reversal after it was paid is counted with the ones to check in Montonio
    await expect(row(p.paid)).toHaveCount(0);
    await filter.getByRole("link", { name: /^Ebaõnnestunud/ }).click();
    await expect(page).toHaveURL(/\?staatus=ebaonnestunud$/);
    await expect(row(p.voided)).toHaveCount(0); // (it is no longer a plain failure)
    await expect(row(p.held)).toHaveCount(0);
    await page.goto("/admin/maksed?staatus=makstud");
    await expect(row(p.paid)).toBeVisible();
    await expect(row(p.ecourse)).toBeVisible();
    await expect(row(p.pending)).toHaveCount(0);
    await page.goto("/admin/maksed?staatus=midagi&leht=zzz"); // not a status, not a page: everything, page 1
    await expect(row(p.paid)).toBeVisible();
  });

  test("payments: the Maksed phone card at 375 × 812 — a held row with its reason and a very long name, the copied line: no sideways scroll, every target 44 px, everything inside the screen", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(!isMobile, "the phone project only");
    const f = await fixtures(info.project.name);
    const p = await insertAdminPayments(f);
    // the worst row there is: held with a check reason (two tags: „Ootel kontrollil“ and „Topeltmakse — tagasta“), a name of 45 letters with no place to break
    const longName = "Pneumonoultramicroscopicsilicovolcanoconiosis";
    await onLocalDb((sql) => sql`update payments set check_reason = 'double', name = ${longName} where reference = ${p.held}`, { marksPages: false });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await context.route("https://sandbox-partner.montonio.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Partner</title><p>Partner System</p>" }));
    await signIn(page, context, visitorIp);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/admin/maksed?otsi=${encodeURIComponent(f.registration.email)}`);
    await adminReady(page);
    const row = (reference: string) => page.locator(`tr[data-payment="${reference}"]`);
    await expect(row(p.held)).toBeVisible();
    await expect(row(p.held).locator("[data-payment-check]")).toHaveText("Topeltmakse — tagasta");
    await expect(row(p.held)).toContainText(longName.slice(0, 12));
    await expect(row(p.voided).locator("[data-payment-check]")).toHaveText("Kontrolli Montonios");
    // every part of every card lies inside the 375 px screen, and nothing makes the page wider
    const outside = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("tr[data-payment] *"))
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && (r.left < -0.5 || r.right > window.innerWidth + 0.5))
          .map(({ e }) => e.outerHTML.slice(0, 100)),
      );
    expect(await outside()).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    expect(await smallTargets(page.locator("main"))).toEqual([]);
    // the card keeps its parts in the card (the sum at the right, the tags and the hint under the line)
    const card = (await row(p.held).boundingBox())!;
    for (const selector of ["[data-payment-meta]", "[data-payment-check]", "[data-montonio-link]"]) {
      const b = (await row(p.held).locator(selector).first().boundingBox())!;
      expect(b.x, selector).toBeGreaterThanOrEqual(card.x - 1);
      expect(b.x + b.width, selector).toBeLessThanOrEqual(card.x + card.width + 1);
    }
    // „Montonio id kopeeritud.“ appears under the link: still inside, still no scroll, and the target stays 44 px
    const [tab] = await Promise.all([context.waitForEvent("page"), row(p.held).locator("[data-montonio-link]").click()]);
    await tab.close();
    await page.bringToFront();
    await expect(row(p.held).locator("[data-montonio-copied]")).toHaveText("Montonio id kopeeritud.");
    expect(await outside()).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    expect(await smallTargets(page.locator("main"))).toEqual([]);
  });

  test("payments: the registration's drawer lists its online payments in the Raha card; „Lisa laekumine“ adds money beside them", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    const p = await insertAdminPayments(f);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/registreerimised?id=${f.registration.id}`);
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    await expect(drawer).toBeVisible();
    const online = drawer.locator("[data-registration-payments]");
    await expect(drawer.locator("[data-money-card] [data-registration-payments]")).toHaveCount(1); // (in the Raha card, Task 5)
    await expect(online.getByRole("heading", { level: 4 })).toHaveText("Veebimaksed");
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
    // money from outside the site is added with „Lisa laekumine“ beside them (B4: the typed „Laekunud summa“ is gone)
    await adminReady(page);
    const card = drawer.locator("[data-money-card]");
    await card.locator("[data-add-payment]").click();
    const panel = card.locator("[data-add-payment-panel]");
    await expect(panel.getByRole("radio", { name: "175 € · ettemaks" })).toBeChecked();
    await noReceipt(panel);
    await panel.locator("[data-add-payment-submit]").click();
    await expect(card.locator("[data-add-payment-result]")).toHaveText("175 € lisatud · koht kinnitatud.");
    await expect(drawer.locator("[data-paid]")).toHaveText("175 €");
    await expect(online.locator("[data-payment]")).toHaveCount(4);
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

  /** The subject a card's „Vasta e-kirjaga ↗“ fills in, read from its `mailto:` address. */
  const subjectOf = async (reply: Locator) => {
    const href = (await reply.getAttribute("href"))!;
    expect(href.startsWith("mailto:"), href).toBe(true);
    return decodeURIComponent(href.split("?subject=")[1]);
  };

  test("requests: five tabs with their open counts; a card is compact — name, date · language · e-mail, type tag, message, a facts line — and „Vasta e-kirjaga ↗“ fills the subject", async ({ page, context, visitorIp, isMobile }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/paringud");
    await adminReady(page);
    const tabs = page.getByRole("navigation", { name: "Päringu liik" });
    await expect(tabs.getByRole("link")).toHaveText([/^Kontakt/, /^Individuaal/, /^Praktika/, /^Ootenimekiri/, /^Muutmine/]);
    await expect(tabs.getByRole("link", { name: /^Kontakt/ })).toHaveAttribute("aria-current", "true");
    // each tab shows the number of requests still open (this test's own rows are among them; other tests' come and go)
    const count = async (name: RegExp) => Number(await tabs.getByRole("link", { name }).locator("span").textContent());
    expect(await count(/^Kontakt/)).toBeGreaterThanOrEqual(2); // the message and the e-learning interest
    for (const name of [/^Individuaal/, /^Praktika/, /^Ootenimekiri/]) expect(await count(name)).toBeGreaterThanOrEqual(1);
    expect(await noOverflow(page)).toBe(true);
    await tabs.getByRole("link", { name: /^Praktika/ }).click();
    await expect(page).toHaveURL(/\?liik=praktika$/);
    await expect(tabs.getByRole("link", { name: /^Praktika/ })).toHaveAttribute("aria-current", "true");
    await expect(tabs.getByRole("link", { name: /^Kontakt/ })).not.toHaveAttribute("aria-current", "true");

    // this test's five requests, all kinds at once (the search looks in every tab; the tag says which tab a card is from)
    await page.goto(`/admin/paringud?otsi=${f.tag}`);
    const card = (id: number) => page.locator(`[data-request="${id}"]`);
    const WHEN = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/;

    // Kontakt: the message; no facts line for a plain Estonian one; "MS LAB" in the subject, as it names no course
    const contact = card(f.contact.id);
    await expect(contact).toBeVisible();
    await expect(contact.getByRole("heading", { level: 3 })).toHaveText(f.contact.name);
    await expect(contact.locator("[data-request-meta]")).toHaveText(new RegExp(`${WHEN.source} · ET · e2e-admin-contact-.+@example\\.com$`));
    await expect(contact.locator("[data-request-tag]")).toHaveText("Kontakt");
    await expect(contact.locator("[data-request-message]")).toHaveText("Tere! Kas jaanuaris on veel kohti?");
    await expect(contact.locator("[data-request-facts]")).toHaveCount(0);
    expect(await subjectOf(contact.locator("[data-request-reply]"))).toBe("Vastus sinu päringule — MS LAB");

    // the e-learning interest is a Kontakt request, tagged „E-õppe huvi“: named by its address, the course as the message, Russian, left in the cart
    const interest = card(f.interest.id);
    await expect(interest.getByRole("heading", { level: 3 })).toHaveText(f.interest.email);
    await expect(interest.locator("[data-request-tag]")).toHaveText("E-õppe huvi");
    await expect(interest.locator("[data-request-meta]")).toHaveText(new RegExp(`${WHEN.source} · RU$`));
    await expect(interest.locator("[data-request-message]")).toHaveText("Huvi: Kulmumeistri e-koolitus");
    await expect(interest.locator("[data-request-facts]")).toHaveText("Vastus vene keeles · Ostu ei lõpetanud · ostukorvist");
    expect(await subjectOf(interest.locator("[data-request-reply]"))).toMatch(/^Ответ на ваш запрос — .+/);
    await expect(contact.locator("[data-request-tag]")).not.toHaveText("E-õppe huvi");

    // Individuaal: the phone, the course and the wishes ticked, in the facts line; her course in the subject
    const individual = card(f.individual.id);
    await expect(individual.locator("[data-request-tag]")).toHaveText("Individuaal");
    await expect(individual.locator("[data-request-message]")).toHaveCount(0); // (she wrote none)
    await expect(individual.locator("[data-request-facts]")).toHaveText(`+372 5555 0102 · ${f.course.title} · Soovitud periood: Jaanuari teine pool · Soovib kontot`);
    expect(await subjectOf(individual.locator("[data-request-reply]"))).toBe(`Vastus sinu päringule — ${f.course.title}`);

    // Praktika
    const practice = card(f.practice.id);
    await expect(practice.locator("[data-request-tag]")).toHaveText("Praktika");
    await expect(practice.locator("[data-request-facts]")).toHaveText(
      "+372 5555 0103 · Pakett: MINI · Läbitud koolitus: Kulmumeistri baaskoolitus · Sobivad ajad: Tööpäeviti pärast kella 17",
    );
    expect(await subjectOf(practice.locator("[data-request-reply]"))).toBe("Vastus sinu päringule — MINI");

    // Ootenimekiri: the course and the day, and a link to that session in Kalender
    const waitlist = card(f.waitlist.id);
    await expect(waitlist.locator("[data-request-tag]")).toHaveText("Ootenimekiri");
    await expect(waitlist.locator("[data-request-facts]")).toHaveText(new RegExp(`^${f.course.title} · Toimumine: \\d{2}\\.\\d{2}\\.\\d{4} \\d{2}:\\d{2}, Pärnu$`));
    const go = waitlist.getByRole("link", { name: "Ava toimumine →" });
    await expect(go).toHaveAttribute("href", `/admin/kalender?id=${f.session.id}`);
    for (const other of [contact, individual, practice]) await expect(other.getByRole("link", { name: /^Ava (toimumine|registreering) →/ })).toHaveCount(0);

    // the cards are in a grid of two columns on a laptop (one on a phone): the first two lie side by side, equally wide
    const boxes = await Promise.all((await page.locator("article[data-request]").all()).slice(0, 2).map((c) => c.boundingBox()));
    if (isMobile) expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height - 1);
    else {
      expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
      expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.width - 1);
      expect(Math.abs(boxes[0]!.width - boxes[1]!.width)).toBeLessThan(2);
    }
    expect(await noOverflow(page)).toBe(true);

    // the link goes to that session's own drawer
    await go.click();
    await expect(page).toHaveURL(new RegExp(`/admin/kalender\\?id=${f.session.id}$`));
  });

  test("requests: „Märgi tehtuks“ is instant with an UndoBar and the card moves to the fold „Tehtud ({n})“; „Võta tagasi“ brings it back; „Märgi tegemata“ shows no bar; an undo after the request changed elsewhere is refused", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/paringud?otsi=${f.tag}`);
    await adminReady(page);
    const bar = page.locator("[data-undo-bar]");
    const fold = page.locator("details[data-fold]");
    const practice = page.locator(`[data-request="${f.practice.id}"]`);
    await expect(practice).toBeVisible();
    await expect(fold).toHaveCount(0); // nothing is done yet: no fold

    // „Märgi tehtuks“ at once: the bar says so; the card leaves the list for the fold, which is shut and says how many it holds
    await practice.getByRole("button", { name: "Märgi tehtuks" }).click();
    await expect(bar).toContainText("Märgitud tehtuks.");
    await expect(bar.getByRole("button", { name: "Võta tagasi" })).toBeVisible();
    await expect.poll(() => requestHandled(f.practice.id)).toBe(true);
    await expect(fold.locator("summary")).toContainText("Tehtud (1)");
    await expect(practice).toBeHidden();
    await expect(fold).not.toHaveAttribute("open", "");
    // the fold opens on a tap: the same card, now with „Märgi tegemata“
    await fold.locator("summary").click();
    await expect(practice).toBeVisible();
    await expect(practice).toHaveAttribute("data-handled", "1");
    await expect(practice.getByRole("button", { name: "Märgi tegemata" })).toBeVisible();

    // „Võta tagasi“: open again, back in the list (out of the fold), the fold gone with its last card
    await bar.getByRole("button", { name: "Võta tagasi" }).click();
    await expect.poll(() => requestHandled(f.practice.id)).toBe(false);
    await expect(practice).toHaveAttribute("data-handled", "0");
    await expect(fold).toHaveCount(0);
    await expect(bar).toHaveCount(0);

    // „Märgi tegemata“ is its own reverse: no bar
    await practice.getByRole("button", { name: "Märgi tehtuks" }).click();
    await expect.poll(() => requestHandled(f.practice.id)).toBe(true);
    await expect(fold.locator("summary")).toContainText("Tehtud (1)");
    await expect(bar).toContainText("Märgitud tehtuks.");
    await page.keyboard.press("Escape"); // (the bar of that marking goes: Esc dismisses it)
    await expect(bar).toHaveCount(0);
    if (!(await fold.evaluate((el) => (el as HTMLDetailsElement).open))) await fold.locator("summary").click();
    await practice.getByRole("button", { name: "Märgi tegemata" }).click();
    await expect.poll(() => requestHandled(f.practice.id)).toBe(false);
    await expect(practice).toHaveAttribute("data-handled", "0");
    await expect(bar).toHaveCount(0);

    // an undo never overwrites a newer change: marked done, then (in another tab) reopened and marked done again, the bar's undo is refused
    await practice.getByRole("button", { name: "Märgi tehtuks" }).click();
    await expect(bar).toContainText("Märgitud tehtuks.");
    await storeRequestHandled(f.practice.id, false);
    await storeRequestHandled(f.practice.id, true);
    await bar.getByRole("button", { name: "Võta tagasi" }).click();
    await expect(bar).toContainText("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect(await requestHandled(f.practice.id)).toBe(true);
  });

  test("requests: the search looks in every tab and finds a phone by its digits; a result carries its tab's tag; nothing found says so, and the button returns", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/paringud?liik=kontakt");
    await adminReady(page);
    const search = page.getByRole("searchbox", { name: "Otsi nime, e-posti või telefoni järgi" });
    // from the Kontakt tab, the Praktika request is found by the digits of its phone, typed with other spaces and dashes than it was stored with (other tests' rows have the
    // same numbers, so this one is looked for among the results)
    await search.fill("5555-0103");
    await expect(page).toHaveURL(/\?liik=kontakt&otsi=5555-0103$/);
    const practice = page.locator(`[data-request="${f.practice.id}"]`);
    await expect(practice).toBeVisible();
    await expect(practice.locator("[data-request-tag]")).toHaveText("Praktika");
    await expect(page.locator(`[data-request="${f.individual.id}"]`)).toHaveCount(0); // (5555 0102)
    // while a search is on, no tab is the current one: it looks in all of them
    const tabs = page.getByRole("navigation", { name: "Päringu liik" });
    await expect(tabs.locator("[aria-current]")).toHaveCount(0);
    // its name, in other case; the message
    await search.fill(f.practice.name.toUpperCase());
    await expect(practice).toBeVisible();
    await expect(page.locator("article[data-request]")).toHaveCount(1);
    await search.fill("jaanuaris on veel kohti");
    await expect(page.locator(`[data-request="${f.contact.id}"]`)).toBeVisible();

    // „%“ is a letter: nothing contains it, and the empty state names the search and offers the way back to the tab she came from
    await search.fill("ei-ole-sellist-%");
    await expect(page.getByText("„ei-ole-sellist-%“ järgi päringuid ei leitud.")).toBeVisible();
    await page.getByRole("link", { name: "Tühjenda otsing ja filtrid" }).click();
    await expect(page).toHaveURL(/\/admin\/paringud\?liik=kontakt$/);
    await expect(search).toHaveValue("");
    await expect(tabs.getByRole("link", { name: /^Kontakt/ })).toHaveAttribute("aria-current", "true");
  });

  test("requests: an address ending #p-{id} scrolls to the card and marks it for 2 s (none with reduced motion); a card in the shut fold opens it", async ({ page, context, visitorIp }, info) => {
    const f = await fixtures(info.project.name);
    await storeRequestHandled(f.individual.id, true);
    await signIn(page, context, visitorIp);
    const open = page.locator(`#p-${f.practice.id}`);
    const done = page.locator(`#p-${f.individual.id}`);
    const flash = "rgb(250, 246, 248)"; // #faf6f8

    await page.goto(`/admin/paringud?otsi=${f.tag}#p-${f.practice.id}`);
    await adminReady(page);
    await expect(open).toHaveAttribute("data-flash", "");
    await expect(open).toHaveCSS("background-color", flash);
    await expect(open).not.toHaveAttribute("data-flash", "", { timeout: 6000 }); // (2 s)
    await expect(open).not.toHaveCSS("background-color", flash);
    expect(
      await open.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      }),
    ).toBe(true);

    // a done request is in the fold, which the address opens
    await page.goto(`/admin/paringud?otsi=${f.tag}#p-${f.individual.id}`);
    await adminReady(page);
    await expect(page.locator("details[data-fold]")).toHaveAttribute("open", "");
    await expect(done).toBeVisible();
    await expect(done).toHaveAttribute("data-flash", "");

    // reduced motion: reached, not marked
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/admin/paringud?otsi=${f.tag}#p-${f.practice.id}`);
    await adminReady(page);
    await expect(open).toBeVisible();
    await page.waitForTimeout(300);
    await expect(open).not.toHaveAttribute("data-flash", "");
    await expect(open).not.toHaveCSS("background-color", flash);
  });

  test("requests: the Päringud page at 375 × 812 — one column, the two buttons side by side with the short „Vasta ↗“ and the short date line, every target 44 px, nothing past the screen", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(!isMobile, "the phone project only");
    const f = await fixtures(info.project.name);
    await storeRequestHandled(f.individual.id, true);
    await signIn(page, context, visitorIp);
    await page.setViewportSize({ width: 375, height: 812 });
    // a name with no place to break, and a long message: the worst card
    const long = "Pneumonoultramicroscopicsilicovolcanoconiosis";
    await onLocalDb(
      (sql) => sql`update requests set payload = jsonb_set(jsonb_set(payload, '{name}', to_jsonb(${long}::text)), '{message}', to_jsonb(${`${long} ${long} ${long}`}::text)) where id = ${f.contact.id}`,
      { marksPages: false },
    );
    await page.goto(`/admin/paringud?otsi=${f.tag}`);
    await adminReady(page);
    const cards = page.locator("article[data-request]");
    await expect(cards.first()).toBeVisible();
    await page.locator("details[data-fold] summary").click();
    await expect(cards).toHaveCount(5);

    // one column: every card is as wide as the first, one above the other, all inside the 375 px screen
    const sized = (await Promise.all((await cards.all()).map((c) => c.boundingBox()))).map((b) => b!);
    for (const b of sized) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(375.5);
      expect(Math.abs(b.width - sized[0].width)).toBeLessThan(1);
    }
    const byTop = [...sized].sort((a, b) => a.y - b.y);
    for (let i = 1; i < byTop.length; i++) expect(byTop[i].y).toBeGreaterThan(byTop[i - 1].y + byTop[i - 1].height - 1);
    const outside = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("article[data-request] *"))
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && (r.left < -0.5 || r.right > window.innerWidth + 0.5))
          .map(({ e }) => e.outerHTML.slice(0, 100)),
      );
    expect(await outside()).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    expect(await smallTargets(page.locator("main"))).toEqual([]);

    // the card's two buttons share its width; the reply says „Vasta ↗“ and the date line is „dd.mm · ET“ (the stylesheet puts the short words in; the page holds the long ones)
    const contact = page.locator(`[data-request="${f.contact.id}"]`);
    const toggle = (await contact.getByRole("button", { name: "Märgi tehtuks" }).boundingBox())!;
    const reply = (await contact.locator("[data-request-reply]").boundingBox())!;
    const box = (await contact.boundingBox())!;
    expect(Math.abs(toggle.y - reply.y)).toBeLessThan(2);
    expect(reply.x).toBeGreaterThan(toggle.x + toggle.width - 1);
    expect(Math.abs(toggle.width - reply.width)).toBeLessThan(2);
    expect(reply.x + reply.width).toBeLessThanOrEqual(box.x + box.width);
    const after = (selector: string) => contact.locator(selector).evaluate((el) => getComputedStyle(el, "::after").content);
    expect(await after("[data-request-reply] [data-swap]")).toBe('"Vasta ↗"');
    expect(await after("[data-request-meta] [data-swap]")).toMatch(/^"\d{2}\.\d{2} · ET"$/);
    await expect(contact.locator("[data-request-reply] [data-swap] > span")).toBeHidden(); // (the long words)
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
    const drawer = page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` });
    // the header's phone and e-mail, and — in „Registreerimise andmed“, a folded row, opened here — the same two again
    await openRow(drawer, "Registreerimise andmed");
    await targets(drawer, 4);
    // a request's card (A7): its e-mail and phone are text now (the header's line and the facts line); what is pressed is „Vasta e-kirjaga ↗“ (on a phone „Vasta ↗“)
    await page.goto(`/admin/paringud?liik=individuaal&otsi=${f.tag}`);
    const card = page.locator(`[data-request="${f.individual.id}"]`);
    await targets(card, 1);
    expect(await smallTargets(card)).toEqual([]);
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
    await adminReady(page);
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
    await adminReady(page);
    await deleteStoredRequest(f.practice.id); // gone behind the open page
    await practice.getByRole("button", { name: "Märgi tehtuks" }).click();
    await expect(practice.getByRole("status")).toHaveText("Salvestamine ei õnnestunud. Proovi uuesti.");
    await expect(page.locator("[data-undo-bar]")).toHaveCount(0); // (nothing was marked: no undo of nothing)
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

import { readFileSync } from "node:fs";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { submitsForms, test, expect } from "./test";
import { signInAsAdmin } from "./admin-login";
import { smallTargets } from "./targets";
import {
  deleteStoredRequest,
  insertAdminFixtures,
  insertAdminPayments,
  removeAdminFixtures,
  removeAdminRows,
  requestHandled,
  setStoredStatus,
  storedAdminRegistration,
  type AdminFixtures,
} from "./fixtures";

// Task 12: the admin shell (prototype B sidebar), the overview and the inboxes (registrations, requests, newsletter).
// The signed-in tests run against the local dev server only: they sign in as Dim through the devLink (no e-mail: global
// setup refuses a dev environment with RESEND_API_KEY) and look at rows each test inserts for itself (tests/e2e/
// fixtures.ts, an unpublished fixture course with its own session) and deletes again. The guard tests are GET-only and
// also run against a deployment.

const MENU = ["Ülevaade", "Koolitused", "Kalender", "Registreerimised", "Hindamine", "Maksed", "Tagasiside", "Õpilased", "Päringud", "Praktika", "Avaleht", "Koolitaja", "Uudised", "Hüpikaken", "Uudiskiri", "Seaded"];

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

/** The admin menu: the sidebar on a wide screen, the drawer (opened here) on a phone. */
async function menu(page: Page, isMobile: boolean): Promise<Locator> {
  if (isMobile) {
    await page.getByRole("button", { name: "Ava menüü" }).click();
    const drawer = page.locator("[data-admin-drawer]");
    await expect(drawer).toBeVisible();
    return drawer.getByRole("navigation", { name: "Halduse menüü" });
  }
  return page.locator("aside").getByRole("navigation", { name: "Halduse menüü" });
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
    // "Kiirlingid → Vaata lehte ↗" goes through api/admin/preview like the sidebar's and the top line's: with the coming-soon
    // gate on, a plain "/" would show the coming-soon page to an admin who has no preview cookie yet
    const quickSite = page.locator('section[aria-labelledby="links-title"]').getByRole("link", { name: /Vaata lehte/ });
    await expect(quickSite).toHaveAttribute("href", "/api/admin/preview");
    await expect(quickSite).toHaveAttribute("target", "_blank");
    await expect(quickSite).toHaveAttribute("rel", "noopener");
    expect(await noOverflow(page)).toBe(true);

    const nav = await menu(page, isMobile);
    const links = nav.getByRole("list").first().getByRole("link");
    await expect(links).toHaveCount(MENU.length);
    for (const [i, label] of MENU.entries()) await expect(links.nth(i)).toContainText(label);
    await expect(nav.locator('[data-nav="overview"]')).toHaveAttribute("aria-current", "page");
    await expect(nav.locator('[data-badge="registrations"]')).toBeVisible();
    await expect(nav.locator('[data-badge="requests"]')).toBeVisible();
    const site = nav.getByRole("link", { name: /Vaata lehte/ });
    // through api/admin/preview: the coming-soon gate's preview cookie, then the home page (src/lib/site-gate.ts)
    await expect(site).toHaveAttribute("href", "/api/admin/preview");
    await expect(site).toHaveAttribute("target", "_blank");
    await expect(nav.getByRole("button", { name: "Logi välja" })).toBeVisible();
    for (const target of await nav.locator("a, button").all()) expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
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
    const typeFilter = page.locator("[data-type-filter]");
    await expect(typeFilter.getByRole("link")).toHaveText(["Kõik", "E-õpe", "Kontaktõpe"]);
    await expect(typeFilter.getByRole("link", { name: "Kõik" })).toHaveAttribute("aria-current", "true");

    await typeFilter.getByRole("link", { name: "Kontaktõpe" }).click();
    await expect(page).toHaveURL(/\?vorm=k$/);
    const row = page.locator(`[data-registration="${f.registration.id}"]`);
    await expect(row).toContainText(f.registration.name);
    await expect(row).toContainText(f.registration.email);
    await expect(row).toContainText(f.course.title);
    await expect(row).toContainText("Pärnu");
    await expect(row).toContainText("50% ettemaks");
    await expect(row.locator('[data-label="Liik"]')).toContainText("Kontaktõpe");
    await expect(row.locator('[data-label="Liik"]')).toContainText("Grupp");
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
    await typeFilter.getByRole("link", { name: "E-õpe" }).click();
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
    await (await menu(page, isMobile)).getByRole("link", { name: "Maksed", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/maksed$/);
    if (isMobile) await expect(page.locator("[data-admin-drawer]")).toBeHidden(); // the link closed the drawer
    await expect(page).toHaveTitle(/Maksed — Haldus/);
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

  test("e-mail and phone links are 44 px touch targets: registrations list and drawer, requests (item 12)", async ({ page, context, visitorIp }, info) => {
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
    await targets(row, 2); // e-mail and phone
    await disjoint(row.locator('[data-label="Nimi"]'));
    await row.getByRole("link", { name: `Ava ${f.registration.name}` }).click();
    await targets(page.getByRole("dialog", { name: `Registreerimine: ${f.registration.name}` }), 2);
    await page.goto("/admin/paringud?liik=individuaal");
    await targets(page.locator(`[data-request="${f.individual.id}"]`), 2);
    expect(await noOverflow(page)).toBe(true);
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

  test("phone: the sidebar is a top bar with a menu drawer (Esc closes it)", async ({ page, context, visitorIp, isMobile }) => {
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
    expect(await noOverflow(page)).toBe(true);
  });
});

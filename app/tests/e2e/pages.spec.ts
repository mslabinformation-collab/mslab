import type { Page } from "@playwright/test";
import { submitsForms, test, expect } from "./test";
import { holdBackRouterHistoryPatch } from "./early-tap";
import { LOCAL_FIXTURES, storedRequests, storedSubscriber, testEmail } from "./fixtures";
import { sampleDayMonth, sampleWeekday } from "./seed-sessions";

// Task 9: calendar (L1–L5), practice (R1–R5), trainer (T1–T4), blog (B1), contact and legal pages.
// The first three tests are the brief's tests, verbatim except one locator: `getByText(/ak/)` first matched the header's
// "Praktika" menu link (pr-AK-tika), which is hidden on phones, so the duration check is `/\d+\s*ak\b/` ("≈ 4 ak").
// The rest cover the remaining checklist items against the seed data (8 contact-course sessions, the Tartu one
// cancelled; MINI/MAXI; 7 trainer works; 6 posts). Against the local server, global-setup also makes the LAMI Pärnu
// session full and the Lash Lift Viljandi one "few" with test-owned registrations (see fixtures.ts).

test("calendar puts course name first and shows language", async ({ page }) => {
  await page.goto("/koolituskalender");
  const row = page.locator("[data-calendar-row]").first();
  const name = row.locator("[data-course-name]"); const city = row.locator("[data-city]");
  const [nf, cf] = await Promise.all([name.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)), city.evaluate((e) => parseFloat(getComputedStyle(e).fontSize))]);
  expect(nf).toBeGreaterThan(cf);
  await expect(row.locator("[data-lang]")).toHaveText(/ET|RU/);
});
test("practice says where it is offered and shows durations", async ({ page }) => {
  await page.goto("/praktika");
  await expect(page.getByText(/Pärnus ja Tallinnas/i).first()).toBeVisible();
  await expect(page.getByText(/\d+\s*ak\b/).first()).toBeVisible();
});
test("trainer page has gallery, story and journey", async ({ page }) => {
  await page.goto("/koolitaja");
  await expect(page.getByText("Koolituskeskuse lugu")).toBeVisible();
  await expect(page.getByText("Koolitaja teekond")).toBeVisible();
  await page.locator("[data-works] img").first().click(); await expect(page.getByRole("dialog")).toBeVisible();
});

const collectErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
};
const fontSize = (el: import("@playwright/test").Locator) => el.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));

test.describe("calendar", () => {
  test("rows: date, dominant course name, city and venue, format and language, seat state, action (L1–L4)", async ({ page }) => {
    await page.goto("/koolituskalender");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Koolituskalender");
    const rows = page.locator("[data-calendar-row]");
    await expect(rows).toHaveCount(8); // contact-course sessions only; e-learning has no dates
    await expect(page.getByText("Kulmumeistri e-koolitus")).toHaveCount(0);

    const first = rows.first();
    await expect(first.locator("[data-course-name]")).toHaveText("Kulmumeistri baaskoolitus");
    await expect(first.locator("[data-city]")).toHaveText("Pärnu");
    await expect(first).toContainText("MS LAB stuudio, Rüütli 12");
    await expect(first).toContainText(sampleDayMonth("kulmumeistri-baaskoolitus", "Pärnu"));
    await expect(first).toContainText(sampleWeekday("kulmumeistri-baaskoolitus", "Pärnu"));
    await expect(first).toContainText("Kontaktõpe");
    await expect(first).toContainText("Vabu kohti · 4");
    // Course name at A's city size (Jost 26px), before the city in reading order (L2, L3).
    const name = first.locator("[data-course-name]");
    expect(await fontSize(name)).toBe(26);
    expect(await name.evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/Jost/i);
    const nameFirst = await first.evaluate((row) => {
      const n = row.querySelector("[data-course-name]")!;
      const c = row.querySelector("[data-city]")!;
      return Boolean(n.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(nameFirst).toBe(true);
    for (const r of await rows.all()) expect(await fontSize(r.locator("[data-course-name]"))).toBeGreaterThan(await fontSize(r.locator("[data-city]")));

    // Language tag on every row (L4): the bilingual LAMI shows both.
    await expect(rows.locator("[data-lang]")).toHaveCount(8);
    await expect(rows.filter({ hasText: "Kulmude LAMI" }).first().locator("[data-lang]")).toContainText("ET / RU");

    // Registreeru → the course page with that session picked.
    const register = first.getByRole("link", { name: /Registreeru/ });
    const target = await register.getAttribute("href");
    expect(target).toMatch(/^\/koolitused\/kulmumeistri-baaskoolitus\?sessioon=\d+$/);
    await register.click();
    await expect(page).toHaveURL(target!);
    const id = target!.split("=")[1];
    await expect(page.locator(`[data-session='${id}']`)).toHaveAttribute("aria-checked", "true");
  });

  test("a cancelled session says Tühistatud and offers the other dates", async ({ page }) => {
    await page.goto("/koolituskalender");
    const cancelled = page.locator("[data-calendar-row][data-state='cancelled']");
    await expect(cancelled).toHaveCount(1);
    await expect(cancelled).toContainText("Tühistatud");
    await expect(cancelled).toContainText("Lash Lift BOTOX baaskoolitus");
    await expect(cancelled.getByRole("link", { name: /Registreeru/ })).toHaveCount(0);
    await expect(cancelled.getByRole("link", { name: /Vaata teisi/ })).toHaveAttribute("href", "/koolitused/lash-lift-botox");
  });

  test("city filter: ?linn is the source of truth; Back, reload and unknown values (L5)", async ({ page }) => {
    await page.goto("/koolituskalender");
    const chips = page.locator("[data-city-filter] button");
    await expect(chips).toHaveText(["Kõik", "Pärnu", "Tallinn", "Tartu", "Viljandi"]);
    await expect(chips.first()).toHaveAttribute("aria-pressed", "true");
    const rows = page.locator("[data-calendar-row]");

    await page.locator("[data-city-filter]").getByRole("button", { name: "Tallinn" }).click();
    await expect(page).toHaveURL(/\/koolituskalender\?linn=tallinn$/);
    await expect(rows).toHaveCount(2);
    await expect(rows.locator("[data-city]")).toHaveText(["Tallinn", "Tallinn"]);
    await expect(page.locator("[data-city-filter]").getByRole("button", { name: "Tallinn" })).toHaveAttribute("aria-pressed", "true");

    await rows.first().getByRole("link", { name: /Registreeru/ }).click();
    await expect(page).toHaveURL(/\/koolitused\/lash-lift-botox\?sessioon=\d+$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/koolituskalender\?linn=tallinn$/);
    await expect(rows).toHaveCount(2);
    await expect(page.locator("[data-city-filter]").getByRole("button", { name: "Tallinn" })).toHaveAttribute("aria-pressed", "true");

    await page.locator("[data-city-filter]").getByRole("button", { name: "Kõik" }).click();
    await expect(page).toHaveURL(/\/koolituskalender$/);
    await expect(rows).toHaveCount(8);

    await page.goto("/koolituskalender?linn=viljandi");
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator("[data-city]")).toHaveText("Viljandi");
    await page.reload();
    await expect(rows).toHaveCount(1);

    await page.goto("/koolituskalender?linn=parnu");
    await expect(rows).toHaveCount(3);

    await page.goto("/koolituskalender?linn=narva");
    await expect(rows).toHaveCount(8);
    await expect(chips.first()).toHaveAttribute("aria-pressed", "true");
  });

  test("a city chip tapped before Next.js follows history changes still filters and survives Back (race of item 5)", async ({ page }) => {
    await holdBackRouterHistoryPatch(page);
    await page.goto("/koolituskalender");
    const rows = page.locator("[data-calendar-row]");
    await page.locator("[data-city-filter]").getByRole("button", { name: "Tallinn" }).click();
    await expect(page).toHaveURL(/\/koolituskalender\?linn=tallinn$/);
    await expect(rows).toHaveCount(2);
    await expect(page.locator("[data-city-filter]").getByRole("button", { name: "Tallinn" })).toHaveAttribute("aria-pressed", "true");
    await rows.first().getByRole("link", { name: /Registreeru/ }).click();
    await expect(page).toHaveURL(/\/koolitused\/lash-lift-botox\?sessioon=\d+$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/koolituskalender\?linn=tallinn$/);
    await expect(rows).toHaveCount(2);
  });

  test("RU calendar", async ({ page }) => {
    await page.goto("/ru/koolituskalender");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Расписание");
    await expect(page.locator("[data-city-filter] button").first()).toHaveText("Все");
    await expect(page.locator("[data-calendar-row]").first().getByRole("link", { name: /Записаться/ })).toHaveAttribute("href", /^\/ru\/koolitused\/.+\?sessioon=\d+$/);
    // the area chips in Russian, the same Estonian slug in the address (course areas §5.1, §5.3)
    const area = page.locator("[data-area-filter]");
    await expect(area).toHaveAttribute("aria-label", "Направление");
    await expect(area.locator("button")).toHaveText(["Все", "Курсы по бровям", "Курсы по ресницам"]);
    await area.getByRole("button", { name: "Курсы по ресницам" }).click();
    await expect(page).toHaveURL(/\/ru\/koolituskalender\?valdkond=ripsmekoolitused$/);
    await expect(page.locator("[data-calendar-row]")).toHaveCount(3);
    await page.locator("[data-city-filter]").getByRole("button", { name: "Pärnu" }).click();
    const empty = page.locator("[data-calendar-empty]");
    await expect(empty).toContainText("По выбранным фильтрам сейчас нет курсов.");
    await empty.getByRole("button", { name: "Показать все" }).click();
    await expect(page).toHaveURL(/\/ru\/koolituskalender$/);
    await expect(page.locator("[data-calendar-row]")).toHaveCount(8);
  });

  // Course areas (spec 2026-11-11-course-areas-filter-design.md §5.1): the seed gives the brow courses „Kulmukoolitused“ (5 dates) and Lash Lift
  // BOTOX „Ripsmekoolitused“ (3 dates: Tallinn, Viljandi, the cancelled Tartu one).
  test("area filter: below the city chips, ?valdkond with ?linn (AND), reload, the empty state's „Näita kõiki“, unknown values", async ({ page }) => {
    await page.goto("/koolituskalender");
    const area = page.locator("[data-area-filter]");
    await expect(area).toHaveAttribute("role", "group");
    await expect(area).toHaveAttribute("aria-label", "Valdkond");
    await expect(area.locator("button")).toHaveText(["Kõik", "Kulmukoolitused", "Ripsmekoolitused"]);
    await expect(area.locator("button").first()).toHaveAttribute("aria-pressed", "true");
    // right under the city chips, no heading between them
    const city = (await page.locator("[data-city-filter]").boundingBox())!;
    const box = (await area.boundingBox())!;
    expect(box.y).toBeGreaterThan(city.y + city.height - 1);
    expect(box.y - (city.y + city.height)).toBeLessThan(20);
    const rows = page.locator("[data-calendar-row]");

    await area.getByRole("button", { name: "Ripsmekoolitused" }).click();
    await expect(page).toHaveURL(/\/koolituskalender\?valdkond=ripsmekoolitused$/);
    await expect(rows).toHaveCount(3);
    await expect(rows.locator("[data-course-name]")).toHaveText(Array(3).fill("Lash Lift BOTOX baaskoolitus"));

    await page.locator("[data-city-filter]").getByRole("button", { name: "Tallinn" }).click();
    await expect(page).toHaveURL(/\/koolituskalender\?valdkond=ripsmekoolitused&linn=tallinn$/);
    await expect(rows).toHaveCount(1);
    await page.reload();
    await expect(rows).toHaveCount(1);
    await expect(area.getByRole("button", { name: "Ripsmekoolitused" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-city-filter]").getByRole("button", { name: "Tallinn" })).toHaveAttribute("aria-pressed", "true");

    // Pärnu has no lash date: the empty state, whose „Näita kõiki“ clears both filters
    await page.locator("[data-city-filter]").getByRole("button", { name: "Pärnu" }).click();
    await expect(rows).toHaveCount(0);
    const empty = page.locator("[data-calendar-empty]");
    await expect(empty).toContainText("Valitud filtritega hetkel koolitusi pole.");
    await empty.getByRole("button", { name: "Näita kõiki" }).click();
    await expect(page).toHaveURL(/\/koolituskalender$/);
    await expect(rows).toHaveCount(8);
    await expect(area.locator("button").first()).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-city-filter] button").first()).toHaveAttribute("aria-pressed", "true");

    // a link with both: the brow course's Tallinn date; an unknown or old area reads as „Kõik“
    await page.goto("/koolituskalender?valdkond=kulmukoolitused&linn=tallinn");
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator("[data-course-name]")).toHaveText("Kulmumeistri baaskoolitus");
    await page.goto("/koolituskalender?valdkond=vana-valdkond");
    await expect(rows).toHaveCount(8);
    await expect(area.locator("button").first()).toHaveAttribute("aria-pressed", "true");
  });

  const LONG_AREA = "Курсы долговременной укладки и ламинирования бровей и ресниц";

  test("at 390 the area chips are 44 px targets inside the page, ET and RU, with no horizontal overflow, a 60-character name too", async ({ page, isMobile }) => {
    test.skip(!isMobile, "phone width");
    for (const path of ["/koolituskalender", "/ru/koolituskalender"]) {
      await page.goto(path);
      const chips = page.locator("[data-area-filter] button");
      await expect(chips).toHaveCount(3);
      const city = (await page.locator("[data-city-filter]").boundingBox())!;
      for (const b of await chips.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))) {
        expect(b.top, path).toBeGreaterThan(city.y + city.height - 1);
        expect(b.height, path).toBeGreaterThanOrEqual(44);
        expect(b.right, path).toBeLessThanOrEqual(390);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), path).toBe(true);

      // an area name of Maria's 60 characters long (Russian runs long; the text set in the page, nothing written): the chip wraps inside the page
      expect(LONG_AREA).toHaveLength(60);
      await chips.last().evaluate((e, name) => (e.textContent = name), LONG_AREA);
      const group = (await page.locator("[data-area-filter]").boundingBox())!;
      const long = (await chips.last().boundingBox())!;
      expect(long.height, path).toBeGreaterThanOrEqual(44);
      expect(long.x + long.width, path).toBeLessThanOrEqual(group.x + group.width + 0.5);
      expect(group.x + group.width, path).toBeLessThanOrEqual(390);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), path).toBe(true);
    }
  });
});

test.describe("calendar seat states (test-owned fixtures in the local DB)", () => {
  test.skip(!LOCAL_FIXTURES, "the seat fixtures are only inserted into the local dev database");

  test("a full session: Kohad täis, the Liitu ootenimekirjaga disclosure and the waitlist form (L3, A3)", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("waitlist", info.project.name);
    await page.goto("/koolituskalender");
    const full = page.locator("[data-calendar-row][data-state='full']");
    await expect(full).toHaveCount(1);
    await expect(full.locator("[data-course-name]")).toHaveText("Kulmude LAMI");
    await expect(full.locator("[data-city]")).toHaveText("Pärnu");
    const lamiParnu = sampleDayMonth("kulmude-lami", "Pärnu") as string; // local only: these are the local seat fixtures
    await expect(full).toContainText(lamiParnu);
    await expect(full.locator("[data-seat-state]")).toHaveText("Kohad täis"); // B's wording (item 13)
    expect(await full.locator("[data-seat-state]").evaluate((e) => getComputedStyle(e).color)).toBe("rgb(94, 85, 89)");
    await expect(full.getByRole("link", { name: /Registreeru/ })).toHaveCount(0);

    // Disclosure: opens the form under the row with focus in the name field, and closes again.
    // the disclosure (aria-expanded) says "Liitu ootenimekirjaga" (B's wording, C49), as the form's own submit button does
    const toggle = full.locator("button[aria-expanded]");
    await expect(toggle).toHaveAccessibleName(new RegExp(`^Liitu ootenimekirjaga\\s*: Kulmude LAMI · ${lamiParnu} · Pärnu$`));
    const form = full.locator("[data-waitlist-form]");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(form).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`[id="${await toggle.getAttribute("aria-controls")}"]`)).toBeVisible();
    await expect(form.getByLabel("Nimi")).toBeFocused();
    await expect(form).toContainText(`Kulmude LAMI · ${lamiParnu} · Pärnu`);
    await expect(form).toHaveAttribute("method", "post");
    await expect(form.getByLabel("Soovin MS LABi sooduspakkumisi ja uudiskirju saada")).not.toBeChecked(); // phase 2c: the newsletter consent, unticked
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(form).toBeHidden();
    await toggle.click();
    await expect(form.getByLabel("Nimi")).toBeFocused();

    // Errors: focus goes to the first invalid field, which describes its error.
    const submit = form.getByRole("button", { name: "Liitu ootenimekirjaga" });
    await submit.click();
    const name = form.getByLabel("Nimi");
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveAccessibleDescription("See väli on kohustuslik.");
    await name.fill("Test Õpilane");
    const email = form.getByLabel("E-post", { exact: true });
    await email.fill("vale-aadress");
    await submit.click();
    await expect(email).toBeFocused();
    await expect(email).toHaveAccessibleDescription("Sisesta korrektne e-posti aadress.");
    await expect(name).not.toHaveAttribute("aria-invalid", "true");

    // A valid request shows the confirmation and moves focus to it; it is stored as a waitlist request.
    await email.fill(addr);
    const session = Number(await form.locator("input[name='session']").inputValue());
    await form.getByLabel("Soovin MS LABi sooduspakkumisi ja uudiskirju saada").check();
    await submit.click();
    const sent = full.locator("[data-waitlist-sent]");
    await expect(sent).toHaveText("Aitäh! Oled ootenimekirjas.");
    await expect(sent).toBeFocused();
    expect(await storedRequests(addr)).toEqual([{ kind: "waitlist", payload: { session, course: "kulmude-lami", name: "Test Õpilane", email: addr, locale: "et" } }]);
    // ticked: the newsletter's own sign-up followed the answer (phase 2c), confirmed at once (one step, 09.10), and the request itself does not carry the box
    await expect.poll(() => storedSubscriber(addr)).toMatchObject({ email: addr, confirmed: true });
  });

  test("a session with two seats left says Viimased kohad and can still be booked", async ({ page }) => {
    await page.goto("/koolituskalender");
    const few = page.locator("[data-calendar-row][data-state='few']");
    await expect(few).toHaveCount(1);
    await expect(few.locator("[data-course-name]")).toHaveText("Lash Lift BOTOX baaskoolitus");
    await expect(few.locator("[data-city]")).toHaveText("Viljandi");
    await expect(few).toContainText("Viimased kohad · 2");
    expect(await few.locator("[data-seat-state]").evaluate((e) => getComputedStyle(e).color)).toBe("rgb(107, 79, 92)");
    await expect(few.getByRole("link", { name: /Registreeru/ })).toHaveAttribute("href", /^\/koolitused\/lash-lift-botox\?sessioon=\d+$/);
    await expect(few.getByRole("button", { name: /ootenimekirja/i })).toHaveCount(0);
  });

  test("the course page shows the full date but it cannot be picked", async ({ page }) => {
    await page.goto("/koolitused/kulmude-lami");
    const full = page.locator("[data-session][data-state='full']");
    await expect(full).toHaveCount(1);
    await expect(full).toHaveAttribute("aria-disabled", "true");
    await expect(full).toContainText("Kohad täis");
    await full.click({ force: true });
    await expect(full).toHaveAttribute("aria-checked", "false");
  });

  test("RU: full and few rows", async ({ page }) => {
    await page.goto("/ru/koolituskalender");
    const full = page.locator("[data-calendar-row][data-state='full']");
    await expect(full).toContainText("Мест нет");
    await expect(full.locator("button[aria-expanded]")).toHaveAccessibleName(/^Встать в лист ожидания\s*: /);
    await expect(page.locator("[data-calendar-row][data-state='few']")).toContainText("Последние места · 2");
  });
});

test.describe("practice", () => {
  test("H1 Praktika first, Pärnu and Tallinn, Maria's text and the protocol, MINI and MAXI with durations and Jost prices (R1–R5)", async ({ page }) => {
    await page.goto("/praktika");
    await expect(page.locator("#main").locator("h1, h2").first()).toHaveText("Praktika");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Praktika");
    await expect(page.getByText("Praktikavõimalus on Pärnus ja Tallinnas.")).toBeVisible();
    const panel = page.locator("[data-practice]");
    await expect(panel.getByText(/Praktika toimub koolitaja juhendamisel/)).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Praktikaprotokoll" })).toBeVisible();
    await expect(panel).toContainText("MINI");
    await expect(panel).toContainText("MAXI");
    await expect(panel).toContainText("≈ 4 ak");
    await expect(panel).toContainText("≈ 8 ak");
    await expect(panel).toContainText("Töö kahel modellil");
    const prices = panel.locator("[data-price]");
    await expect(prices).toHaveText(["100 €", "150 €"]);
    expect(await prices.first().evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/Jost/i);
    // The H1 is the largest heading on the page (H11).
    expect(await fontSize(page.getByRole("heading", { level: 1 }))).toBeGreaterThan(await fontSize(panel.locator("h2")));
  });

  test("?pakett=MAXI#taotlus preselects the package and lands on the form; card buttons switch it", async ({ page }) => {
    await page.goto("/praktika?pakett=MAXI#taotlus");
    const form = page.locator("[data-practice-form]");
    await expect(form.getByRole("radio", { name: /MAXI/ })).toBeChecked();
    await expect(page.locator("#taotlus")).toBeInViewport();
    await expect(page.locator("#taotlus")).toContainText("Valitud pakett: MAXI");
    await expect(page.locator("[data-package='MAXI']")).toHaveAttribute("data-selected", "true");

    await page.locator("[data-practice]").getByRole("link", { name: /Registreeru MINI/ }).click();
    await expect(page).toHaveURL(/\/praktika\?pakett=MINI#taotlus$/);
    await expect(form.getByRole("radio", { name: /MINI/ })).toBeChecked();
    await expect(page.locator("[data-package='MINI']")).toHaveAttribute("data-selected", "true");

    await form.getByRole("radio", { name: /MAXI/ }).check();
    await expect(page).toHaveURL(/\/praktika\?pakett=MAXI#taotlus$/);
    await expect(page.locator("[data-package='MAXI']")).toHaveAttribute("data-selected", "true");
    await page.reload();
    await expect(form.getByRole("radio", { name: /MAXI/ })).toBeChecked();
  });

  test("a package picked before Next.js follows history changes moves the card outline and the URL (race of item 5)", async ({ page }) => {
    await holdBackRouterHistoryPatch(page);
    await page.goto("/praktika?pakett=MINI#taotlus");
    const form = page.locator("[data-practice-form]");
    await form.getByRole("radio", { name: /MAXI/ }).check();
    await expect(page).toHaveURL(/\/praktika\?pakett=MAXI#taotlus$/);
    await expect(page.locator("[data-package='MAXI']")).toHaveAttribute("data-selected", "true");
    await expect(page.locator("[data-package='MINI']")).not.toHaveAttribute("data-selected", "true");
    // the panel's own "Registreeru MINI" link (a Next.js navigation) still switches back
    await page.locator("[data-practice]").getByRole("link", { name: /Registreeru MINI/ }).click();
    await expect(page).toHaveURL(/\/praktika\?pakett=MINI#taotlus$/);
    await expect(form.getByRole("radio", { name: /MINI/ })).toBeChecked();
    await expect(page.locator("[data-package='MINI']")).toHaveAttribute("data-selected", "true");
  });

  test("on the practice page a card's Registreeru picks its package in place (no navigation, one #taotlus)", async ({ page }) => {
    // Landing on ?pakett=MINI#taotlus, picking MAXI and then the panel's "Registreeru MINI" used to be a Next.js
    // navigation back to the landing address, which once doubled the hash (#taotlus#taotlus).
    await page.goto("/praktika?pakett=MINI#taotlus");
    const form = page.locator("[data-practice-form]");
    await form.getByRole("radio", { name: /MAXI/ }).check();
    await expect(page).toHaveURL(/\/praktika\?pakett=MAXI#taotlus$/);
    const rsc: string[] = []; // navigation requests (a production build also prefetches links: those are not counted)
    page.on("request", (r) => {
      const h = r.headers();
      if (r.url().includes("_rsc=") && !h["next-router-prefetch"] && !h["next-router-segment-prefetch"]) rsc.push(r.url());
    });
    await page.locator("[data-practice]").getByRole("link", { name: /Registreeru MINI/ }).click();
    await expect(page).toHaveURL(/\/praktika\?pakett=MINI#taotlus$/);
    expect(new URL(page.url()).hash).toBe("#taotlus");
    await expect(form.getByRole("radio", { name: /MINI/ })).toBeChecked();
    await expect(page.locator("[data-package='MINI']")).toHaveAttribute("data-selected", "true");
    await expect(page.locator("#taotlus")).toBeInViewport();
    expect(rsc).toEqual([]); // picked in place
    // a Ctrl/⌘ click is still the browser's: a new tab with that package
    const [tab] = await Promise.all([page.context().waitForEvent("page"), page.locator("[data-practice]").getByRole("link", { name: /Registreeru MAXI/ }).click({ modifiers: ["ControlOrMeta"] })]);
    await tab.waitForURL(/\/praktika\?pakett=MAXI#taotlus$/);
    await tab.close();
    await expect(page).toHaveURL(/\/praktika\?pakett=MINI#taotlus$/);
  });

  test("the in-place pick takes the package the link names, not the card it sits in (fix round 1)", async ({ page }) => {
    await page.goto("/praktika?pakett=MINI#taotlus");
    const link = page.locator("[data-package='MINI']").getByRole("link", { name: /Registreeru/ });
    // a card whose link names another package (as an admin-made link could): the link wins
    await link.evaluate((a: HTMLAnchorElement) => a.setAttribute("href", a.getAttribute("href")!.replace("pakett=MINI", "pakett=MAXI")));
    await link.click();
    await expect(page).toHaveURL(/\/praktika\?pakett=MAXI#taotlus$/);
    await expect(page.locator("[data-practice-form]").getByRole("radio", { name: /MAXI/ })).toBeChecked();
    await expect(page.locator("[data-package='MAXI']")).toHaveAttribute("data-selected", "true");
  });

  test("home practice cards lead to the form with the package picked", async ({ page }) => {
    await page.goto("/");
    await page.locator("[data-practice]").getByRole("link", { name: /Registreeru MAXI/ }).click();
    await expect(page).toHaveURL(/\/praktika\?pakett=MAXI#taotlus$/);
    await expect(page.locator("[data-practice-form]").getByRole("radio", { name: /MAXI/ })).toBeChecked();
  });

  test("request form: focus goes to the first invalid field; a complete request is sent", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("practice", info.project.name);
    await page.goto("/praktika");
    const form = page.locator("[data-practice-form]");
    await expect(form).toHaveAttribute("method", "post");
    await form.getByRole("button", { name: "Saada taotlus" }).click();
    await expect(form.getByRole("radio", { name: /MINI/ })).toBeFocused();
    await form.getByRole("radio", { name: /MINI/ }).check();
    await form.getByRole("button", { name: "Saada taotlus" }).click();
    // the student picks the city (nothing preselected): without one, „Vali linn.“ and focus on the first city
    const city = form.getByRole("radiogroup", { name: "Linn" });
    await expect(city.getByRole("radio")).toHaveCount(2);
    await expect(city.getByRole("radio", { name: "Pärnu" })).toBeFocused();
    await expect(city).toHaveAccessibleDescription("Vali linn.");
    await city.getByRole("radio", { name: "Tallinn" }).check();
    await form.getByRole("button", { name: "Saada taotlus" }).click();
    const nameField = form.getByLabel("Nimi");
    await expect(nameField).toBeFocused();
    await expect(nameField).toHaveAttribute("aria-invalid", "true");
    await expect(nameField).toHaveAccessibleDescription("See väli on kohustuslik.");
    await nameField.fill("Test Õpilane");
    await form.getByLabel("E-post", { exact: true }).fill(addr);
    await form.getByLabel("Telefon").fill("+372 5555 5555");
    await form.getByLabel(/Läbitud koolitus/).fill("Kulmumeistri baaskoolitus");
    await form.getByLabel(/Millised ajad/).fill("Tööpäeva õhtud");
    await form.getByRole("button", { name: "Saada taotlus" }).click();
    await expect(page.getByText("Taotlus on saadetud.")).toBeVisible();
    await expect(page.locator("[data-practice-sent]")).toBeFocused();
    if (LOCAL_FIXTURES)
      expect(await storedRequests(addr)).toEqual([
        { kind: "practice", payload: { package: "MINI", name: "Test Õpilane", email: addr, phone: "+372 5555 5555", city: "Tallinn", course: "Kulmumeistri baaskoolitus", times: "Tööpäeva õhtud", locale: "et" } },
      ]);
  });

  test("RU practice", async ({ page }) => {
    await page.goto("/ru/praktika?pakett=MINI");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Практика");
    await expect(page.getByText("Практика возможна в Пярну и Таллинне.")).toBeVisible();
    await expect(page.locator("[data-practice-form]").getByRole("radio", { name: /MINI/ })).toBeChecked();
    // the city choice in Russian (Maria 10.11): Пярну and Таллинн, nothing picked
    await expect(page.locator("[data-practice-form]").getByRole("radio", { name: "Таллинн" })).not.toBeChecked();
    await expect(page.locator("[data-practice-form]").getByRole("radio", { name: "Пярну" })).not.toBeChecked();
  });
});

test.describe("trainer", () => {
  test("D base: name, bio, stats, portrait with the works gallery under it (T1, T2)", async ({ page, isMobile }) => {
    await page.goto("/koolitaja");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Maria Sosnina");
    await expect(page.getByText(/Töötan Pärnus ilukliinikus/)).toBeVisible();
    await expect(page.getByText("8+")).toBeVisible();
    await expect(page.getByRole("link", { name: "Vaata koolitusi" })).toHaveAttribute("href", "/koolitused");
    const portrait = await page.locator("[data-portrait]").boundingBox();
    const works = page.locator("[data-works]");
    await expect(works.getByRole("heading", { name: "Koolitaja tööd" })).toBeVisible();
    const box = await works.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(portrait!.y + portrait!.height - 1);
    expect(Math.abs(box!.x - portrait!.x)).toBeLessThan(2);
    await expect(works.locator("[data-work]")).toHaveCount(7);

    // Per view: 3 on desktop, tablets and phones alike (Maria 10.11: "kas saaks telefoni ja tahvlisse ka kolm panna"; the tablet checked below).
    const perView = () =>
      works.locator("[data-works-track]").evaluate((track) => {
        const item = track.firstElementChild as HTMLElement;
        const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
        return (track.clientWidth + gap) / (item.getBoundingClientRect().width + gap);
      });
    expect(await perView()).toBeCloseTo(3, 1);
    if (!isMobile) {
      await page.setViewportSize({ width: 834, height: 1112 });
      await expect.poll(perView).toBeCloseTo(3, 1);
    }
  });

  test("works carousel: arrows scroll, lightbox opens at the image, ←/→ move, Esc closes and returns focus (T2)", async ({ page }) => {
    await page.goto("/koolitaja");
    const works = page.locator("[data-works]");
    const track = works.locator("[data-works-track]");
    const prev = works.getByRole("button", { name: "Eelmine" });
    const next = works.getByRole("button", { name: "Järgmine" });
    await expect(prev).toBeDisabled();
    await next.click();
    await expect.poll(() => track.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
    await expect(prev).toBeEnabled();

    const second = works.locator("[data-work]").nth(1).getByRole("button");
    await second.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("2 / 7");
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText("3 / 7");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(second).toBeFocused();
  });

  test("carousel arrows keep keyboard focus at the ends (aria-disabled, not disabled)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/koolitaja");
    const works = page.locator("[data-works]");
    const track = works.locator("[data-works-track]");
    const prev = works.getByRole("button", { name: "Eelmine" });
    const next = works.getByRole("button", { name: "Järgmine" });
    await expect(prev).toHaveAttribute("aria-disabled", "true");
    await expect(next).not.toHaveAttribute("aria-disabled", "true");
    await next.focus();
    for (let i = 0; i < 10 && (await next.getAttribute("aria-disabled")) !== "true"; i++) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
    }
    await expect(next).toHaveAttribute("aria-disabled", "true");
    await expect(next).toBeFocused();
    const end = await track.evaluate((e) => e.scrollLeft);
    await page.keyboard.press("Enter"); // nothing to scroll at the end
    await page.waitForTimeout(100);
    expect(await track.evaluate((e) => e.scrollLeft)).toBe(end);
    await expect(prev).not.toHaveAttribute("aria-disabled", "true");
    await prev.focus();
    for (let i = 0; i < 10 && (await prev.getAttribute("aria-disabled")) !== "true"; i++) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
    }
    await expect(prev).toHaveAttribute("aria-disabled", "true");
    await expect(prev).toBeFocused();
    expect(await track.evaluate((e) => e.scrollLeft)).toBe(0);
  });

  test("Koolituskeskuse lugu and Koolitaja teekond are editorial blocks with a thin rose rule (T3, T4)", async ({ page }) => {
    await page.goto("/koolitaja");
    const story = page.locator("[data-story='center_story']");
    const journey = page.locator("[data-story='trainer_journey']");
    await expect(story.getByRole("heading", { level: 2 })).toHaveText("Koolituskeskuse lugu");
    await expect(story).toContainText("MS LAB ühendab teooria ja praktika.");
    await expect(journey.getByRole("heading", { level: 2 })).toHaveText("Koolitaja teekond");
    await expect(journey).toContainText("Maria täiendab.");
    for (const block of [story, journey]) {
      const rule = await block.evaluate((e) => { const c = getComputedStyle(e); return { w: c.borderTopWidth, c: c.borderTopColor }; });
      expect(rule).toEqual({ w: "1px", c: "rgb(158, 137, 147)" });
    }
    const s = await story.boundingBox(); const j = await journey.boundingBox();
    expect(j!.y).toBeGreaterThan(s!.y);
  });

  test("RU trainer: Russian section names and sample texts (G8); her name in Russian", async ({ page }) => {
    await page.goto("/ru/koolitaja");
    await expect(page.locator("[data-story='center_story'] h2")).toHaveText("История учебного центра");
    await expect(page.locator("[data-story='center_story']")).toContainText("MS LAB объединяет теорию и практику.");
    await expect(page.locator("[data-story='trainer_journey'] h2")).toHaveText("Путь преподавателя");
    await expect(page.locator("[data-story='trainer_journey']")).toContainText("Мария дополнит.");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Мария Соснина");
    await expect(page.locator("[data-works]").getByRole("heading")).toHaveText("Работы преподавателя");
  });
});

test.describe("blog", () => {
  test("list: D grid of cards that open the full post (B1)", async ({ page }) => {
    await page.goto("/uudised");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Uudised ja nõuanded.");
    const cards = page.locator("[data-news-card]");
    await expect(cards).toHaveCount(6);
    await expect(cards.first()).toContainText("22.09.2026 · Nõuanne");
    await expect(cards.first()).toHaveAttribute("href", "/uudised/kuidas-valida-endale-sobiv-kulmukoolitus");
    await cards.nth(2).click();
    await expect(page).toHaveURL(/\/uudised\/praktika-modellidega-mida-oodata$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Praktika modellidega — mida oodata?");
  });

  test("article: crumb, date and category, cover, paragraphs, Loe veel with three other posts", async ({ page }) => {
    await page.goto("/uudised/praktika-modellidega-mida-oodata");
    await expect(page.getByRole("navigation", { name: "Lehe asukoht" }).getByRole("link", { name: "Uudised ja nõuanded" })).toHaveAttribute("href", "/uudised");
    await expect(page.locator("[data-article]")).toContainText("02.09.2026 · Praktika");
    await expect(page.locator("[data-article-cover] img")).toBeVisible();
    await expect(page.locator("[data-article-body] p")).toHaveCount(3);
    await expect(page.locator("[data-article-body] p").first()).toContainText("Kuidas praktikapäev käib");
    const more = page.locator("[data-more-posts]");
    await expect(more.getByRole("heading", { name: "Loe veel" })).toBeVisible();
    await expect(more.locator("[data-news-card]")).toHaveCount(3);
    await expect(more.locator("[data-news-card][href='/uudised/praktika-modellidega-mida-oodata']")).toHaveCount(0);
  });

  test("an unknown post is a 404 inside the shell", async ({ page }) => {
    const res = await page.goto("/uudised/olematu-postitus");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Lehte ei leitud" })).toBeVisible();
  });

  test("RU blog: RU interface text and the RU sample posts (G8)", async ({ page }) => {
    await page.goto("/ru/uudised");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Новости и советы.");
    await expect(page.locator("[data-news-card]").first()).toHaveAttribute("href", /^\/ru\/uudised\//);
    await page.goto("/ru/uudised/praktika-modellidega-mida-oodata");
    await expect(page.locator("[data-article]")).toContainText("02.09.2026 · Практика");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Практика на моделях — чего ожидать?");
    await expect(page.locator("[data-article-body] p").first()).toContainText("Как проходит день практики");
    await expect(page.locator("[data-more-posts]").getByRole("heading", { name: "Читайте также" })).toBeVisible();
  });
});

test.describe("contact and legal", () => {
  test("contact page: details from settings and the D contact form", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("contact", info.project.name);
    await page.goto("/kontakt");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Alustame vestlusest.");
    await expect(page.locator("[data-contact-details]").getByRole("link", { name: "info@mslab.ee" })).toHaveAttribute("href", "mailto:info@mslab.ee");
    const form = page.locator("[data-contact-form]");
    await expect(form).toHaveAttribute("method", "post");
    await form.getByRole("button", { name: "Saada" }).click();
    await expect(form.getByLabel("Nimi")).toBeFocused();
    await expect(form.getByLabel("Nimi")).toHaveAttribute("aria-invalid", "true");
    await form.getByLabel("Nimi").fill("Test Õpilane");
    await form.getByLabel("E-post", { exact: true }).fill(addr);
    await form.getByLabel("Sõnum").fill("Tere! Küsimus praktika kohta.");
    await form.getByRole("button", { name: "Saada" }).click();
    await expect(page.getByText("Aitäh! Sinu sõnum on saadetud.")).toBeVisible();
    if (LOCAL_FIXTURES) expect((await storedRequests(addr)).map((r) => r.kind)).toEqual(["contact"]);
  });

  test("privacy and terms render their stored text; the footer links reach them", async ({ page }) => {
    for (const [path, title] of [["/privaatsus", "Privaatsus"], ["/tingimused", "Õppetingimused"]]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(page.locator("[data-legal-body]")).toContainText("Maria täiendab");
    }
    await page.goto("/ru/tingimused");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Условия обучения");
    await page.goto("/konto/sisene");
    // the dev server's indicator sits at the bottom left, over the phone's legal links (the footer's bottom line is 20 px from the page's end)
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    // the legal row's own links: the newsletter line above it has a "Privaatsus" link of its own
    const legal = page.locator("footer [data-footer-legal]");
    await expect(legal.getByRole("link")).toHaveCount(2);
    await legal.getByRole("link", { name: "Privaatsus" }).click();
    await expect(page).toHaveURL(/\/privaatsus$/);
    await page.locator("footer [data-footer-legal]").getByRole("link", { name: "Õppetingimused" }).click();
    await expect(page).toHaveURL(/\/tingimused$/);
  });
});

test("new pages: no horizontal overflow and no console errors", async ({ page }) => {
  const errors = collectErrors(page);
  for (const p of [
    "/koolituskalender",
    "/koolituskalender?linn=tartu",
    "/praktika?pakett=MAXI#taotlus",
    "/koolitaja",
    "/uudised",
    "/uudised/kuidas-valida-endale-sobiv-kulmukoolitus",
    "/kontakt",
    "/privaatsus",
    "/tingimused",
    "/ru/koolituskalender",
    "/ru/praktika",
    "/ru/koolitaja",
  ]) {
    await page.goto(p);
    await page.waitForLoadState("networkidle");
    const w = await page.evaluate(() => window.innerWidth);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), p).toBeLessThanOrEqual(w);
  }
  expect(errors).toEqual([]);
});

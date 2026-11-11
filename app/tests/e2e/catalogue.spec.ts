import { holdBackRouterHistoryPatch, slowScheduler } from "./early-tap";
import { sampleDayMonth } from "./seed-sessions";
import { test, expect } from "./test";

// Catalogue (Task 8): Maria's K1–K13. The first test is the brief's test verbatim; the rest cover the
// remaining checklist items against the seed data (3 contact + 3 e-learning courses).

test("catalogue filters are on separate rows and hybrid has no steps", async ({ page }) => {
  await page.goto("/koolitused");
  const f = await page.locator("[data-filter-row='format']").boundingBox(); const l = await page.locator("[data-filter-row='level']").boundingBox();
  expect(l!.y).toBeGreaterThan(f!.y + f!.height - 1);
  await page.getByRole("button", { name: "E-õpe" }).first().click();
  await expect(page.locator("[data-steps]")).toBeVisible();
  await expect(page.locator("[data-course-card][data-type='contact']")).toHaveCount(0);
  await page.getByRole("button", { name: /Hübriidõpe/ }).click();
  await expect(page.locator("[data-steps]")).toHaveCount(0);
});

test.describe("catalogue", () => {
  test("Kõik shows the three Õppevormid cards; the hybrid card explains only and does not filter (K1, K7, K8)", async ({ page }) => {
    await page.goto("/koolitused");
    const explainer = page.locator("[data-explainer]");
    await expect(explainer.getByText("Õppevormid")).toBeVisible();
    await expect(explainer.locator("[data-format-card]")).toHaveCount(3);
    await expect(page.locator("[data-course-card]")).toHaveCount(6);
    // No hybrid filter chip: the format row has Kõik / E-õpe / Kontaktõpe only (K1).
    await expect(page.locator("[data-filter-row='format'] button")).toHaveText(["Kõik", "E-õpe", "Kontaktõpe"]);
    const hybrid = explainer.locator("[data-format-card='h']");
    await hybrid.click();
    await expect(hybrid).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("[data-hybrid-panel]").getByText(/Hübriidõpe tähendab, et saad e-õpet ja kontaktõpet omavahel kombineerida/)).toBeVisible();
    await expect(page.locator("[data-steps]")).toHaveCount(0);
    await expect(page.locator("[data-hybrid-panel]").getByRole("link")).toHaveCount(0);
    await expect(page.locator("[data-course-card]")).toHaveCount(6);
    expect(new URL(page.url()).search).toBe("");
  });

  test("format and level filters keep the URL (?vorm, ?tase) and survive a reload (K3, K4)", async ({ page }) => {
    await page.goto("/koolitused");
    await page.locator("[data-filter-row='format']").getByRole("button", { name: "Kontaktõpe" }).click();
    await expect(page).toHaveURL(/\?vorm=k$/);
    await expect(page.locator("[data-course-card][data-type='e_learning']")).toHaveCount(0);
    await expect(page.locator("[data-course-card]")).toHaveCount(3);
    await page.locator("[data-filter-row='level']").getByRole("button", { name: "Täiendkoolitused" }).click();
    await expect(page).toHaveURL(/\?vorm=k&tase=taiend$/);
    await expect(page.locator("[data-course-card]")).toHaveCount(1);
    await page.reload();
    await expect(page.locator("[data-course-card]")).toHaveCount(1);
    await expect(page.locator("[data-filter-row='level']").getByRole("button", { name: "Täiendkoolitused" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-steps]")).toBeVisible();
  });

  test("the URL is the source of truth: Back restores the filters, the header link resets them", async ({ page, isMobile }) => {
    await page.goto("/koolitused");
    await page.locator("[data-filter-row='format']").getByRole("button", { name: "Kontaktõpe" }).click();
    await expect(page).toHaveURL(/\/koolitused\?vorm=k$/);
    const search = page.getByRole("searchbox", { name: "Otsi koolitust" });
    await search.fill("kulmu");
    await expect(page).toHaveURL(/\/koolitused\?vorm=k&otsi=kulmu$/);
    await expect(page.locator("[data-course-card]")).toHaveCount(2);
    await page.locator("[data-course-card]").first().click();
    await expect(page).toHaveURL(/\/koolitused\/kulmumeistri-baaskoolitus$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/koolitused\?vorm=k&otsi=kulmu$/);
    await expect(page.locator("[data-filter-row='format']").getByRole("button", { name: "Kontaktõpe" })).toHaveAttribute("aria-pressed", "true");
    await expect(search).toHaveValue("kulmu");
    await expect(page.locator("[data-course-card]")).toHaveCount(2);
    await expect(page.locator("[data-steps]")).toBeVisible();

    if (isMobile) await page.getByRole("button", { name: "Ava menüü" }).click();
    await page.locator("header").getByRole("link", { name: "Koolitused", exact: true }).click();
    await expect(page).toHaveURL(/\/koolitused$/);
    await expect(page.locator("[data-filter-row='format']").getByRole("button", { name: "Kõik" })).toHaveAttribute("aria-pressed", "true");
    await expect(search).toHaveValue("");
    await expect(page.locator("[data-course-card]")).toHaveCount(6);
    await expect(page.locator("[data-explainer] [data-format-card]")).toHaveCount(3);
  });

  test("a chip tapped before Next.js follows history changes still filters, keeps the URL and Back (race of item 5)", async ({ page }) => {
    await holdBackRouterHistoryPatch(page);
    await page.goto("/koolitused");
    await page.locator("[data-filter-row='format']").getByRole("button", { name: "Kontaktõpe" }).click();
    await expect(page).toHaveURL(/\/koolitused\?vorm=k$/);
    await expect(page.locator("[data-course-card]")).toHaveCount(3);
    await expect(page.locator("[data-filter-row='format']").getByRole("button", { name: "Kontaktõpe" })).toHaveAttribute("aria-pressed", "true");
    // the router has the new URL too: the next filter starts from it
    await page.locator("[data-filter-row='level']").getByRole("button", { name: "Täiendkoolitused" }).click();
    await expect(page).toHaveURL(/\/koolitused\?vorm=k&tase=taiend$/);
    await expect(page.locator("[data-course-card]")).toHaveCount(1);
    await page.locator("[data-course-card]").first().click();
    await expect(page).toHaveURL(/\/koolitused\/kulmude-lami$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/koolitused\?vorm=k&tase=taiend$/);
    await expect(page.locator("[data-course-card]")).toHaveCount(1);
    await expect(page.locator("[data-filter-row='level']").getByRole("button", { name: "Täiendkoolitused" })).toHaveAttribute("aria-pressed", "true");
  });

  test("a course card clicked right after a filter still opens, however slow the page's scheduled work is (item 5)", async ({ page }) => {
    await slowScheduler(page, 1500);
    await page.goto("/koolitused");
    await expect(page.locator("[data-course-card]")).toHaveCount(6);
    await page.evaluate(() => ((window as unknown as { __slowScheduler?: boolean }).__slowScheduler = true));
    await page.locator("[data-filter-row='format']").getByRole("button", { name: "Kontaktõpe" }).click();
    await expect(page).toHaveURL(/\/koolitused\?vorm=k$/);
    await page.locator("[data-course-card]", { hasText: "Kulmude LAMI" }).click(); // at once, while React's scheduled work waits
    await expect(page).toHaveURL(/\/koolitused\/kulmude-lami$/, { timeout: 15_000 });
    await page.evaluate(() => ((window as unknown as { __slowScheduler?: boolean }).__slowScheduler = false));
    await page.goBack();
    await expect(page).toHaveURL(/\/koolitused\?vorm=k$/);
    await expect(page.locator("[data-course-card]")).toHaveCount(3);
  });

  test("the hybrid note tapped before Next.js follows history changes still shows all courses (race of item 5)", async ({ page }) => {
    await holdBackRouterHistoryPatch(page);
    await page.goto("/koolitused?vorm=k");
    await page.getByRole("button", { name: /Hübriidõpe/ }).click();
    await expect(page).toHaveURL(/\/koolitused$/);
    await expect(page.locator("[data-course-card]")).toHaveCount(6);
    await expect(page.locator("[data-hybrid-panel]")).toBeVisible();
    await expect(page.locator("[data-hybrid-panel] h2")).toBeFocused();
  });

  test("home links ?vorm=e and level ?tase=baas are honoured on first render", async ({ page }) => {
    await page.goto("/koolitused?vorm=e&tase=baas");
    await expect(page.locator("[data-course-card]")).toHaveCount(2);
    await expect(page.locator("[data-course-card][data-type='contact']")).toHaveCount(0);
    await expect(page.locator("[data-filter-row='format']").getByRole("button", { name: "E-õpe" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "Mis on e-õpe?" })).toBeVisible();
    await expect(page.locator("[data-steps] li").nth(3)).toContainText("Sulle luuakse automaatselt õpilase konto"); // K11
  });

  test("the hybrid note in a format panel switches to all courses with the hybrid explanation", async ({ page }) => {
    await page.goto("/koolitused?vorm=k");
    await page.getByRole("button", { name: /Hübriidõpe/ }).click();
    await expect(page).toHaveURL(/\/koolitused$/);
    await expect(page.locator("[data-course-card]")).toHaveCount(6);
    await expect(page.locator("[data-hybrid-panel]")).toBeVisible();
    await expect(page.locator("[data-hybrid-panel] h2")).toBeFocused();
  });

  test("search filters cards, empty state resets (K13)", async ({ page }) => {
    await page.goto("/koolitused");
    const search = page.getByRole("searchbox", { name: "Otsi koolitust" });
    await search.fill("lami"); // Kulmude LAMI and Ripsmete laminatsiooni alused
    await expect(page.locator("[data-course-card]")).toHaveCount(2);
    await search.fill("KULMUDE lami");
    await expect(page.locator("[data-course-card]")).toHaveCount(1);
    await expect(page.locator("[data-course-card]")).toContainText("Kulmude LAMI");
    await search.fill("sümmeetria");
    await expect(page.locator("[data-course-card]")).toHaveCount(1);
    await search.fill("summeetria"); // diacritics are ignored
    await expect(page.locator("[data-course-card]")).toHaveCount(1);
    await search.fill("zzzz");
    await expect(page.locator("[data-course-card]")).toHaveCount(0);
    await expect(page.getByText("Sobivat koolitust ei leitud")).toBeVisible();
    await page.getByRole("button", { name: "Lähtesta filtrid" }).click();
    await expect(page.locator("[data-course-card]")).toHaveCount(6);
    await expect(search).toHaveValue("");
  });

  test("cards: badge, contact meta with next date and city, e-learning meta (K12)", async ({ page }) => {
    await page.goto("/koolitused");
    const brow = page.locator("[data-course-card]", { hasText: "Kulmumeistri baaskoolitus" });
    await expect(brow.getByText("Populaarne")).toBeVisible();
    const next = sampleDayMonth("kulmumeistri-baaskoolitus", "Pärnu");
    await expect(brow).toContainText(typeof next === "string" ? `${next} · Pärnu` : /\d{2}\.\d{2} · Pärnu/);
    await expect(brow).toHaveAttribute("href", "/koolitused/kulmumeistri-baaskoolitus");
    await expect(page.locator("[data-course-card]", { hasText: "Kulmumeistri e-koolitus" })).toContainText("Veebis · alusta kohe");
    // Catalogue cards are square (1:1).
    const box = await brow.locator("[data-card-photo]").boundingBox();
    expect(Math.abs(box!.width - box!.height)).toBeLessThan(2);
  });

  test("type sizes: heading smaller (K9), intro 17px (K10), explainer text 16px (K6)", async ({ page }) => {
    await page.goto("/koolitused?vorm=e");
    const h1 = await page.getByRole("heading", { level: 1 }).evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    expect(h1).toBeGreaterThanOrEqual(34);
    expect(h1).toBeLessThanOrEqual(52);
    expect(await page.locator("[data-catalogue-intro]").evaluate((e) => getComputedStyle(e).fontSize)).toBe("17px");
    expect(await page.locator("[data-explainer-text]").evaluate((e) => getComputedStyle(e).fontSize)).toBe("16px");
  });

  test("at 390 the level chips stay on one row, ET and RU, as 44 px targets (item 9)", async ({ page, isMobile }) => {
    test.skip(!isMobile, "phone width");
    for (const path of ["/koolitused", "/ru/koolitused"]) {
      await page.goto(path);
      const chips = page.locator("[data-filter-row='level'] button");
      await expect(chips).toHaveCount(3);
      const boxes = await chips.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
      for (const b of boxes) {
        expect(Math.abs(b.top - boxes[0].top), path).toBeLessThan(1); // one row
        expect(b.height, path).toBeGreaterThanOrEqual(44);
        expect(b.width, path).toBeGreaterThanOrEqual(44);
        expect(b.right, path).toBeLessThanOrEqual(390 - 22 + 0.5); // inside the page's side padding
      }
    }
  });

  test("at 390 the area chips are 44 px targets inside the page, ET and RU, a 60-character name wrapping, no horizontal overflow", async ({ page, isMobile }) => {
    test.skip(!isMobile, "phone width");
    const LONG_AREA = "Курсы долговременной укладки и ламинирования бровей и ресниц";
    expect(LONG_AREA).toHaveLength(60);
    for (const path of ["/koolitused", "/ru/koolitused"]) {
      await page.goto(path);
      const chips = page.locator("[data-filter-row='area'] button");
      await expect(chips).toHaveCount(3);
      // an area name of Maria's that long (Russian runs long; the text set in the page, nothing written)
      await chips.last().evaluate((e, name) => (e.textContent = name), LONG_AREA);
      for (const b of await chips.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))) {
        expect(b.height, path).toBeGreaterThanOrEqual(44);
        expect(b.right, path).toBeLessThanOrEqual(390 - 22 + 0.5); // inside the page's side padding
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), path).toBe(true);
    }
  });

  // Course areas (spec 2026-11-11-course-areas-filter-design.md §5.2): the seed's four brow courses „Kulmukoolitused“, Lash Lift BOTOX and
  // „Ripsmete laminatsiooni alused“ „Ripsmekoolitused“.
  test("area filter: after the level chips, ?valdkond with vorm and tase (AND), reload, „Lähtesta filtrid“, unknown values", async ({ page }) => {
    await page.goto("/koolitused");
    const area = page.locator("[data-filter-row='area']");
    const cards = page.locator("[data-course-card]");
    await expect(area).toHaveAttribute("aria-label", "Valdkond");
    await expect(area.locator("button")).toHaveText(["Kõik", "Kulmukoolitused", "Ripsmekoolitused"]);
    await expect(area.locator("button").first()).toHaveAttribute("aria-pressed", "true");
    const level = (await page.locator("[data-filter-row='level']").boundingBox())!;
    expect((await area.boundingBox())!.y).toBeGreaterThan(level.y + level.height - 1);

    await area.getByRole("button", { name: "Ripsmekoolitused" }).click();
    await expect(page).toHaveURL(/\/koolitused\?valdkond=ripsmekoolitused$/);
    await expect(cards).toHaveCount(2);
    await page.locator("[data-filter-row='format']").getByRole("button", { name: "E-õpe" }).click();
    await expect(page).toHaveURL(/\/koolitused\?vorm=e&valdkond=ripsmekoolitused$/);
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText("Ripsmete laminatsiooni alused");
    await page.reload();
    await expect(cards).toHaveCount(1);
    await expect(area.getByRole("button", { name: "Ripsmekoolitused" })).toHaveAttribute("aria-pressed", "true");

    // no advanced lash e-course: the empty state; „Lähtesta filtrid“ clears the area with the rest
    await page.locator("[data-filter-row='level']").getByRole("button", { name: "Täiendkoolitused" }).click();
    await expect(page).toHaveURL(/\/koolitused\?vorm=e&tase=taiend&valdkond=ripsmekoolitused$/);
    await expect(cards).toHaveCount(0);
    await page.getByRole("button", { name: "Lähtesta filtrid" }).click();
    await expect(page).toHaveURL(/\/koolitused$/);
    await expect(cards).toHaveCount(6);
    await expect(area.locator("button").first()).toHaveAttribute("aria-pressed", "true");

    // a link: the brow contact courses; an unknown or old area reads as „Kõik“
    await page.goto("/koolitused?vorm=k&valdkond=kulmukoolitused");
    await expect(cards).toHaveCount(2);
    await page.goto("/koolitused?valdkond=vana-valdkond");
    await expect(cards).toHaveCount(6);
    await expect(area.locator("button").first()).toHaveAttribute("aria-pressed", "true");
  });

  test("RU catalogue: the area chips in Russian, the same slug", async ({ page }) => {
    await page.goto("/ru/koolitused");
    const area = page.locator("[data-filter-row='area']");
    await expect(area).toHaveAttribute("aria-label", "Направление");
    await expect(area.locator("button")).toHaveText(["Все", "Курсы по бровям", "Курсы по ресницам"]);
    await area.getByRole("button", { name: "Курсы по бровям" }).click();
    await expect(page).toHaveURL(/\/ru\/koolitused\?valdkond=kulmukoolitused$/);
    await expect(page.locator("[data-course-card]")).toHaveCount(4);
  });

  test("RU catalogue", async ({ page }) => {
    await page.goto("/ru/koolitused?vorm=k");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Найдите свой курс.");
    await expect(page.locator("[data-course-card]").first()).toHaveAttribute("href", /^\/ru\/koolitused\//);
  });

  test("no horizontal overflow and no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(e.message));
    for (const p of ["/koolitused", "/koolitused?vorm=e", "/ru/koolitused?vorm=k"]) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      const w = await page.evaluate(() => window.innerWidth);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), p).toBeLessThanOrEqual(w);
    }
    expect(errors).toEqual([]);
  });
});

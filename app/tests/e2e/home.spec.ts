import { submitsForms, test, expect } from "./test";
import { LOCAL_FIXTURES, storedRequests, testEmail } from "./fixtures";

// Home page (Task 7): Maria's section decisions H1–H17, G5, K5, K8, K11, K12.
// The first two tests are the brief's tests verbatim; the step-geometry test describes the horizontal row,
// so it runs on desktop. Below 860px the steps are a vertical list (brief) and get their own geometry test.

test("home sections and Maria's hero changes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("BROW & LASH ACADEMY")).toBeVisible();
  await expect(page.getByText(/^01 \/ 0\d$/)).toBeVisible();                                   // A slide counter
  const cal = page.getByRole("link", { name: /Vaata koolituskalendrit/ });
  const s = await cal.evaluate((el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, bw: c.borderTopWidth, r: c.borderTopLeftRadius }; });
  expect(s.bg).toBe("rgba(0, 0, 0, 0)"); expect(s.bw).toBe("1px"); expect(parseFloat(s.r)).toBeGreaterThan(20);
  await expect(page.getByRole("heading", { name: "Kuidas soovid õppida?" })).toBeVisible();
  await page.getByRole("tab", { name: "Hübriidõpe" }).click();
  await expect(page.locator("[data-steps]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Praktika", exact: true })).toBeVisible();
  await expect(page.getByText(/ak$/).first()).toBeVisible();
  await expect(page.getByText("Korduma kippuvad küsimused")).toBeVisible();
  await expect(page.getByText("Ei tea, milline koolitus sobib?")).toBeVisible();
});

test.describe("horizontal steps (860px and wider)", () => {
  test.skip(({ isMobile }) => isMobile, "below 860px the steps are a vertical list: see the next test");

  test("steps are centred and the line passes through circle centres", async ({ page }) => {
    await page.goto("/");
    const geo = await page.locator("[data-steps] li").evaluateAll((lis) => lis.map((li) => {
      const n = li.querySelector("[data-step-num]")!.getBoundingClientRect(); const l = li.getBoundingClientRect();
      const line = li.querySelector("[data-step-line]")?.getBoundingClientRect();
      return { cx: n.left + n.width / 2, lc: l.left + l.width / 2, cy: n.top + n.height / 2, ly: line ? line.top + line.height / 2 : null };
    }));
    for (const g of geo) { expect(Math.abs(g.cx - g.lc)).toBeLessThan(1.5); if (g.ly !== null) expect(Math.abs(g.ly - g.cy)).toBeLessThan(1.5); }
    const box = await page.locator("[data-steps]").boundingBox(); const parent = await page.locator("[data-steps]").evaluate((e) => e.parentElement!.getBoundingClientRect().toJSON());
    expect(Math.abs((box!.x + box!.width / 2) - (parent.x + parent.width / 2))).toBeLessThan(2);   // row centred in its box
  });

  test("the connector runs from circle edge to circle edge (K5)", async ({ page }) => {
    await page.goto("/");
    const geo = await page.locator("[data-steps] li").evaluateAll((lis) => lis.map((li) => {
      const n = li.querySelector("[data-step-num]")!.getBoundingClientRect();
      const line = li.querySelector("[data-step-line]")?.getBoundingClientRect();
      return { left: n.left, right: n.right, line: line ? { left: line.left, right: line.right } : null };
    }));
    expect(geo).toHaveLength(5);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(geo[i].line!.left - geo[i].right)).toBeLessThan(1.5);
      expect(Math.abs(geo[i].line!.right - geo[i + 1].left)).toBeLessThan(1.5);
    }
    expect(geo[4].line).toBeNull();
  });
});

test.describe("vertical steps (below 860px)", () => {
  test.skip(({ isMobile }) => !isMobile, "phone layout only");

  test("the line runs down through the circle centres from circle to circle", async ({ page }) => {
    await page.goto("/");
    const geo = await page.locator("[data-steps] li").evaluateAll((lis) => lis.map((li) => {
      const n = li.querySelector("[data-step-num]")!.getBoundingClientRect();
      const line = li.querySelector("[data-step-line]")?.getBoundingClientRect();
      return { cx: n.left + n.width / 2, top: n.top, bottom: n.bottom, line: line ? { cx: line.left + line.width / 2, top: line.top, bottom: line.bottom } : null };
    }));
    expect(geo).toHaveLength(5);
    for (let i = 0; i < 4; i++) {
      const line = geo[i].line!;
      expect(Math.abs(line.cx - geo[i].cx)).toBeLessThan(1.5);
      expect(Math.abs(line.top - geo[i].bottom)).toBeLessThan(1.5);
      expect(Math.abs(line.bottom - geo[i + 1].top)).toBeLessThan(1.5);
      expect(Math.abs(geo[i].cx - geo[i + 1].cx)).toBeLessThan(1);
    }
    const box = await page.locator("[data-steps]").boundingBox(); const parent = await page.locator("[data-steps]").evaluate((e) => e.parentElement!.getBoundingClientRect().toJSON());
    expect(Math.abs((box!.x + box!.width / 2) - (parent.x + parent.width / 2))).toBeLessThan(2);
  });
});

test.describe("hero behaviour", () => {
  test("slide control changes the slide, the counter and the header tone (H2, G5)", async ({ page }) => {
    await page.goto("/");
    const hero = page.locator("[data-hero]");
    await expect(hero).toHaveAttribute("data-tone", "light");
    await expect(page.locator("html")).toHaveAttribute("data-hero-tone", "light");
    await hero.getByRole("button", { name: "Järgmine slaid" }).click();
    await expect(hero.getByText(/^02 \/ 05$/)).toBeVisible();
    await expect(hero).toHaveAttribute("data-tone", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-hero-tone", "dark");
    await expect.poll(() => page.locator("header").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 255, 255)");
    // the outline button follows the tone: white border on a dark slide (H3)
    const cal = page.getByRole("link", { name: /Vaata koolituskalendrit/ });
    await expect.poll(() => cal.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgb(255, 255, 255)");
    await hero.getByRole("button", { name: "Eelmine slaid" }).click();
    await expect(hero.getByText(/^01 \/ 05$/)).toBeVisible();
    await hero.getByRole("button", { name: "Slaid 5" }).click();
    await expect(hero.getByText(/^05 \/ 05$/)).toBeVisible();
  });

  test("arrow keys move the slides when the hero has focus", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard");
    await page.goto("/");
    const hero = page.locator("[data-hero]");
    await hero.getByRole("button", { name: "Slaid 1" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(hero.getByText(/^02 \/ 05$/)).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(hero.getByText(/^05 \/ 05$/)).toBeVisible();
  });

  test("autoplay advances after 6.5 s and waits while the pointer is on the controls", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover");
    await page.goto("/");
    const hero = page.locator("[data-hero]");
    await page.mouse.move(5, 899); // outside the hero
    await expect(hero.getByText(/^02 \/ 05$/)).toBeVisible({ timeout: 9000 });
    await hero.getByRole("group", { name: "Esiletõstetud koolitused" }).last().hover(); // the slide control
    await expect(hero).toHaveAttribute("data-autoplay", "off");
    await page.waitForTimeout(7500);
    await expect(hero.getByText(/^02 \/ 05$/)).toBeVisible();
    // the picture and the text are not controls: autoplay runs while the pointer rests there
    await page.mouse.move(700, 300);
    await expect(hero).toHaveAttribute("data-autoplay", "on");
    await expect(hero.getByText(/^03 \/ 05$/)).toBeVisible({ timeout: 9000 });
  });

  test("autoplay resumes after a click on the control; only keyboard focus keeps it waiting (item 6)", async ({ page, isMobile }) => {
    test.skip(isMobile, "pointer and keyboard");
    await page.goto("/");
    const hero = page.locator("[data-hero]");
    await hero.getByRole("button", { name: "Järgmine slaid" }).click();
    await expect(hero.getByText(/^02 \/ 05$/)).toBeVisible();
    await expect(hero.getByRole("button", { name: "Järgmine slaid" })).toBeFocused(); // the click focused it…
    await page.mouse.move(5, 899);
    await expect(hero).toHaveAttribute("data-autoplay", "on"); // …but a pointer focus does not stop autoplay
    await expect(hero.getByText(/^03 \/ 05$/)).toBeVisible({ timeout: 9000 });
    // keyboard focus inside the hero waits; leaving the hero lets it go on
    await page.keyboard.press("Shift+Tab");
    await expect(hero).toHaveAttribute("data-autoplay", "off");
    await page.waitForTimeout(7000);
    await expect(hero.getByText(/^03 \/ 05$/)).toBeVisible();
    await page.locator("[data-upcoming], main a").last().focus();
    await expect(hero).toHaveAttribute("data-autoplay", "on");
  });

  test("the slides are a polite live region before a change the visitor makes, and not during autoplay (aria-live)", async ({ page, isMobile }) => {
    await page.goto("/");
    const hero = page.locator("[data-hero]");
    const slides = hero.locator("[data-hero-slides]");
    await expect(hero).toHaveAttribute("data-autoplay", "on");
    await expect(slides).toHaveAttribute("aria-live", "off"); // autoplay running: its changes are not announced
    await expect(hero.locator("img")).toHaveCount(5, { timeout: 10_000 }); // the idle pictures are in: no other DOM changes
    // record aria-live at the very moment the shown slide changes, and the order of all changes in the hero
    await page.evaluate(() => {
      const box = document.querySelector("[data-hero-slides]")!;
      const seen: string[] = [];
      const order: string[] = [];
      Object.assign(window, { __liveAtChange: seen, __order: order });
      new MutationObserver((list) => {
        if (list.some((m) => m.attributeName === "aria-hidden")) seen.push(box.getAttribute("aria-live") ?? "");
      }).observe(box, { subtree: true, attributes: true, attributeFilter: ["aria-hidden"] });
      // MutationObserver records come in the order the DOM changed
      new MutationObserver((list) => {
        for (const m of list)
          order.push(m.attributeName === "aria-live" ? `live:${box.getAttribute("aria-live")}` : `change:${m.type}${m.attributeName ? `:${m.attributeName}` : ""}`);
      }).observe(document.querySelector("[data-hero]")!, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-live", "aria-hidden", "aria-current"] });
    });
    const next = hero.getByRole("button", { name: "Järgmine slaid" });
    if (isMobile) await next.tap();
    else await next.click();
    await expect(hero.getByText(/^02 \/ 05$/)).toBeVisible();
    const seen = await page.evaluate(() => (window as unknown as { __liveAtChange: string[] }).__liveAtChange);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === "polite"), JSON.stringify(seen)).toBe(true); // set before the change, so it is announced
    // the live region turned polite (an attribute change) before any slide or counter change (round-2 item 18)
    const order = await page.evaluate(() => (window as unknown as { __order: string[] }).__order);
    const polite = order.indexOf("live:polite");
    const firstChange = order.findIndex((o) => o.startsWith("change:"));
    expect(polite, JSON.stringify(order)).toBeGreaterThanOrEqual(0);
    expect(firstChange, JSON.stringify(order)).toBeGreaterThan(polite);
    expect(order.slice(0, firstChange).filter((o) => o.startsWith("live:")).at(-1), JSON.stringify(order)).toBe("live:polite");
    if (!isMobile) await page.mouse.move(5, 5); // off the controls
    await expect(hero.getByText(/^03 \/ 05$/)).toBeVisible({ timeout: 9000 }); // autoplay again
    await expect(slides).toHaveAttribute("aria-live", "off");
  });

  test("the pause toggle stops autoplay until pressed again; prev / next do not undo it (WCAG 2.2.2, phone)", async ({ page, isMobile }) => {
    test.skip(!isMobile, "touch: the toggle is the only way to stop it there");
    await page.goto("/");
    const hero = page.locator("[data-hero]");
    const toggle = hero.getByRole("button", { name: "Peata slaidide vahetumine" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    const box = (await toggle.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(hero).toHaveAttribute("data-autoplay", "off");
    await page.waitForTimeout(8000); // longer than one interval (6.5 s)
    await expect(hero.getByText(/^01 \/ 05$/)).toBeVisible();
    await hero.getByRole("button", { name: "Järgmine slaid" }).tap(); // a manual change keeps it paused
    await expect(hero.getByText(/^02 \/ 05$/)).toBeVisible();
    await page.waitForTimeout(7500);
    await expect(hero.getByText(/^02 \/ 05$/)).toBeVisible();
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(hero).toHaveAttribute("data-autoplay", "on");
    await expect(hero.getByText(/^03 \/ 05$/)).toBeVisible({ timeout: 9000 });
  });

  test("the pause toggle has its RU label and is hidden with reduced motion (nothing plays)", async ({ page, browser }) => {
    await page.goto("/ru");
    await expect(page.locator("[data-hero]").getByRole("button", { name: "Остановить смену слайдов" })).toBeVisible();
    const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
    const still = await ctx.newPage();
    await still.goto("/");
    await expect(still.locator("[data-slide-pause]")).toBeHidden();
    await ctx.close();
  });

  test("leaving the home page before the browser is idle cancels the idle callback it asked for (round 2 item 15)", async ({ page }) => {
    await page.addInitScript(() => {
      const asked: number[] = [];
      const cancelled: number[] = [];
      let n = 1000;
      // idle never comes in this test: the callbacks are only recorded
      window.requestIdleCallback = () => (asked.push(++n), n);
      window.cancelIdleCallback = (h: number) => void cancelled.push(h);
      Object.assign(window, { __idle: { asked, cancelled } });
    });
    await page.goto("/");
    await expect(page.locator("[data-hero]")).toHaveAttribute("data-autoplay", /on|off/);
    const idle = () => page.evaluate(() => (window as unknown as { __idle: { asked: number[]; cancelled: number[] } }).__idle);
    await expect.poll(async () => (await idle()).asked.length).toBeGreaterThan(0);
    await page.locator('main a[href="/koolitused"]').first().click(); // a client-side move: the hero unmounts
    await expect(page).toHaveURL(/\/koolitused$/);
    const { asked, cancelled } = await idle();
    expect(cancelled).toContain(asked.at(-1)); // the hero's own handle, through cancelIdleCallback
  });

  test("the page loads the first picture only; the others follow when the browser is idle (lazy, low priority)", async ({ page, request }) => {
    const html = await (await request.get("/")).text();
    const heroHtml = html.slice(html.indexOf("data-hero=\"\""), html.indexOf("data-slide-pause"));
    expect(heroHtml.match(/<img /g) ?? []).toHaveLength(1); // the server sends slide 1's picture only
    await page.goto("/");
    const hero = page.locator("[data-hero]");
    const pictures = hero.locator("[data-hero-slides] > div");
    await expect(hero.locator("img")).toHaveCount(5, { timeout: 10_000 }); // all, once idle: Back / jumps never empty
    expect(await pictures.first().locator("img").getAttribute("loading")).toBe("eager");
    expect(await pictures.first().locator("img").getAttribute("fetchpriority")).toBe("high");
    for (let i = 1; i < 5; i++) {
      expect(await pictures.nth(i).locator("img").getAttribute("loading")).toBe("lazy");
      expect(await pictures.nth(i).locator("img").getAttribute("fetchpriority")).toBe("low");
    }
  });

  test("slide segments are 44 px touch targets at 390 (full-width row under the counter and arrows)", async ({ page, isMobile }) => {
    test.skip(!isMobile, "phone layout");
    await page.goto("/");
    const segments = page.locator("[data-hero]").getByRole("button", { name: /^Slaid \d$/ });
    await expect(segments).toHaveCount(5);
    for (const b of await segments.all()) {
      const box = (await b.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    const counter = (await page.locator("[data-hero]").getByText(/^01 \/ 05$/).boundingBox())!;
    expect((await segments.first().boundingBox())!.y).toBeGreaterThan(counter.y + counter.height); // own row
    await segments.nth(2).tap();
    await expect(page.locator("[data-hero]").getByText(/^03 \/ 05$/)).toBeVisible();
  });

  test("at 2560 the hero text and control sit on the page's 1600 px column", async ({ page, isMobile }) => {
    test.skip(isMobile, "wide screen");
    await page.setViewportSize({ width: 2560, height: 1300 });
    await page.goto("/");
    const hero = page.locator("[data-hero]");
    const column = (2560 - 1600) / 2 + 100; // ui .wrap: 1600 px, padding var(--page) = 100 px
    const counter = (await hero.getByText(/^01 \/ 05$/).boundingBox())!;
    const title = (await hero.getByRole("heading", { level: 1 }).boundingBox())!;
    const next = (await hero.getByRole("button", { name: "Järgmine slaid" }).boundingBox())!;
    expect(Math.round(counter.x)).toBe(column);
    expect(Math.round(title.x)).toBe(column);
    expect(Math.round(next.x + next.width)).toBe(2560 - column);
  });

  test("swipe changes the slide", async ({ page, isMobile }) => {
    test.skip(!isMobile, "touch");
    await page.goto("/");
    const hero = page.locator("[data-hero]");
    await hero.dispatchEvent("touchstart", { touches: [{ identifier: 1, clientX: 300, clientY: 400 }], changedTouches: [{ identifier: 1, clientX: 300, clientY: 400 }] });
    await hero.dispatchEvent("touchend", { touches: [], changedTouches: [{ identifier: 1, clientX: 120, clientY: 410 }] });
    await expect(hero.getByText(/^02 \/ 05$/)).toBeVisible();
  });

  test("autoplay is off with reduced motion", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.waitForTimeout(7500);
    await expect(page.locator("[data-hero]").getByText(/^01 \/ 05$/)).toBeVisible();
    await ctx.close();
  });
});

test("blog carousel arrows keep keyboard focus at the ends (aria-disabled, not disabled) (item 7)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const blog = page.getByRole("region", { name: "Uudised ja nõuanded" });
  const track = blog.getByRole("group", { name: "Postituste karussell" });
  const prev = blog.getByRole("button", { name: "Eelmine" });
  const next = blog.getByRole("button", { name: "Järgmine" });
  await next.scrollIntoViewIfNeeded();
  await expect(prev).toHaveAttribute("aria-disabled", "true");
  expect(await prev.evaluate((b: HTMLButtonElement) => b.disabled)).toBe(false); // focusable
  await next.focus();
  for (let i = 0; i < 10 && (await next.getAttribute("aria-disabled")) !== "true"; i++) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
  }
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(next).toBeFocused();
  const end = await track.evaluate((e) => e.scrollLeft);
  await page.keyboard.press("Enter"); // nothing to scroll at the end
  await page.waitForTimeout(150);
  expect(await track.evaluate((e) => e.scrollLeft)).toBe(end);
  await expect(prev).not.toHaveAttribute("aria-disabled", "true");
});

test.describe("home content from the database", () => {
  test("upcoming strip, course cards with badges, practice, blog and FAQ", async ({ page }) => {
    await page.goto("/");
    // Upcoming strip: next three sessions that are not cancelled (contact courses only).
    const upcoming = page.getByRole("region", { name: "Tulevased koolitused" });
    await expect(upcoming.getByRole("link")).toHaveCount(3);
    await expect(upcoming.getByRole("link").first()).toContainText("Kulmumeistri baaskoolitus");
    await expect(upcoming.getByRole("link").first()).toContainText("Pärnu");
    // Four course cards, both types, badges set by Maria (K12).
    const cards = page.locator("[data-course-card]");
    await expect(cards).toHaveCount(4);
    await expect(page.locator("[data-course-card][data-type='contact']").first()).toBeVisible();
    await expect(page.locator("[data-course-card][data-type='e_learning']").first()).toBeAttached();
    await expect(cards.getByText("Populaarne")).toBeVisible();
    await expect(page.locator("[data-course-card][data-type='e_learning']").first()).toContainText("Veebis · alusta kohe");
    // Practice: "Praktika" first, Pärnu only, duration chips, Jost price, link to the request form.
    const practice = page.locator("[data-practice]");
    await expect(practice.getByText("Individuaalpraktika · ainult Pärnus")).toBeVisible();
    await expect(practice.getByText("≈ 4 ak")).toBeVisible();
    await expect(practice.getByText("≈ 8 ak")).toBeVisible();
    const price = await practice.locator("[data-price]").first().evaluate((el) => { const c = getComputedStyle(el); return { f: c.fontFamily, z: c.fontSize, w: c.fontWeight }; });
    expect(price.f).toMatch(/Jost/i); expect(price.z).toBe("28px"); expect(price.w).toBe("400");
    await expect(practice.getByRole("link", { name: /Registreeru/ }).first()).toHaveAttribute("href", "/praktika?pakett=MINI#taotlus");
    // Blog carousel: cards open the full post (H16).
    const blog = page.getByRole("region", { name: "Uudised ja nõuanded" });
    await expect(blog.getByRole("link", { name: /Kuidas valida endale sobiv kulmukoolitus/ })).toHaveAttribute("href", "/uudised/kuidas-valida-endale-sobiv-kulmukoolitus");
    // FAQ: first answer open, others toggle.
    await expect(page.getByText(/Baaskoolitused on mõeldud alustajatele/)).toBeVisible();
    await page.getByText("Kas modellid tuleb ise leida?").click();
    await expect(page.getByText(/Võid tulla oma modellidega/)).toBeVisible();
  });

  test("formats tabs: e-learning steps verbatim, contact steps, hybrid text only (K8, K11)", async ({ page }) => {
    await page.goto("/");
    const steps = page.locator("[data-steps] li");
    await expect(steps).toHaveCount(5);
    await expect(steps.nth(3)).toContainText("Sulle luuakse automaatselt õpilase konto");
    await page.getByRole("tab", { name: "Kontaktõpe" }).click();
    await expect(steps.first()).toContainText("Vali koolitus ja kuupäev");
    await page.getByRole("tab", { name: "Hübriidõpe" }).click();
    const panel = page.getByRole("tabpanel");
    await expect(panel).toContainText("Hübriidõpe ei ole eraldi valik"); // Maria's sense (K1): combine two courses yourself
    await expect(panel).not.toContainText("Teooria"); // not "theory online + practice on site"
    await expect(panel.getByRole("link")).toHaveCount(0);
    await expect(page.locator("[data-steps]")).toHaveCount(0);
  });

  test("RU format tabs fit at 360 and 390: nothing clipped, nothing to scroll (N3); ET stays on one line", async ({ page }) => {
    for (const [path, names] of [["/ru", ["Онлайн-обучение", "Очное обучение", "Гибридное обучение"]], ["/", ["E-õpe", "Kontaktõpe", "Hübriidõpe"]]] as const) {
      for (const width of [360, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(path);
        const list = page.getByRole("tablist", { name: path === "/" ? "Õppevorm" : undefined }).first();
        await expect(list.getByRole("tab")).toHaveText([...names]);
        const fit = await list.evaluate((e) => {
          const box = e.getBoundingClientRect();
          return {
            scroll: e.scrollWidth - e.clientWidth,
            inside: [...e.children].every((t) => { const r = t.getBoundingClientRect(); return r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && t.scrollWidth <= t.clientWidth; }),
            inWindow: box.left >= 0 && box.right <= innerWidth,
            lines: [...e.children].map((t) => Math.round(t.getBoundingClientRect().height)),
          };
        });
        expect(fit.scroll, `${path} ${width}`).toBeLessThanOrEqual(0);
        expect(fit.inside, `${path} ${width}`).toBe(true);
        expect(fit.inWindow, `${path} ${width}`).toBe(true);
        for (const h of fit.lines) expect(h, `${path} ${width}: tab height`).toBeGreaterThanOrEqual(44);
        if (path === "/") for (const h of fit.lines) expect(h, `${width}: ET tabs on one line`).toBe(44);
      }
    }
  });

  test("the trainer card: D's line and stat labels (C26); on RU her name, text and labels in Russian (G8)", async ({ page }) => {
    await page.goto("/");
    const card = page.locator("[data-trainer-teaser]");
    await expect(card.getByRole("heading", { level: 2 })).toHaveText("Maria Sosnina");
    await expect(card).toContainText("Kulmu- ja ripsmetehnikate meister ja koolitaja. Õpetan nii, nagu oleksin ise tahtnud õppida: selgelt, praktiliselt ja iga õpilase tempos.");
    await expect(card.locator("dd")).toHaveText(["aastat kogemust", "linna", "väikesed grupid"]);
    await page.goto("/ru");
    await expect(card.getByRole("heading", { level: 2 })).toHaveText("Мария Соснина");
    await expect(card).toContainText("Я учу так, как хотела бы учиться сама");
    await expect(card.locator("dd")).toHaveText(["лет опыта", "города", "малые группы"]);
    await expect(page.getByRole("contentinfo")).toContainText("Мария Соснина");
    await expect(page.getByRole("contentinfo")).not.toContainText("Maria Sosnina");
  });

  test("RU home: the sample content is Russian (G8): course cards, badges, practice durations, FAQ, news", async ({ page }) => {
    await page.goto("/ru");
    const main = page.locator("main");
    await expect(main.getByText("Популярное", { exact: true }).first()).toBeVisible(); // the badge
    await expect(main.getByText("Новинка", { exact: true }).first()).toBeVisible();
    await expect(main).toContainText("≈ 4 ак. ч.");
    await expect(main).toContainText("Нужен ли предварительный опыт?");
    await expect(main).not.toContainText("Kas vajan eelnevaid kogemusi?");
    await expect(main).toContainText("Как выбрать подходящий курс по бровям?");
    await expect(main).not.toContainText("Populaarne");
  });

  test("contact form validates and shows the sent state (H15)", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("home-contact", info.project.name);
    await page.goto("/");
    const form = page.locator("[data-contact-form]");
    await form.getByLabel("Nimi").fill("Test Õpilane");
    await form.getByLabel("E-post").fill(addr);
    await form.getByLabel("Sõnum").fill("Olen algaja ja huvitun kulmudest.");
    await form.getByRole("button", { name: "Saada" }).click();
    await expect(page.getByText("Aitäh! Sinu sõnum on saadetud.")).toBeVisible();
    if (LOCAL_FIXTURES)
      expect(await storedRequests(addr)).toEqual([
        { kind: "contact", payload: { name: "Test Õpilane", email: addr, message: "Olen algaja ja huvitun kulmudest.", locale: "et" } },
      ]);
  });

  test("Russian home", async ({ page }) => {
    await page.goto("/ru");
    await expect(page.getByRole("heading", { name: "Как вы хотите учиться?" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Расписание курсов/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Практика", exact: true })).toBeVisible();
  });

  test("no horizontal overflow and no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(e.message));
    for (const p of ["/", "/ru"]) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      const w = await page.evaluate(() => window.innerWidth);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), p).toBeLessThanOrEqual(w);
    }
    expect(errors).toEqual([]);
  });
});

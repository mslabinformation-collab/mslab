import { submitsForms, test, expect } from "./test";
import { LOCAL_FIXTURES, onLocalDb, storedRequests, storedSubscriber, testEmail } from "./fixtures";

// Task 10: the forms store what they are sent (local dev DB), the newsletter in one step (09.10: subscribed at once, the unsubscribe
// link of the welcome mail), honeypot, rate limit,
// and the Task 6 carry-overs (newsletter keeps its state after a failed attempt, announces success, ink focus ring on
// the lilac surface, 44px touch targets). Local `next dev` has no RESEND_API_KEY / TELEGRAM_BOT_TOKEN, so nothing is
// e-mailed (global-setup refuses to run otherwise).

const INK = "rgb(34, 34, 34)";

test.describe("newsletter", () => {
  test("a failed attempt keeps the e-mail; the error is on the e-mail field", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("nl-failed", info.project.name);
    await page.goto("/konto/sisene");
    const footer = page.locator("footer");
    const form = footer.locator("[data-newsletter-form]");
    await expect(form).toHaveAttribute("method", "post");
    const email = footer.getByLabel("Sinu e-post");
    const submit = footer.getByRole("button", { name: "Liitu" });

    await email.fill("vale-aadress");
    await submit.click();
    await expect(email).toBeFocused();
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(email).toHaveAccessibleDescription("Sisesta korrektne e-posti aadress.");
    await expect(email).toHaveValue("vale-aadress"); // React did not reset the form
    await expect(footer.getByRole("checkbox")).toHaveCount(0);

    // a second failed attempt (nothing typed) keeps the form as it is, and the error stays on the e-mail
    await email.fill("");
    await submit.click();
    await expect(email).toBeFocused();
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(email).toHaveValue("");
    if (LOCAL_FIXTURES) expect(await storedSubscriber("vale-aadress")).toBeNull(); // the bad attempts stored nothing

    // the corrected address alone is enough
    await email.fill(addr);
    await submit.click();
    await expect(footer.locator("[data-newsletter-status]")).toContainText("Aitäh, oled liitunud!");
    if (LOCAL_FIXTURES) expect(await storedSubscriber(addr)).toMatchObject({ email: addr, confirmed: true }); // one step: subscribed at once
  });

  test("no consent box: the line under Liitu says signing up is the consent, with the privacy link, in Estonian and Russian", async ({ page }) => {
    const cases = [
      { path: "/konto/sisene", notice: "Liitudes saad MS LABi uudiskirja. Saad igal ajal loobuda.", link: "Privaatsus", href: "/privaatsus", button: "Liitu" },
      { path: "/ru/koolitused", notice: "Подписываясь, вы получаете рассылку MS LAB. Отписаться можно в любой момент.", link: "Конфиденциальность", href: "/ru/privaatsus", button: "Подписаться" },
    ];
    for (const c of cases) {
      await page.goto(c.path);
      const footer = page.locator("footer");
      const form = footer.locator("[data-newsletter-form]");
      await expect(form.getByRole("checkbox")).toHaveCount(0);
      await expect(form.locator("input[name='consent']")).toHaveCount(0);
      const notice = form.locator("[data-newsletter-notice]");
      await expect(notice).toHaveText(`${c.notice} ${c.link}`);
      await expect(notice).toHaveCSS("font-size", "12px");
      // signing up is the consent: a screen reader hears the line on the button (the e-mail field keeps only its own error)
      await expect(form.getByRole("button", { name: c.button })).toHaveAccessibleDescription(`${c.notice} ${c.link}`);
      await expect(form.locator("input[name='email']")).not.toHaveAccessibleDescription(/\S/);
      const link = notice.getByRole("link", { name: c.link });
      await expect(link).toHaveAttribute("href", c.href);
      // directly under the button: the line starts right below the e-mail row
      const button = (await form.getByRole("button", { name: c.button }).boundingBox())!;
      const line = (await notice.boundingBox())!;
      expect(line.y).toBeGreaterThanOrEqual(button.y + button.height);
      expect(line.y - (button.y + button.height)).toBeLessThan(12);
    }
    // the link opens the privacy page
    await page.goto("/konto/sisene");
    await page.locator("footer [data-newsletter-notice]").getByRole("link", { name: "Privaatsus" }).click();
    await expect(page).toHaveURL(/\/privaatsus$/);
    await expect(page.locator("footer [data-newsletter-form]")).toBeVisible();
  });

  test("the line and its link fit 390, 834 and 1440 px wide: no horizontal overflow, the link is a 44px target", async ({ page }) => {
    for (const [path, link] of [["/konto/sisene", "Privaatsus"], ["/ru/koolitused", "Конфиденциальность"]]) {
      for (const [width, height] of [[390, 844], [834, 1112], [1440, 900]]) {
        await page.setViewportSize({ width, height });
        await page.goto(path);
        const notice = page.locator("footer [data-newsletter-notice]");
        await notice.scrollIntoViewIfNeeded();
        const box = (await notice.getByRole("link", { name: link }).boundingBox())!;
        expect(box.height, `${path} at ${width}`).toBeGreaterThanOrEqual(44);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${path} at ${width}`).toBeLessThanOrEqual(0);
        const form = (await page.locator("footer [data-newsletter-form]").boundingBox())!;
        expect(box.x, `${path} at ${width}`).toBeGreaterThanOrEqual(form.x);
        expect(box.x + box.width, `${path} at ${width}`).toBeLessThanOrEqual(form.x + form.width + 1);
      }
    }
  });

  test("sign-up with the e-mail alone: announced in the status region, stored confirmed at once; the unsubscribe link of the welcome mail opens a page, and its button removes the row", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("nl", info.project.name);
    await page.goto("/koolitused");
    const footer = page.locator("footer");
    const status = footer.locator("[data-newsletter-status]");
    // The polite live region is in the page before anything is sent, so its new content is announced.
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toBeEmpty();
    await footer.getByLabel("Sinu e-post").fill(addr.toUpperCase());
    await footer.getByRole("button", { name: "Liitu" }).click();
    await expect(status).toContainText("Aitäh, oled liitunud!");
    await expect(status).toContainText("Saatsime sulle tervituskirja.");
    await expect(status).toBeFocused();

    test.skip(!LOCAL_FIXTURES, "reads the unsubscribe token from the local database");
    const sub = await storedSubscriber(addr); // stored lowercased
    expect(sub).toMatchObject({ email: addr, locale: "et", confirmed: true });
    await page.goto(`/api/newsletter/loobu?t=${sub!.token}`); // the link the welcome mail carries: it only opens a page
    await expect(page.getByRole("heading", { name: "Uudiskirjast loobumine" })).toBeVisible();
    await expect(page.getByText("Vajuta nuppu, et MS LABi uudiskirjast loobuda.")).toBeVisible();
    expect((await storedSubscriber(addr))?.confirmed).toBe(true); // a mail gateway that opens the link unsubscribes no one
    await page.getByRole("button", { name: "Loobu uudiskirjast" }).click();
    const notice = page.locator("[data-flash-notice]");
    await expect(notice).toContainText("Oled uudiskirjast loobunud.");
    await expect(notice).toContainText("Me ei saada sulle enam MS LABi uudiskirja.");
    await expect(notice).toHaveAttribute("role", "status");
    await expect(notice).toHaveAttribute("data-flash-notice", "ok");
    // The notice removes ?uudiskiri from the address, so a reload does not repeat it.
    await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe("/");
    expect(await storedSubscriber(addr)).toBeNull();
    await notice.getByRole("button", { name: "Sulge" }).click();
    await expect(notice).toBeEmpty();
  });

  test("the unsubscribe page fits 390, 834 and 1440 px wide: no horizontal overflow, the button is a 44px target", async ({ page }) => {
    for (const [width, height] of [[390, 844], [834, 1112], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      const res = await page.goto("/api/newsletter/loobu?t=not-a-real-token-0000000000"); // a token that belongs to no row: the page is the same
      // the headers the server really sends: same-origin (never no-referrer: the button's POST would carry Origin: null and be refused), noindex, not cached
      expect(res!.headers()["referrer-policy"], `at ${width}`).toBe("same-origin");
      expect(res!.headers()["x-robots-tag"], `at ${width}`).toBe("noindex, nofollow");
      expect(res!.headers()["cache-control"], `at ${width}`).toBe("no-store");
      const button = page.getByRole("button", { name: "Loobu uudiskirjast" });
      await expect(button).toBeVisible();
      expect((await button.boundingBox())!.height, `at ${width}`).toBeGreaterThanOrEqual(44);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `at ${width}`).toBeLessThanOrEqual(0);
    }
  });

  test("a confirmation link of the old flow still works: the unconfirmed row is confirmed and the notice says so", async ({ page }, info) => {
    test.skip(!LOCAL_FIXTURES, "writes an unconfirmed row to the local database");
    const addr = testEmail("nl-legacy", info.project.name);
    const token = "l".repeat(40) + info.project.name.slice(0, 3).padEnd(3, "x");
    await onLocalDb((sql) => sql`insert into subscribers (email, locale, token) values (${addr}, 'et', ${token})`, { marksPages: false });
    expect((await storedSubscriber(addr))?.confirmed).toBe(false);
    await page.goto(`/api/newsletter/confirm?t=${token}`);
    const notice = page.locator("[data-flash-notice]");
    await expect(notice).toContainText("Tere tulemast MS LABi!");
    await expect(notice).toContainText("Sinu liitumine on kinnitatud.");
    expect((await storedSubscriber(addr))?.confirmed).toBe(true);
  });

  test("signing up again gives the same answer and keeps one row (does not tell whether the address exists)", async ({ page }, info) => {
    submitsForms();
    test.skip(!LOCAL_FIXTURES, "checks the local database");
    const addr = testEmail("nl-again", info.project.name);
    for (let i = 0; i < 2; i++) {
      await page.goto("/uudised");
      const footer = page.locator("footer");
      await footer.getByLabel("Sinu e-post").fill(addr);
      await footer.getByRole("button", { name: "Liitu" }).click();
      await expect(footer.locator("[data-newsletter-status]")).toContainText("Aitäh, oled liitunud!");
    }
    const sub = await storedSubscriber(addr);
    expect(sub?.confirmed).toBe(true);
  });

  test("Russian sign-up: the unsubscribe link lands on /ru with the Russian notice; an unknown one still says so in Estonian; a wrong confirmation link says the link is not valid", async ({ page }, info) => {
    submitsForms();
    test.skip(!LOCAL_FIXTURES, "reads the unsubscribe token from the local database");
    const addr = testEmail("nl-ru", info.project.name);
    await page.goto("/ru/koolitused");
    const footer = page.locator("footer");
    await footer.getByLabel("Ваш e-mail").fill(addr);
    await footer.getByRole("button", { name: "Подписаться" }).click();
    const status = footer.locator("[data-newsletter-status]");
    await expect(status).toContainText("Спасибо, вы подписались!");
    await expect(status).toContainText("Мы отправили вам приветственное письмо.");
    const sub = await storedSubscriber(addr);
    expect(sub).toMatchObject({ locale: "ru", confirmed: true });
    await page.goto(`/api/newsletter/loobu?t=${sub!.token}`);
    await expect(page.getByRole("heading", { name: "Отказ от рассылки" })).toBeVisible(); // the row's language
    await expect(page.getByText("Нажмите кнопку, чтобы отписаться от рассылки MS LAB.")).toBeVisible();
    expect((await storedSubscriber(addr))?.confirmed).toBe(true);
    await page.getByRole("button", { name: "Отписаться от рассылки" }).click();
    const notice = page.locator("[data-flash-notice]");
    await expect(notice).toContainText("Вы отписались от рассылки.");
    await expect(notice).toContainText("Мы больше не будем присылать вам рассылку MS LAB.");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/ru");
    expect(await storedSubscriber(addr)).toBeNull();

    // unsubscribing reveals nothing: an unknown link gets the same answer, in Estonian
    await page.goto("/api/newsletter/loobu?t=not-a-real-token-0000000000");
    await page.getByRole("button", { name: "Loobu uudiskirjast" }).click();
    await expect(page.locator("[data-flash-notice='ok']")).toContainText("Oled uudiskirjast loobunud.");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");

    await page.goto("/api/newsletter/confirm?t=not-a-real-token-0000000000");
    await expect(page.locator("[data-flash-notice='warn']")).toContainText("See kinnituslink ei kehti.");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  });

  test("ink focus ring on the lilac surface; privacy link and login pill at least 44px", async ({ page, isMobile }) => {
    await page.goto("/konto/sisene");
    const footer = page.locator("footer");
    const email = footer.getByLabel("Sinu e-post");
    await email.focus();
    expect(await email.evaluate((e) => getComputedStyle(e).outlineColor)).toBe(INK);
    await page.keyboard.press("Tab"); // the Liitu button
    expect(await footer.getByRole("button", { name: "Liitu" }).evaluate((e) => getComputedStyle(e).outlineColor)).toBe(INK);
    await page.keyboard.press("Tab"); // the privacy link under it (no consent box between)
    const privacy = footer.locator("[data-newsletter-notice]").getByRole("link", { name: "Privaatsus" });
    await expect(privacy).toBeFocused();
    expect(await privacy.evaluate((e) => getComputedStyle(e).outlineColor)).toBe(INK);
    expect((await privacy.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    if (isMobile) {
      await page.locator("header").getByRole("button", { name: "Ava menüü" }).click();
      const login = page.getByRole("dialog").getByRole("link", { name: "Logi sisse" });
      expect((await login.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    } else {
      const login = page.locator("header").getByRole("link", { name: "Logi sisse" });
      expect((await login.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("spam protection", () => {
  test("a filled honeypot looks like success but nothing is stored", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("honeypot", info.project.name);
    await page.goto("/kontakt");
    const form = page.locator("[data-contact-form]");
    await form.getByLabel("Nimi").fill("Robot");
    await form.getByLabel("E-post", { exact: true }).fill(addr);
    await form.getByLabel("Sõnum").fill("Buy now");
    await form.locator("input[name='website']").evaluate((el) => ((el as HTMLInputElement).value = "https://spam.example"));
    await form.getByRole("button", { name: "Saada" }).click();
    await expect(page.getByText("Aitäh! Sinu sõnum on saadetud.")).toBeVisible();
    if (LOCAL_FIXTURES) expect(await storedRequests(addr)).toEqual([]);
  });

  test("5 submissions per form in 10 minutes; the 6th asks to try again later", async ({ page, isMobile }, info) => {
    submitsForms();
    test.skip(isMobile, "the limit is per visitor, not per layout: desktop only");
    test.skip(!LOCAL_FIXTURES, "the visitor address comes from x-forwarded-for only under next dev");
    const addr = testEmail("rate", info.project.name);
    // (the contact form: the cart's interest form is not on the cart while payments are on, and the limit is the same for every form)
    for (let i = 1; i <= 6; i++) {
      await page.goto("/kontakt");
      const form = page.locator("[data-contact-form]");
      await form.getByLabel("Nimi").fill("Test Õpilane");
      await form.getByLabel("E-post", { exact: true }).fill(addr);
      await form.getByLabel("Sõnum").fill(`Küsimus ${i}`);
      await form.getByRole("button", { name: "Saada" }).click();
      if (i <= 5) await expect(page.getByText("Aitäh! Sinu sõnum on saadetud.")).toBeVisible();
      else {
        const error = form.getByRole("alert");
        await expect(error).toHaveText("Liiga palju katseid. Proovi mõne minuti pärast.");
        await expect(error).toBeFocused();
      }
    }
    expect(await storedRequests(addr)).toHaveLength(5);
  });
});

import type { Page } from "@playwright/test";
import { submitsForms, test, expect } from "./test";
import { clientEmail, insertClient, signInAsClient, storedAccess, storedClient } from "./account";
import { LOCAL_FIXTURES, removeClientRows, storedHold, storedPayments, storedRegistrations, storedRequests, storedSubscriber, testEmail } from "./fixtures";
import { E2E_MONTONIO } from "./montonio-values";

// Course pages (Task 8): Maria's P1–P16. The first two tests are the brief's tests, verbatim except:
// - getByLabel("E-post") also matches the footer newsletter's "Sinu e-post", so it is `exact`;
// - the "no E-õpe / Hübriidõpe" check covers the course's own content, not the recommendations at the bottom
//   (controller ruling: other-type courses may be recommended — hybrid in Maria's sense).
// - Task 10: the e-mail is a test-owned address, and the stored row is checked in the local database.
// The rest cover the remaining checklist items against the seed data.

test("e-learning course page", async ({ page }) => {
  await page.goto("/koolitused/kulmumeistri-e-koolitus");
  await expect(page.getByText(/Maksa kohe/)).toBeVisible();
  await expect(page.getByText(/järelmaks/i)).toBeVisible();
  await expect(page.getByText(/Grupikoolitus|Hübriid/)).toHaveCount(0);
  await expect(page.getByText(/praktilise töö hindamine/i)).toBeVisible();
  await expect(page.getByText("Sulle võiksid huvi pakkuda")).toBeVisible();
  await page.locator("[data-gallery-main]").click(); await expect(page.getByRole("dialog")).toBeVisible(); await page.keyboard.press("Escape");
});
test("contact course group registration: the prepayment starts at once at the bank; cancelled there, the registration stays awaiting and the seat is free again (phase 2b)", async ({ page }, info) => {
  submitsForms();
  const addr = testEmail("register", info.project.name);
  await page.goto("/koolitused/kulmumeistri-baaskoolitus");
  await expect(page.locator("#main > :not([data-recommendations])").getByText(/E-õpe|Hübriidõpe/)).toHaveCount(0);
  await page.getByRole("radio", { name: /Grupikoolitus/ }).check();
  await page.locator("[data-session]:not([aria-disabled='true'])").first().click();
  await page.getByLabel("Nimi").fill("Test Õpilane"); await page.getByLabel("E-post", { exact: true }).fill(addr); await page.getByLabel("Telefon").fill("+3725555555");
  await page.getByRole("radio", { name: /50%/ }).check(); await page.getByLabel(/modellide leidmisel/).check(); await page.getByLabel(/tingimustega/).check();
  const session = Number(await page.locator("[data-session][aria-checked='true']").getAttribute("data-session"));
  await page.getByRole("button", { name: "Registreeru" }).click();
  await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
  await expect(page.locator("[data-fake-order]")).toContainText("175.00 EUR");
  await page.getByRole("button", { name: "Katkesta" }).click();
  // the bank sends her back: the return settles the token and lands on the static /makse page with the result in the fragment
  await page.waitForURL(/\/makse#tulemus=katkestatud&liik=registreering&maksa=/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse jäi tegemata.");
  await expect(page.getByRole("link", { name: "Proovi uuesti" })).toHaveAttribute("href", /^\/maksa\/[A-Za-z0-9_-]{43}$/);
  if (LOCAL_FIXTURES) {
    expect(await storedRegistrations(addr)).toEqual([
      { kind: "group", status: "awaiting_prepayment", paidCents: 0, paymentChoice: "half", wantsModelHelp: true, locale: "et", course: "kulmumeistri-baaskoolitus", sessionId: session },
    ]);
    await expect.poll(() => storedPayments(addr)).toEqual([{ kind: "prepayment", status: "failed", amountCents: 17500 }]);
    expect(await storedHold(addr)).toBe(false);
  }
});
test("the newsletter consent ticked on a group registration: a subscriber follows, confirmed at once (one step, 09.10); the message is the group's too (phase 2c)", async ({ page }, info) => {
  test.skip(!LOCAL_FIXTURES, "reads the local database");
  submitsForms();
  const addr = testEmail("register-nl", info.project.name);
  await page.goto("/koolitused/kulmumeistri-baaskoolitus");
  await page.getByRole("radio", { name: /Grupikoolitus/ }).check();
  await page.locator("[data-session]:not([aria-disabled='true'])").first().click();
  await page.getByLabel("Nimi").fill("Test Õpilane"); await page.getByLabel("E-post", { exact: true }).fill(addr); await page.getByLabel("Telefon").fill("+3725555555");
  await page.getByRole("radio", { name: /100%/ }).check(); await page.getByLabel(/tingimustega/).check();
  await page.getByLabel("Soovin MS LABi uudiseid ja pakkumisi").check();
  await page.getByLabel(/Sõnum/).fill("Kood E2E");
  await page.getByRole("button", { name: "Registreeru" }).click();
  await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
  await expect.poll(() => storedSubscriber(addr)).toMatchObject({ email: addr, confirmed: true });
  await page.getByRole("button", { name: "Katkesta" }).click();
  await expect.poll(() => storedHold(addr)).toBe(false);
});

const noErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
};

test.describe("e-learning page", () => {
  test("purchase block: price, pay now default, instalment shown but disabled, Osta kohe → cart (P8, P9)", async ({ page }) => {
    await page.goto("/koolitused/kulmumeistri-e-koolitus");
    const buy = page.locator("[data-buy]");
    await expect(buy).toContainText("190 €");
    await expect(page.getByRole("radio", { name: /Maksa kohe/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /järelmaks/ })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Osta kohe" })).toHaveAttribute("href", "/ostukorv?kursus=kulmumeistri-e-koolitus");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kulmumeistri e-koolitus");
  });

  test("summary column like browmaniac: modules, videos, access, language, trainer link, discount (P3, P7)", async ({ page }) => {
    await page.goto("/koolitused/kulmumeistri-e-koolitus");
    const s = page.locator("[data-course-summary]");
    await expect(s).toContainText("Moodulid");
    await expect(s).toContainText("6");
    await expect(s).toContainText("24");
    await expect(s).toContainText("Õppevideod"); // not "Videotunnid" (N9)
    await expect(s).not.toContainText("Videotunnid");
    await expect(s).toContainText("6 kuud");
    await expect(s).toContainText("ET / RU");
    await expect(s).toContainText("−10% järgmiselt koolituselt");
    await expect(s.getByRole("link", { name: /Maria Sosnina/ })).toHaveAttribute("href", "/koolitaja");
    await expect(page.locator("[data-trainer-card]").getByRole("link")).toHaveAttribute("href", "/koolitaja");
  });

  test("includes list and modules visible but locked, not openable (P8)", async ({ page }) => {
    await page.goto("/koolitused/kulmumeistri-e-koolitus");
    const inc = page.locator("[data-includes]");
    await expect(inc).toContainText("24 õppevideot");
    await expect(inc).toContainText("Teadmiste test");
    await expect(inc).toContainText("Tunnistus pärast edukat lõpetamist");
    const modules = page.locator("[data-modules] li");
    await expect(modules).toHaveCount(6);
    await expect(page.locator("[data-modules] [data-locked]")).toHaveCount(6);
    await expect(page.locator("[data-modules]").getByRole("link")).toHaveCount(0);
    await expect(page.locator("[data-modules]").getByRole("button")).toHaveCount(0);
  });

  test("recommendations are at the very bottom and lead to other courses (P5)", async ({ page }) => {
    await page.goto("/koolitused/kulmumeistri-e-koolitus");
    const rec = page.locator("[data-recommendations]");
    await expect(rec.locator("[data-course-card]")).toHaveCount(3);
    await expect(rec.locator("[data-course-card][href='/koolitused/kulmumeistri-e-koolitus']")).toHaveCount(0);
    const isLast = await rec.evaluate((el) => {
      const main = document.getElementById("main")!;
      const all = Array.from(main.querySelectorAll("section"));
      return all[all.length - 1] === el;
    });
    expect(isLast).toBe(true);
  });
});

test.describe("contact page", () => {
  test("recommendations prefer the same type and fill in with the other type", async ({ page }) => {
    await page.goto("/koolitused/kulmumeistri-baaskoolitus");
    const rec = page.locator("[data-recommendations] [data-course-card]");
    await expect(rec).toHaveCount(3);
    await expect(rec.nth(0)).toHaveAttribute("data-type", "contact");
    await expect(rec.nth(1)).toHaveAttribute("data-type", "contact");
    await expect(rec.nth(2)).toHaveAttribute("data-type", "e_learning");
  });

  test("recommendations never leave one card alone on a row: 3 across at 834, 2 where only 2 fit (N10)", async ({ page, isMobile }) => {
    test.skip(isMobile, "the desktop project sets each width");
    for (const [width, perRow] of [[700, 2], [834, 3], [1024, 3], [1440, 3]] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/koolitused/kulmumeistri-baaskoolitus");
      const rows = await page.locator("[data-recommendations] [data-course-card]").evaluateAll((cards) => {
        const tops = new Map<number, number>();
        for (const c of cards) {
          const r = c.getBoundingClientRect();
          if (r.width) tops.set(Math.round(r.top), (tops.get(Math.round(r.top)) ?? 0) + 1);
        }
        return [...tops.values()];
      });
      expect(rows, `${width}`).toEqual([perRow]);
    }
  });

  test("participation switch: group lists sessions, individual shows the request form (P12, P13)", async ({ page }) => {
    await page.goto("/koolitused/kulmumeistri-baaskoolitus");
    await expect(page.getByRole("radio", { name: /Grupikoolitus/ })).toHaveAccessibleName(/350 €/);
    await expect(page.getByRole("radio", { name: /Individuaalkoolitus/ })).toHaveAccessibleName(/450 €/);
    await expect(page.locator("[data-session]")).toHaveCount(3);
    await expect(page.locator("[data-session]").first()).toContainText("Pärnu");
    await expect(page.locator("[data-session]").first()).toContainText("Vabu kohti");
    await page.getByRole("radio", { name: /Individuaalkoolitus/ }).check();
    await expect(page.locator("[data-session]")).toHaveCount(0);
    await expect(page.getByLabel("Soovitud periood või kuupäev")).toBeVisible();
    await expect(page.getByRole("button", { name: "Saada päring" })).toBeVisible();
    // Time and payment are agreed with Maria afterwards: no payment choice, no prepayment line (no place exists yet).
    const form = page.locator("[data-register-form]");
    await expect(form.getByRole("radio", { name: /100% kohe|50% registreerimisel/ })).toHaveCount(0);
    await expect(form.getByText(/Koht kinnitatakse/)).toHaveCount(0);
    await expect(form.getByLabel(/modellide leidmisel/)).toBeVisible();
    await expect(form.getByLabel("Loo mulle kohe konto MS LAB keskkonda")).toBeVisible();
    await expect(form.getByLabel(/tingimustega/)).toBeVisible();
  });

  test("after a failed submit, focus lands on the first invalid field", async ({ page }) => {
    submitsForms();
    await page.goto("/koolitused/kulmumeistri-baaskoolitus");
    const form = page.locator("[data-register-form]");
    // Group without a date: the date choice comes first.
    await form.getByRole("button", { name: "Registreeru" }).click();
    await expect(page.locator("[data-session]").first()).toBeFocused();
    await expect(page.locator("[role='radiogroup']")).toHaveAttribute("aria-invalid", "true");
    // With a date picked, the first empty field gets focus and describes its error.
    await page.locator("[data-session]").first().click();
    await form.getByRole("button", { name: "Registreeru" }).click();
    const name = form.getByLabel("Nimi");
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveAccessibleDescription("See väli on kohustuslik.");
    // Individual request: the name field is first.
    await page.getByRole("radio", { name: /Individuaalkoolitus/ }).check();
    await form.getByRole("button", { name: "Saada päring" }).press("Enter");
    await expect(form.getByLabel("Nimi")).toBeFocused();
    await form.getByLabel("Nimi").fill("Test");
    await form.getByLabel("E-post", { exact: true }).fill("vale");
    await form.getByRole("button", { name: "Saada päring" }).click();
    await expect(form.getByLabel("E-post", { exact: true })).toBeFocused();
    await expect(form.getByLabel("E-post", { exact: true })).toHaveAccessibleDescription("Sisesta korrektne e-posti aadress.");
  });

  test("forms post (personal data never goes into the URL)", async ({ page }) => {
    await page.goto("/koolitused/kulmumeistri-baaskoolitus");
    await expect(page.locator("[data-register-form]")).toHaveAttribute("method", "post");
    await page.goto("/ostukorv?kursus=kulmumeistri-e-koolitus");
    await expect(page.locator("[data-ecourse-form]")).toHaveAttribute("method", "post");
  });

  test("cancelled sessions are shown but cannot be picked", async ({ page }) => {
    await page.goto("/koolitused/lash-lift-botox");
    const cancelled = page.locator("[data-session][aria-disabled='true']");
    await expect(cancelled).toHaveCount(1);
    await expect(cancelled).toContainText("Tühistatud");
    await cancelled.click({ force: true });
    await expect(cancelled).toHaveAttribute("aria-checked", "false");
  });

  test("sessions are a radio group: arrow keys skip dates that cannot be picked", async ({ page }) => {
    await page.goto("/koolitused/lash-lift-botox");
    const s = page.locator("[data-session]");
    await expect(s).toHaveCount(3); // Tallinn, Viljandi, Tartu (cancelled)
    await s.nth(0).click();
    await expect(s.nth(0)).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowDown");
    await expect(s.nth(1)).toHaveAttribute("aria-checked", "true");
    await expect(s.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowDown"); // the cancelled date is skipped: back to the first
    await expect(s.nth(0)).toHaveAttribute("aria-checked", "true");
    await expect(s.nth(2)).toHaveAttribute("aria-checked", "false");
  });

  test("?sessioon preselects the session (links from home and calendar)", async ({ page }) => {
    await page.goto("/koolitused/kulmumeistri-baaskoolitus");
    const id = await page.locator("[data-session]").nth(1).getAttribute("data-session");
    await page.goto(`/koolitused/kulmumeistri-baaskoolitus?sessioon=${id}`);
    await expect(page.locator(`[data-session='${id}']`)).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radio", { name: /Grupikoolitus/ })).toBeChecked();
  });

  test("form: payment options, models and account checkboxes, prepayment info line (P11, P14, P15, P16)", async ({ page }) => {
    submitsForms();
    await page.goto("/koolitused/kulmumeistri-baaskoolitus");
    const form = page.locator("[data-register-form]");
    await expect(form.getByRole("radio", { name: "100% kohe" })).toBeChecked();
    await expect(form.getByRole("radio", { name: /50% registreerimisel \+ 50% koolituspäeval/ })).toBeVisible();
    // P14: the third way, instalment, is shown but disabled (as on the e-course) with its "later" note
    const instalment = form.getByRole("radio", { name: "Järelmaks — tulekul" });
    await expect(instalment).toBeDisabled();
    await expect(instalment).toHaveAccessibleDescription("See võimalus lisandub hiljem.");
    await form.locator("[data-pay-instalment]").click();
    await expect(instalment).not.toBeChecked();
    await expect(form.getByRole("radio", { name: "100% kohe" })).toBeChecked();
    await expect(form.getByLabel("Loo mulle kohe konto MS LAB keskkonda")).toBeVisible();
    await expect(form.getByLabel("Soovin MS LABi uudiseid ja pakkumisi")).not.toBeChecked(); // phase 2c: unticked
    await expect(form.getByLabel(/Sõnum/)).toBeVisible(); // the optional message, for the group too (the welcome code goes there)
    await expect(form.getByText("Koht kinnitatakse pärast vähemalt 50% ettemaksu laekumist.")).toBeVisible();
    // Submitting without a date and fields shows errors instead of a success screen, and keeps what was chosen.
    await form.getByRole("radio", { name: /50% registreerimisel/ }).check();
    await form.getByLabel(/tingimustega/).check();
    await form.getByRole("button", { name: "Registreeru" }).click();
    await expect(form.getByText("Vali sobiv kuupäev.")).toBeVisible();
    await expect(form.getByLabel("Nimi")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText(/koht kinnitub pärast ettemaksu/)).toHaveCount(0);
    await expect(form.getByLabel(/tingimustega/)).toBeChecked();
    await expect(form.getByRole("radio", { name: /50% registreerimisel/ })).toBeChecked();
    await page.locator("[data-session]").first().click();
    await expect(form.getByText("Vali sobiv kuupäev.")).toHaveCount(0);
  });

  test("individual request is sent", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("individual", info.project.name);
    await page.goto("/koolitused/kulmude-lami");
    await page.getByRole("radio", { name: /Individuaalkoolitus/ }).check();
    const form = page.locator("[data-register-form]");
    await form.getByLabel("Nimi").fill("Test Õpilane");
    await form.getByLabel("E-post").fill(addr);
    await form.getByLabel("Telefon").fill("+3725555555");
    await form.getByLabel("Soovitud periood või kuupäev").fill("Detsembri teine pool");
    await form.getByLabel(/tingimustega/).check();
    await form.getByRole("button", { name: "Saada päring" }).click();
    await expect(page.getByText("Aitäh! Sinu päring on saadetud.")).toBeVisible();
    // A request to Maria (kind individual), not a registration; no payment choice.
    if (LOCAL_FIXTURES) {
      const [request, ...more] = await storedRequests(addr);
      expect(more).toEqual([]);
      expect(request.kind).toBe("individual");
      expect(request.payload).toMatchObject({ course: "kulmude-lami", name: "Test Õpilane", phone: "+3725555555", preferredPeriod: "Detsembri teine pool", wantsModelHelp: false, wantsAccount: false });
      expect(request.payload).not.toHaveProperty("paymentChoice");
      expect(await storedRegistrations(addr)).toEqual([]);
    }
  });

  test("Koolitus sisaldab in Maria's words, models note, programme (P10, P11)", async ({ page }) => {
    await page.goto("/koolitused/kulmumeistri-baaskoolitus");
    const inc = page.locator("[data-includes] li");
    await expect(inc).toHaveCount(8);
    await expect(inc.nth(1)).toHaveText("Praktiline osa, nt töö kahel modellil");
    await expect(page.getByText("Võid tulla oma modellidega; vajadusel aitame leida.")).toBeVisible();
    await expect(page.locator("[data-modules] li")).toHaveCount(4);
    await expect(page.locator("[data-modules] [data-locked]")).toHaveCount(0);
    const s = page.locator("[data-course-summary]");
    await expect(s).toContainText("2 päeva · 16 ak");
    await expect(s).toContainText("Pärnu, Tallinn");
  });
});

test.describe("both types", () => {
  test("share: Web Share API when present, otherwise copy link + toast (P4)", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(() => { Object.defineProperty(navigator, "share", { value: undefined, configurable: true }); });
    await page.goto("/koolitused/kulmude-lami");
    await page.getByRole("button", { name: "Jaga koolitust" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Koolituse link kopeeritud." })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/koolitused\/kulmude-lami$/);

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", { value: async (d: ShareData) => { (window as unknown as { shared: ShareData }).shared = d; }, configurable: true });
    });
    await page.reload();
    await page.getByRole("button", { name: "Jaga koolitust" }).click();
    const shared = await page.evaluate(() => (window as unknown as { shared?: ShareData }).shared);
    expect(shared?.url).toMatch(/\/koolitused\/kulmude-lami$/);
    expect(shared?.title).toBe("Kulmude LAMI");
  });

  test("favourite toggles, says so, and is remembered in this browser across a reload and in Russian (P6)", async ({ page }) => {
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("mslab-fav") ?? "[]"));
    await page.goto("/koolitused/kulmude-lami");
    const fav = page.locator("[data-favourite]");
    await expect(fav).toHaveAttribute("aria-pressed", "false");
    await expect(fav).toHaveText("Lisa lemmikutesse");
    await expect(fav).toHaveAccessibleName("Lisa lemmikutesse");
    await fav.click();
    await expect(fav).toHaveAttribute("aria-pressed", "true");
    await expect(fav).toHaveText("Lemmikutes");
    await expect(fav).toHaveAttribute("title", "Eemalda lemmikutest");
    expect(await stored()).toEqual(["kulmude-lami"]);

    await page.reload();
    await expect(fav).toHaveAttribute("aria-pressed", "true"); // the stored state, shown on load
    await expect(fav).toHaveText("Lemmikutes");
    // another course is not a favourite; the same course in Russian is
    await page.goto("/koolitused/lash-lift-botox");
    await expect(fav).toHaveAttribute("aria-pressed", "false");
    await page.goto("/ru/koolitused/kulmude-lami");
    await expect(fav).toHaveAttribute("aria-pressed", "true");
    await expect(fav).toHaveText("В избранном");

    await fav.click();
    await expect(fav).toHaveAttribute("aria-pressed", "false");
    await expect(fav).toHaveText("В избранное");
    expect(await stored()).toEqual([]);
    await page.reload();
    await expect(fav).toHaveAttribute("aria-pressed", "false");
  });

  test("gallery: main 5:4, thumbnails open the lightbox at that image; arrows, focus trap, Esc (P2)", async ({ page }) => {
    await page.goto("/koolitused/kulmumeistri-baaskoolitus");
    const main = page.locator("[data-gallery-main]");
    const box = await main.boundingBox();
    expect(Math.abs(box!.width / box!.height - 1.25)).toBeLessThan(0.02);
    await expect(page.locator("[data-gallery-thumb]")).toHaveCount(4);
    await page.locator("[data-gallery-thumb]").nth(2).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("3 / 4")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(dialog.getByText("4 / 4")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(dialog.getByText("1 / 4")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(dialog.getByText("4 / 4")).toBeVisible();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("[data-gallery-thumb]").nth(2)).toBeFocused();
  });

  test("gallery thumbnail carousel shows 4 thumbnails on desktop, 3 on phones", async ({ page, isMobile }) => {
    await page.goto("/koolitused/kulmumeistri-baaskoolitus");
    const visible = await page.locator("[data-gallery-thumb]").evaluateAll((els) => {
      const track = els[0].closest("[data-gallery-track]")!.getBoundingClientRect();
      return els.filter((e) => { const r = e.getBoundingClientRect(); return r.left >= track.left - 1 && r.right <= track.right + 1; }).length;
    });
    expect(visible).toBe(isMobile ? 3 : 4);
    if (isMobile) {
      const next = page.getByRole("button", { name: "Järgmised pildid" });
      await expect(next).toBeEnabled();
      await next.click();
      await expect(next).toBeDisabled();
    }
  });

  test("gallery thumbnail arrows keep keyboard focus at the end (aria-disabled, not disabled) (item 7)", async ({ page, isMobile }) => {
    test.skip(!isMobile, "the thumbnails scroll on phones (3 of 4 shown)");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/koolitused/kulmumeistri-baaskoolitus");
    const next = page.getByRole("button", { name: "Järgmised pildid" });
    const prev = page.getByRole("button", { name: "Eelmised pildid" });
    await expect(prev).toHaveAttribute("aria-disabled", "true");
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(next).toHaveAttribute("aria-disabled", "true");
    await expect(next).toBeFocused(); // focus stays on the arrow (a disabled button would drop it to the page)
    expect(await next.evaluate((b: HTMLButtonElement) => b.disabled)).toBe(false);
    expect(await next.evaluate((b) => getComputedStyle(b).opacity)).toBe("0.35"); // dimmed, still visible while focused
    await expect(prev).not.toHaveAttribute("aria-disabled", "true");
  });

  test("tags show type, level and language; no hybrid wording on any course page (K1, K2)", async ({ page }) => {
    for (const slug of ["kulmumeistri-baaskoolitus", "lash-lift-botox", "kulmude-lami", "kulmumeistri-e-koolitus", "kulmukuju-ja-summeetria", "ripsmete-laminatsiooni-alused"]) {
      await page.goto(`/koolitused/${slug}`);
      await expect(page.getByText(/hübriid/i), slug).toHaveCount(0);
    }
    const tags = page.locator("[data-course-tags]");
    await expect(tags).toContainText("E-õpe");
    await expect(tags).toContainText("Baaskoolitus");
    await expect(tags).toContainText("ET / RU");
  });

  test("unknown or unpublished slug is a 404", async ({ page }) => {
    const res = await page.goto("/koolitused/ei-ole-olemas");
    expect(res?.status()).toBe(404);
  });

  test("RU course page", async ({ page }) => {
    await page.goto("/ru/koolitused/kulmumeistri-baaskoolitus");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Базовый курс бровиста");
    await expect(page.getByRole("radio", { name: /Групповое обучение/ })).toBeVisible();
  });

  test("no horizontal overflow and no console errors", async ({ page }) => {
    const errors = noErrors(page);
    for (const p of ["/koolitused/kulmumeistri-e-koolitus", "/koolitused/kulmumeistri-baaskoolitus", "/ru/koolitused/lash-lift-botox", "/ostukorv?kursus=kulmumeistri-e-koolitus"]) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      const w = await page.evaluate(() => window.innerWidth);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), p).toBeLessThanOrEqual(w);
    }
    expect(errors).toEqual([]);
  });
});

test.describe("cart (/ostukorv)", () => {
  test("summarises the e-course; the purchase form — name, e-mail, the terms, the newsletter box — and 'Maksa 190 €' goes to the bank (phase 2b, D3)", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("buy", info.project.name);
    await page.goto("/ostukorv?kursus=kulmumeistri-e-koolitus");
    await expect(page.getByRole("heading", { name: "Kulmumeistri e-koolitus" })).toBeVisible();
    await expect(page.locator("[data-cart-summary]")).toContainText("190 €");
    const form = page.locator("[data-ecourse-form]");
    await form.getByRole("button", { name: "Maksa 190 €" }).click(); // empty: the focus on the name, with its error
    await expect(form.getByLabel("Nimi")).toBeFocused();
    await expect(form.getByLabel("Nimi")).toHaveAttribute("aria-invalid", "true");
    await form.getByLabel("Nimi").fill("Test Ostja");
    await form.getByLabel("E-post").fill(addr);
    await expect(form.getByLabel("Soovin MS LABi uudiseid ja pakkumisi")).not.toBeChecked();
    await form.getByLabel(/tingimustega/).check();
    await form.getByRole("button", { name: "Maksa 190 €" }).click();
    await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
    await page.getByRole("button", { name: "Katkesta" }).click();
    await page.waitForURL(/\/makse#tulemus=katkestatud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus/);
    await expect(page.getByRole("link", { name: "Proovi uuesti" })).toHaveAttribute("href", "/ostukorv?kursus=kulmumeistri-e-koolitus");
    if (LOCAL_FIXTURES) expect(await storedPayments(addr)).toEqual([{ kind: "ecourse", status: "failed", amountCents: 19000 }]);
  });

  test("the cart does not show the 'payment opens soon' text while payments are on, and the RU cart has the same form", async ({ page }) => {
    await page.goto("/ostukorv?kursus=kulmumeistri-e-koolitus");
    await expect(page.getByText(/Makse lisandub peagi/)).toHaveCount(0);
    await expect(page.locator("[data-interest-form]")).toHaveCount(0);
    await page.goto("/ru/ostukorv?kursus=kulmumeistri-e-koolitus");
    const form = page.locator("[data-ecourse-form]");
    await expect(form.getByLabel("Имя")).toBeVisible();
    await expect(form.getByRole("button", { name: "Оплатить 190 €" })).toBeVisible();
    await expect(form.locator("input[name='locale']")).toHaveValue("ru");
  });

  test("paid at the bank: the course opens for the buyer (by payment), and she lands on 'Makse õnnestus.' (phase 2b)", async ({ page }, info) => {
    submitsForms();
    test.skip(!LOCAL_FIXTURES, "reads the local database");
    const addr = clientEmail("buy", info.project.name); // a sample address: never mailed; its rows are removed with the account tests'
    try {
      await removeClientRows(addr);
      await page.goto("/ostukorv?kursus=kulmumeistri-e-koolitus");
      const form = page.locator("[data-ecourse-form]");
      await form.getByLabel("Nimi").fill("Test Ostja");
      await form.getByLabel("E-post").fill(addr);
      await form.getByLabel(/tingimustega/).check();
      await form.getByRole("button", { name: "Maksa 190 €" }).click();
      await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
      await expect(page.locator("[data-fake-order]")).toContainText("190.00 EUR");
      await page.getByRole("button", { name: "Makstud" }).click();
      await page.waitForURL(/\/makse#tulemus=makstud&liik=ekoolitus&kursus=kulmumeistri-e-koolitus/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Makse õnnestus.");
      await expect(page.getByText("Saatsime sulle e-postiga sisselogimislingi.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Ava e-koolitus" })).toHaveAttribute("href", "/konto/kursus/kulmumeistri-e-koolitus");
      expect(await storedPayments(addr)).toEqual([{ kind: "ecourse", status: "paid", amountCents: 19000 }]);
      expect(await storedClient(addr)).toMatchObject({ name: "Test Ostja", locale: "et" });
      expect(await storedAccess(addr, "kulmumeistri-e-koolitus")).toMatchObject({ grantedBy: "payment", revoked: false });
      // no session was made by buying: the course is behind her login link, which only the mail carries
      expect((await page.context().cookies()).some((c) => c.name === "__Host-mslab_client")).toBe(false);
    } finally {
      await removeClientRows(addr);
    }
  });

  test("a signed-in browser has her name and e-mail filled in by the browser, not by the page", async ({ page, request }, info) => {
    test.skip(!LOCAL_FIXTURES, "signs in through the local database");
    const addr = clientEmail("cartme", info.project.name);
    try {
      await removeClientRows(addr);
      await insertClient(addr, { name: "Kati Tamm" });
      const anonymous = await (await request.get("/ostukorv?kursus=kulmumeistri-e-koolitus")).text();
      expect(anonymous).not.toContain("Kati Tamm"); // (the page every visitor is given)
      await signInAsClient(page, addr);
      await page.goto("/ostukorv?kursus=kulmumeistri-e-koolitus");
      const form = page.locator("[data-ecourse-form]");
      await expect(form.getByLabel("Nimi")).toHaveValue("Kati Tamm");
      await expect(form.getByLabel("E-post")).toHaveValue(addr);
      await form.getByLabel("Nimi").fill("Kati T."); // what she types is hers
      await expect(form.getByLabel("Nimi")).toHaveValue("Kati T.");
    } finally {
      await removeClientRows(addr);
    }
  });

  test("empty cart without a course or for a contact course", async ({ page }) => {
    for (const p of ["/ostukorv", "/ostukorv?kursus=kulmumeistri-baaskoolitus", "/ostukorv?kursus=ei-ole"]) {
      await page.goto(p);
      await expect(page.getByRole("heading", { name: "Ostukorv on tühi" }), p).toBeVisible();
      await expect(page.getByRole("link", { name: /Vaata e-õppe koolitusi/ })).toHaveAttribute("href", "/koolitused?vorm=e");
    }
  });
});

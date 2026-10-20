import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrowserContext, FrameLocator, Locator, Page } from "@playwright/test";
import { adminReady, signInAsAdmin } from "./admin-login";
import { E2E_CAMPAIGN_PREFIX, insertCampaign, onLocalDb, removeAdminRows, removeCampaignRows, storedCampaigns } from "./fixtures";
import { PROD_ENV } from "./prod-build";
import { DEV_ENV } from "./server";
import { PROD_BUILD } from "./target";
import { smallTargets } from "./targets";
import { expect, submitsForms, test } from "./test";

// Newsletter campaigns, the write / preview / copy path on this machine (newsletter campaigns, Task 5; spec D4, D5; ruling R2; the sending half is
// the 20.10 design's and has its own end-to-end test). What it checks is what Maria sees and what the site stores:
// 1. „Uudiskiri“ is the list of subscribers and its two CSV downloads again, with the tab „Kampaaniad“ beside it;
// 2. Maria writes a campaign with a picture, a code and a button, in both languages: the Estonian and the Russian preview show her texts, the picture
//    (loaded), the code, the button and the footer (why she got the mail, the way out, the school), and „Salvesta“ stores it;
// 3. a campaign that was sent (set in the database, as a send leaves it) is read-only: its sent line, no field to change, and „Kopeeri“ makes a new
//    draft (the first draft's copy, „(koopia)“ after its name) that the list marks „Mustand“ while the sent one keeps its „Saadetud“; one going out
//    (`sending`) is read-only too;
// 4. the screens are looked at in a phone's, a tablet's, an iPad's and a desktop's width (390, 834, 1194, 1440): no sideways scroll, every target 44 px.
// The signed-in tests sign in through the devLink (the production build: a stored link, admin-login.ts) and look at rows each test makes for itself.

const created = { tokens: new Set<string>(), sessions: new Set<string>() };
const names: string[] = [];

test.beforeEach(() => {
  submitsForms();
});
test.afterEach(async () => {
  await removeAdminRows({ tokens: created.tokens, sessions: created.sessions }).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
  // a campaign's name with anything after it ("(koopia)") is removed with it
  for (const name of names.splice(0)) expect(await removeCampaignRows(`${name}%`), `the campaigns of "${name}" left`).toBe(0);
});

const signIn = (page: Page, context: BrowserContext, ip: string) => signInAsAdmin(page, context, ip, created);
const jpeg = (name: string) => ({ name, mimeType: "image/jpeg", buffer: readFileSync(`public/seed/${name}`) });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const CAMPAIGNS = "/admin/uudiskiri?vaade=kampaaniad";
/** The mail's links and logo hang on the server's SITE_URL: the dev server's own address, or the production build's (headers.spec.ts). */
const SITE = PROD_BUILD ? PROD_ENV.SITE_URL : DEV_ENV.SITE_URL;

/** A name for this test's campaign, removed (with its copy) after the test. */
function campaignName(project: string, label: string): string {
  const name = `${E2E_CAMPAIGN_PREFIX} ${label} ${project} ${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  names.push(name);
  return name;
}

/** Types into the language `lang` of an I18nInput (`data-i18n`): it switches to that language first. */
async function fillIn(form: Locator, key: string, lang: "et" | "ru", value: string): Promise<void> {
  const field = form.locator(`[data-i18n="${key}"]`);
  await field.locator("xpath=..").locator(`[data-lang="${lang}"]`).click();
  await form.locator(`[data-i18n="${key}"]`).fill(value);
}

/** Has the picture of this preview frame loaded (a broken image has no width)? */
const pictureLoaded = (frame: FrameLocator) => frame.locator('img[src*="/media/img/"]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);

test.describe("„Uudiskiri“ and „Kampaaniad“", () => {
  test("„Uudiskiri“ is the list and its CSV; nothing of Resend is on it; the tab for the campaigns works", async ({ page, context, visitorIp }) => {
    await signIn(page, context, visitorIp);
    await page.goto("/admin/uudiskiri");
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Uudiskirja tellijad");
    await expect(page.locator('[data-csv="confirmed"]')).toHaveAttribute("href", "/api/admin/subscribers.csv?kinnitatud=1");
    await expect(page.locator('[data-csv="all"]')).toHaveAttribute("href", "/api/admin/subscribers.csv");
    await expect(page.locator("[data-newsletter-sync], [data-sync-off], [data-sync-run], [data-subscriber-suppressed], [data-subscriber-rejected]")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("Resend");
    // the tab for the campaigns is there
    await page.locator("[data-newsletter-views]").getByRole("link", { name: "Kampaaniad" }).click();
    await expect(page).toHaveURL(/\/admin\/uudiskiri\?vaade=kampaaniad$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kampaaniad");
    expect(await noOverflow(page)).toBe(true);
  });

  test("Maria writes a campaign with a picture, a code and a button; both previews show it; a sent one is read-only and „Kopeeri“ makes a draft", async ({ page, context, visitorIp }, info) => {
    const name = campaignName(info.project.name, "kogu tee");
    await signIn(page, context, visitorIp);
    await page.goto(CAMPAIGNS);
    await adminReady(page);
    await page.locator("[data-campaign-new]").click();
    await expect(page).toHaveURL(/kampaania=uus$/);
    const form = page.locator("[data-campaign-form]");
    await expect(form).toHaveAttribute("data-campaign-form", "new");

    await test.step("she writes it: the picture, the texts in Estonian, a code and a button", async () => {
      await form.locator('[data-field="name"]').fill(name);
      await fillIn(form, "subject", "et", "E2E sügispakkumine");
      await fillIn(form, "preheader", "et", "E2E eelvaate rida");
      const image = form.locator('[data-single-image="campaign-image"]');
      await image.locator('input[type="file"]').setInputFiles([jpeg("gift-bag-serum.jpg")]);
      await expect(image.locator("[data-upload-status]")).toHaveText("Pilt lisatud.");
      await expect(image.locator("[data-current-image]")).toHaveAttribute("data-current-image", /^img\/[0-9a-f-]{36}\.jpg$/);
      await fillIn(form, "body", "et", "E2E esimene lõik.\n\nE2E teine lõik.");
      await form.locator('[data-field="code"]').fill("e2e-sugis15");
      await fillIn(form, "buttonLabel", "et", "Vaata koolitusi");
      await form.locator('[data-field="buttonHref"]').fill("/koolitused");
      await expect(form.locator('[data-campaign-count="subject"]')).toHaveText("ET 18 / 150 · RU 0 / 150");
    });

    await test.step("the Estonian preview is the real mail: logo, picture, texts, code, button and the footer", async () => {
      const et = page.frameLocator('[data-campaign-preview-frame="et"]');
      await expect(et.getByText("E2E teine lõik.")).toBeVisible();
      await expect(et.getByText("E2E esimene lõik.")).toBeVisible();
      await expect(et.getByText("E2E-SUGIS15")).toBeVisible();
      await expect(et.locator('img[alt="MS LAB"]')).toHaveAttribute("src", `${SITE}/brand/logo.png`);
      await expect(et.locator('img[src*="/media/img/"]')).toHaveAttribute("src", new RegExp(`^${SITE}/media/img/[0-9a-f-]{36}\\.jpg$`));
      await expect.poll(() => pictureLoaded(et), { message: "the picture of the mail loads" }).toBe(true);
      await expect(et.getByRole("link", { name: "Vaata koolitusi" }).first()).toHaveAttribute("href", `${SITE}/koolitused`);
      await expect(et.getByText("Said selle kirja, sest liitusid MS LAB-i uudiskirjaga.")).toBeVisible();
      await expect(et.getByRole("link", { name: "Loobu uudiskirjast" })).toHaveAttribute("href", `${SITE}/api/newsletter/loobu?proov=1`);
      await expect(page.locator("[data-campaign-preview-subject]")).toHaveText("E2E sügispakkumine");
    });

    await test.step("without a Russian text the Russian subscribers get the Estonian one, under a Russian footer, and the page says so", async () => {
      await page.locator('[data-campaign-preview] [data-lang="ru"]').click();
      await expect(page.locator("[data-campaign-preview-fallback]")).toHaveText("Vene keeles tellijad saavad eestikeelse kirja.");
      const ru = page.frameLocator('[data-campaign-preview-frame="ru"]');
      await expect(ru.getByText("E2E teine lõik.")).toBeVisible();
      await expect(ru.getByText("E2E-SUGIS15")).toBeVisible();
      await expect(ru.getByText("Вы получили это письмо, потому что подписались на рассылку MS LAB.")).toBeVisible();
      await expect(ru.getByRole("link", { name: "Отписаться от рассылки" })).toHaveAttribute("href", `${SITE}/api/newsletter/loobu?proov=1`);
    });

    await test.step("with her Russian texts (and the Russian button label the rule asks for) the Russian preview follows the typing", async () => {
      await fillIn(form, "subject", "ru", "E2E осеннее предложение");
      await fillIn(form, "body", "ru", "E2E первый абзац.\n\nE2E второй абзац.");
      await fillIn(form, "buttonLabel", "ru", "Смотреть курсы");
      const ru = page.frameLocator('[data-campaign-preview-frame="ru"]');
      await expect(ru.getByText("E2E второй абзац.")).toBeVisible();
      await expect(ru.getByText("E2E-SUGIS15")).toBeVisible();
      await expect(ru.getByRole("link", { name: "Смотреть курсы" }).first()).toHaveAttribute("href", `${SITE}/ru/koolitused`);
      await expect(ru.getByText("Вы получили это письмо, потому что подписались на рассылку MS LAB.")).toBeVisible();
      await expect(ru.getByText("E2E teine lõik.")).toHaveCount(0);
      await expect(page.locator("[data-campaign-preview-fallback]")).toHaveCount(0);
      await expect(page.locator("[data-campaign-preview-subject]")).toHaveText("E2E осеннее предложение");
      await expect.poll(() => pictureLoaded(ru), { message: "the picture of the Russian mail loads" }).toBe(true);
    });

    let id!: number;
    await test.step("„Salvesta“ stores a draft; the editor has no sending on it", async () => {
      await page.getByRole("button", { name: "Salvesta" }).click();
      await expect(page).toHaveURL(/kampaania=\d+$/);
      await expect(page.locator("[data-save-status]")).toHaveText("Salvestatud.");
      const [row] = await storedCampaigns(name);
      id = row.id;
      expect(row).toMatchObject({
        status: "draft",
        code: "E2E-SUGIS15",
        subject: { et: "E2E sügispakkumine", ru: "E2E осеннее предложение" },
        body: { et: "E2E esimene lõik.\n\nE2E teine lõik.", ru: "E2E первый абзац.\n\nE2E второй абзац." },
        buttonLabel: { et: "Vaata koolitusi", ru: "Смотреть курсы" },
        buttonHref: "/koolitused",
      });
      expect(row.imageKey).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
      await expect(page.locator(`[data-campaign-row="${id}"] [data-campaign-status]`)).toHaveText("Mustand");
      await expect(page.locator("[data-campaign-send], [data-test-send], [data-send-all]")).toHaveCount(0);
    });

    await test.step("a campaign that was sent (set in the database, as a send leaves it) is read-only", async () => {
      await onLocalDb(
        (sql) => sql`
          update newsletter_campaigns
          set status = 'sent', sent_at = now(), recipients = ${sql.json({ et: 3, ru: 2 })}
          where id = ${id}`,
        { marksPages: false },
      );
      await page.goto(`${CAMPAIGNS}&kampaania=${id}`);
      await adminReady(page);
      const sent = page.locator('[data-campaign-sent="sent"]');
      await expect(sent).toBeVisible();
      await expect(sent.getByRole("heading")).toHaveText(name);
      await expect(page.locator("[data-campaign-sent-line]")).toHaveText(/^Saadetud \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} · 5 tellijale$/);
      await expect(page.locator(`[data-campaign-row="${id}"] [data-campaign-status]`)).toHaveText("Saadetud");
      // nothing to change: no form, no field, no „Salvesta“, no send
      await expect(page.locator("[data-campaign-form]")).toHaveCount(0);
      await expect(page.locator("main input, main textarea, main select")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Salvesta" })).toHaveCount(0);
      await expect(page.locator("[data-send-all], [data-test-send]")).toHaveCount(0);
      await expect(page.getByText("Saadetud kampaaniat ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.")).toBeVisible();
      // the preview of what went stays
      await expect(page.frameLocator('[data-campaign-preview-frame="et"]').getByText("E2E teine lõik.")).toBeVisible();
    });

    await test.step("„Kopeeri“ makes a new draft with the same content; the sent one stays as it was", async () => {
      await page.locator("[data-campaign-copy]").click();
      await expect(page).toHaveURL(/kampaania=\d+$/);
      await expect(page).not.toHaveURL(new RegExp(`kampaania=${id}$`));
      const form = page.locator("[data-campaign-form]");
      await expect(form).not.toHaveAttribute("data-campaign-form", String(id));
      const copyName = `${name} (koopia)`;
      await expect(form.locator('[data-field="name"]')).toHaveValue(copyName);
      await expect(form.locator('[data-field="code"]')).toHaveValue("E2E-SUGIS15");
      await expect(form.locator('[data-field="buttonHref"]')).toHaveValue("/koolitused");
      await expect(form.locator('[data-i18n="subject"]')).toHaveValue("E2E sügispakkumine");
      await expect(form.locator("[data-current-image]")).toHaveAttribute("data-current-image", /^img\/[0-9a-f-]{36}\.jpg$/);
      const [copy] = await storedCampaigns(copyName);
      expect(copy.id).not.toBe(id);
      const [original] = await storedCampaigns(name);
      expect(copy).toMatchObject({ status: "draft", code: original.code, subject: original.subject, body: original.body, buttonLabel: original.buttonLabel, buttonHref: original.buttonHref, imageKey: original.imageKey });
      expect(original.status).toBe("sent"); // frozen
      // the list: the copy is „Mustand“, the sent one is „Saadetud“, and the draft is above it
      await expect(page.locator(`[data-campaign-row="${copy.id}"] [data-campaign-status]`)).toHaveText("Mustand");
      await expect(page.locator(`[data-campaign-row="${id}"] [data-campaign-status]`)).toHaveText("Saadetud");
      const order = await page.locator("[data-campaign-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-campaign-row")));
      expect(order.indexOf(String(copy.id))).toBeLessThan(order.indexOf(String(id)));
      // the sent one opens as before: still read-only
      await page.locator(`[data-campaign-row="${id}"]`).getByRole("link", { name }).click();
      await expect(page.locator('[data-campaign-sent="sent"]')).toBeVisible();
      await expect(page.locator("[data-campaign-form]")).toHaveCount(0);
    });
  });

  test("a campaign that is going out (`sending`) is read-only and can only be copied", async ({ page, context, visitorIp }, info) => {
    const goingName = campaignName(info.project.name, "pooleli");
    const going = await insertCampaign({ name: goingName, status: "sending", recipients: { et: 2, ru: 1 } });
    await signIn(page, context, visitorIp);
    await page.goto(`${CAMPAIGNS}&kampaania=${going}`);
    await adminReady(page);
    await expect(page.locator('[data-campaign-sent="sending"]')).toBeVisible();
    await expect(page.locator(`[data-campaign-row="${going}"] [data-campaign-status]`)).toHaveText("Saatmine pooleli");
    await expect(page.locator("[data-campaign-sent-line]")).toHaveCount(0);
    await expect(page.locator("[data-campaign-form], [data-send-all], [data-test-send]")).toHaveCount(0);
    await expect(page.locator("main input, main textarea, main select")).toHaveCount(0);
    await expect(page.locator("[data-campaign-copy]")).toBeVisible();
    await expect(page.locator("main")).not.toContainText("Resend");
  });

  test("the screens at 390, 834, 1194 and 1440 px — no sideways scroll, every target 44 px", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(isMobile, "sets its own widths: the desktop project only");
    const draft = await insertCampaign({ name: campaignName(info.project.name, "laiused mustand") });
    const sent = await insertCampaign({ name: campaignName(info.project.name, "laiused saadetud"), status: "sent", sentAt: new Date(), recipients: { et: 3, ru: 2 } });
    const going = await insertCampaign({ name: campaignName(info.project.name, "laiused pooleli"), status: "sending", recipients: { et: 3, ru: 2 } });
    await signIn(page, context, visitorIp);
    // `shows`: what the screen must show before it is measured
    const screens = [
      { url: "/admin/uudiskiri", scope: "main", shows: ["[data-newsletter-views]", '[data-csv="all"]'] },
      { url: `${CAMPAIGNS}&kampaania=${draft}`, scope: "main", shows: ["[data-campaign-form]", "[data-campaign-preview-frame]"] },
      { url: `${CAMPAIGNS}&kampaania=${sent}`, scope: "main", shows: ["[data-campaign-sent-line]", "[data-campaign-copy]", "[data-campaign-preview-frame]"] },
      { url: `${CAMPAIGNS}&kampaania=${going}`, scope: "main", shows: ["[data-campaign-read-only]", "[data-campaign-copy]", "[data-campaign-preview-frame]"] },
    ];
    try {
      for (const [width, height] of [
        [390, 844],
        [834, 1112],
        [1194, 834],
        [1440, 900],
      ] as const) {
        await page.setViewportSize({ width, height });
        for (const screen of screens) {
          await page.goto(screen.url);
          await adminReady(page);
          const scope = page.locator(screen.scope);
          for (const part of screen.shows) await expect(scope.locator(part).first()).toBeVisible();
          const where = `${screen.url} at ${width} px`;
          expect(await noOverflow(page), where).toBe(true);
          // (the picture's file field is pressed through its label, as in admin-site.spec.ts)
          expect((await smallTargets(scope)).filter((html) => !html.includes('type="file"')), where).toEqual([]);
        }
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });
});

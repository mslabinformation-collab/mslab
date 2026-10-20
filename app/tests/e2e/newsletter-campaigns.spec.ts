import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrowserContext, FrameLocator, Locator, Page } from "@playwright/test";
import { E2E_CRON_SECRET, LOCAL_ENV } from "../local-secrets";
import { adminReady, signInAsAdmin } from "./admin-login";
import { test } from "./edit-lock";
import { E2E_CAMPAIGN_PREFIX, deliveryCounts, insertCampaign, insertDeliveries, onLocalDb, removeAdminRows, removeCampaignRows, storedCampaigns, storedSubscriber, testEmail } from "./fixtures";
import {
  clearTestRecipients,
  holdNewsletter,
  insertConfirmedSubscribers,
  outboxTo,
  recipientAddresses,
  removeCampaignsById,
  removeSubscribers,
  takeRoom,
  testSubscriber,
  unsubscribeAddress,
} from "./newsletter";
import { PROD_ENV } from "./prod-build";
import { DEV_ENV } from "./server";
import { PROD_BUILD } from "./target";
import { LABELLED, smallPills, smallTargets } from "./targets";
import { expect, submitsForms } from "./test";

// Newsletter campaigns on this machine (newsletter campaigns, Task 5; spec D4, D5; ruling R2; the 20.10 design's sending UI: the progress line and „Peata
// saatmine“, Task 4 of that plan; the real send, Task 5 of that plan). What it checks is what Maria sees and what the site stores:
// 1. „Uudiskiri“ is the list of subscribers and its two CSV downloads again, with the tab „Kampaaniad“ beside it;
// 2. Maria writes a campaign with a picture, a code and a button, in both languages: the Estonian and the Russian preview show her texts, the picture
//    (loaded), the code, the button and the footer (why she got the mail, the way out, the school), and „Salvesta“ stores it;
// 3. a campaign that was sent (set in the database, as a send leaves it) is read-only: its sent line, no field to change, and „Kopeeri“ makes a new
//    draft (the first draft's copy, „(koopia)“ after its name) that the list marks „Mustand“ while the sent one keeps its „Saadetud“; one going out
//    (`sending`) shows its progress line, the failed and unknown counts, and „Peata saatmine“, which asks first and then ends it as sent;
// 4. the screens are looked at in a phone's, a tablet's, an iPad's and a desktop's width (390, 834, 1194, 1440): no sideways scroll, every target 44 px;
// 5. a real send, once (desktop): Maria writes a campaign and sends a test; with 3 test subscribers (reserved example.com addresses) and the room of one
//    campaign's mails a day set to 2 (the settings row newsletter_daily_room, as Dim's check does) „Saada kõigile“ asks, sends the first batch and shows
//    „Saadetud 2 / 3 …“; the daily job (/api/cron/uudiskiri with the e2e servers' CRON_SECRET) sends the third once the row is gone; a second campaign
//    is pressed and stopped with „Peata saatmine“, and a third cannot be pressed meanwhile; the mail program's one-click POST removes a subscriber. The
//    mails are not sent: the e2e servers write a campaign's mails to an outbox file (server/mail-outbox.ts, newsletter.ts readOutbox), so the headers,
//    the languages and the links in them are read from what would have been sent. The screens of that flow are measured at the four widths too.
// The signed-in tests sign in through the devLink (the production build: a stored link, admin-login.ts) and look at rows each test makes for itself. The file
// is one of the edit specs (playwright.config.ts EDITS: after every other test, so that the form and admin tests' subscribers are over): the real send
// mails every confirmed subscriber there is, and the campaigns that are going out are one at a time, so the tests that press, that set a campaign going
// out, and admin-site.spec.ts's sign-ups take turns (newsletter.ts holdNewsletter).

const created = { tokens: new Set<string>(), sessions: new Set<string>() };
const names: string[] = [];
/** The rows of the test that is running by exact id / address (the clean-up deletes exactly these), and what it gives back at the end (the room, the turn at the newsletter). */
const made: { subscribers: string[]; campaigns: number[] } = { subscribers: [], campaigns: [] };
const undo: (() => Promise<unknown>)[] = [];

test.beforeEach(() => {
  submitsForms();
});
test.afterEach(async () => {
  try {
    await removeAdminRows({ tokens: created.tokens, sessions: created.sessions }).catch(() => {});
    created.tokens.clear();
    created.sessions.clear();
    // the press test's rows, by exact id and exact address (deliveries go with their campaign)
    expect(await removeCampaignsById(made.campaigns), "the campaigns of the press test left").toBe(0);
    expect(await removeSubscribers(made.subscribers), "the test subscribers left").toBe(0);
    // a campaign's name with anything after it ("(koopia)") is removed with it
    for (const name of names.splice(0)) expect(await removeCampaignRows(`${name}%`), `the campaigns of "${name}" left`).toBe(0);
  } finally {
    made.campaigns = [];
    made.subscribers = [];
    for (const step of undo.splice(0).reverse()) await step(); // the room put back, the newsletter's turn let go
  }
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

/** Maria's address on the e2e servers (MARIA_EMAIL of .env.example): the first target of „Saada proov“. */
const MARIA = LOCAL_ENV.MARIA_EMAIL;

/**
 * Measures the screen as it is at 390, 834, 1194 and 1440 px (the tablet's both ways): the parts in `shows` are visible, there is no sideways scroll, and
 * every target and every radio's pill is 44 px. The state of the page (an open question) stays as it is; the width goes back to the desktop's after.
 */
async function atEveryWidth(page: Page, label: string, shows: string[]): Promise<void> {
  const scope = page.locator("main");
  try {
    for (const [width, height] of [
      [390, 844],
      [834, 1112],
      [1194, 834],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      for (const part of shows) await expect(scope.locator(part).first(), `${label} at ${width} px`).toBeVisible();
      expect(await noOverflow(page), `${label} at ${width} px: no sideways scroll`).toBe(true);
      expect((await smallTargets(scope)).filter((html) => !LABELLED.test(html)), `${label} at ${width} px: targets`).toEqual([]);
      expect(await smallPills(scope), `${label} at ${width} px: the radios' labels`).toEqual([]);
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
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
    await test.step("„Salvesta“ stores a draft; the editor now has its sends, open", async () => {
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
      await expect(page.locator("[data-campaign-save-first]")).toHaveCount(0);
      await expect(page.locator("[data-test-send]")).toHaveText("Saada proov");
      await expect(page.locator("[data-send-all]")).toHaveText("Saada kõigile");
      await expect(page.locator("[data-test-send]")).not.toHaveAttribute("aria-disabled", "true");
      await expect(page.locator("[data-send-all]")).not.toHaveAttribute("aria-disabled", "true");
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

  test("a campaign that is going out (`sending`) shows its progress and the counts, is read-only, can be copied, and „Peata saatmine“ asks first and ends it", async ({ page, context, visitorIp }, info) => {
    undo.push(await holdNewsletter(info)); // (a campaign going out is the one the daily job takes, and the one a press must not find)
    const goingName = campaignName(info.project.name, "pooleli");
    const going = await insertCampaign({ name: goingName, status: "sending", recipients: { et: 4, ru: 2 } });
    // 3 mails went, 2 wait for the next day, 1 address was refused, 1 mail got no answer
    await insertDeliveries(going, { sent: 3, waiting: 2, failed: 1, unknown: 1 });
    await signIn(page, context, visitorIp);
    await page.goto(`${CAMPAIGNS}&kampaania=${going}`);
    await adminReady(page);
    await expect(page.locator('[data-campaign-sent="sending"]')).toBeVisible();
    await expect(page.locator(`[data-campaign-row="${going}"] [data-campaign-status]`)).toHaveText("Saatmine pooleli");
    // the list row and the card say the same: the progress, from the deliveries
    const progress = "Saadetud 3 / 7 — ülejäänud 2 lähevad järgmisel päeval.";
    await expect(page.locator(`[data-campaign-row="${going}"] [data-campaign-row-line]`)).toHaveText(progress);
    await expect(page.locator("[data-campaign-progress]")).toHaveText(progress);
    await expect(page.locator("[data-campaign-failed]")).toHaveText("Kiri ei läinud 1 aadressile: aadress ei sobinud.");
    await expect(page.locator("[data-campaign-unknown]")).toHaveText("1 kirja kohta pole teada, kas see läks. Neid ei saadeta uuesti.");
    await expect(page.locator("[data-campaign-refused]")).toHaveCount(0);
    await expect(page.locator("[data-campaign-sent-line]")).toHaveCount(0);
    await expect(page.locator("[data-campaign-form], [data-send-all], [data-test-send]")).toHaveCount(0);
    await expect(page.locator("main input, main textarea, main select")).toHaveCount(0);
    await expect(page.locator("[data-campaign-copy]")).toBeVisible();
    await expect(page.locator("main")).not.toContainText("Märgi saatmata");
    expect(await noOverflow(page)).toBe(true);

    await test.step("„Peata saatmine“ asks first; „Ei“ leaves everything as it was", async () => {
      await page.locator("[data-campaign-stop]").click();
      await expect(page.locator("[data-stop-confirm-text]")).toHaveText("Kas peatan saatmise? Veel saatmata 2 kirja ei lähe välja. Seda ei saa tagasi võtta.");
      await expect(page.locator("[data-stop-confirm-text]")).toBeFocused();
      await page.locator("[data-stop-no]").click();
      await expect(page.locator("[data-stop-confirm]")).toHaveCount(0);
      expect(await deliveryCounts(going)).toEqual({ sent: 3, waiting: 2, failed: 1, unknown: 1 });
      expect((await storedCampaigns(goingName))[0].status).toBe("sending");
    });

    await test.step("„Jah, peata“ skips what waits and the campaign is sent with the mails that went", async () => {
      await page.locator("[data-campaign-stop]").click();
      await page.locator("[data-stop-yes]").click();
      // the page is refreshed by the action: the sent state replaces the progress
      await expect(page.locator('[data-campaign-sent="sent"]')).toBeVisible();
      await expect(page.locator("[data-campaign-sent-line]")).toHaveText(/^Saadetud \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} · 3 tellijale$/);
      await expect(page.locator("[data-campaign-progress], [data-campaign-stop]")).toHaveCount(0);
      await expect(page.locator("[data-campaign-failed]")).toHaveText("Kiri ei läinud 1 aadressile: aadress ei sobinud.");
      await expect(page.locator(`[data-campaign-row="${going}"] [data-campaign-status]`)).toHaveText("Saadetud");
      expect(await deliveryCounts(going)).toEqual({ sent: 3, skipped: 2, failed: 1, unknown: 1 });
      expect((await storedCampaigns(goingName))[0].status).toBe("sent");
      await expect(page.locator("[data-campaign-copy]")).toBeVisible();
    });
  });

  test("the press on a real send: 3 subscribers and a room of 2 give „Saadetud 2 / 3“, the daily job sends the third, „Peata saatmine“ ends a second campaign; the mails go to the e2e outbox, never to Resend", async ({ page, context, visitorIp, request, isMobile }, info) => {
    test.skip(isMobile, "presses a real send once, and sets its own widths: the desktop project only");
    test.setTimeout(240_000);
    undo.push(await holdNewsletter(info)); // (a press mails every confirmed subscriber there is, and only one campaign goes out at a time)
    const room = await takeRoom();
    undo.push(room.restore);
    const startedAt = new Date().toISOString();
    const tag = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const subs = [
      testSubscriber(testEmail("kampaania-1", info.project.name), "et"),
      testSubscriber(testEmail("kampaania-2", info.project.name), "ru"),
      testSubscriber(testEmail("kampaania-3", info.project.name), "et"),
    ];
    const [s1, s2, s3] = subs;
    made.subscribers.push(...subs.map((s) => s.email));
    const mailsOfThisRun = (...to: string[]) => outboxTo(...to).filter((m) => m.at >= startedAt);

    await test.step("the list is her own: 3 confirmed test subscribers on reserved example.com addresses, two Estonian and one Russian, and no one else", async () => {
      const foreign = await clearTestRecipients();
      expect(foreign, "the local database has confirmed subscribers of its own: a press would mail them too, and the counts here would not be 3").toEqual([]);
      await insertConfirmedSubscribers(subs);
      expect(await recipientAddresses()).toEqual(subs.map((s) => s.email));
      expect(subs.every((s) => s.email.endsWith("@example.com"))).toBe(true); // (@example.test is a sample address: never mailed)
    });

    await signIn(page, context, visitorIp);
    const name = campaignName(info.project.name, "saatmine");
    let id!: number;
    await test.step("Maria writes the campaign in both languages and saves it", async () => {
      await page.goto(CAMPAIGNS);
      await adminReady(page);
      await page.locator("[data-campaign-new]").click();
      const form = page.locator("[data-campaign-form]");
      await expect(form).toHaveAttribute("data-campaign-form", "new");
      await form.locator('[data-field="name"]').fill(name);
      await fillIn(form, "subject", "et", `E2E saatmine ${tag}`);
      await fillIn(form, "body", "et", "E2E tere!\n\nE2E teine lõik.");
      await fillIn(form, "subject", "ru", `E2E отправка ${tag}`);
      await fillIn(form, "body", "ru", "E2E привет!\n\nE2E второй абзац.");
      await page.locator('[data-campaign-preview] [data-lang="ru"]').click();
      await expect(page.frameLocator('[data-campaign-preview-frame="ru"]').getByText("E2E второй абзац.")).toBeVisible();
      await page.getByRole("button", { name: "Salvesta" }).click();
      await expect(page).toHaveURL(/kampaania=\d+$/);
      await expect(page.locator("[data-save-status]")).toHaveText("Salvestatud.");
      id = (await storedCampaigns(name))[0].id;
      made.campaigns.push(id);
    });

    await test.step("„Saada proov“ goes to the outbox: this server has one, so nothing can reach Resend", async () => {
      await page.locator("[data-test-send]").click();
      await expect(page.locator("[data-test-status]")).toContainText("Proov läks aadressile");
      await expect
        .poll(() => mailsOfThisRun(MARIA).filter((m) => m.subject === `[Proov] E2E saatmine ${tag}`).length, {
          message: "the server under test wrote no mail to the e2e outbox: is it a server you started yourself? Playwright starts its own with the e2e settings (tests/local-secrets.ts E2E_MAIL_OUTBOX): stop yours and run again",
          timeout: 15_000,
        })
        .toBe(1);
    });

    await test.step("„Saada kõigile“ with the room set to 2: the question counts the 3 by language", async () => {
      await room.set(2);
      await page.locator("[data-send-all]").click();
      await expect(page.locator("[data-send-confirm-text]")).toHaveText("Saadad kampaania 3 tellijale (eesti keeles 2, vene keeles 1). Kas saadame?");
      await expect(page.locator("[data-send-confirm-text]")).toBeFocused();
      await atEveryWidth(page, "the confirmation", ["[data-send-confirm-text]", "[data-send-yes]", "[data-send-no]"]);
      await page.locator("[data-send-yes]").click();
    });

    await test.step("the first batch went at once: „Saadetud 2 / 3“ and the third waits for the next day", async () => {
      await expect(page.locator("[data-campaign-progress]")).toHaveText("Saadetud 2 / 3 — ülejäänud 1 lähevad järgmisel päeval.");
      await expect(page.locator(`[data-campaign-row="${id}"] [data-campaign-status]`)).toHaveText("Saatmine pooleli");
      await expect(page.locator(`[data-campaign-row="${id}"] [data-campaign-row-line]`)).toHaveText("Saadetud 2 / 3 — ülejäänud 1 lähevad järgmisel päeval.");
      await expect(page.locator("[data-campaign-stop]")).toBeVisible();
      expect(await deliveryCounts(id)).toEqual({ sent: 2, waiting: 1 });
      expect((await storedCampaigns(name))[0].status).toBe("sending");
      await atEveryWidth(page, "the progress", ["[data-campaign-progress]", "[data-campaign-stop]", "[data-campaign-copy]"]);

      // the two mails that went: in her language, her own way out (the link and the mail program's own button), not marked as tests
      const [first, second] = [mailsOfThisRun(s1.email), mailsOfThisRun(s2.email)];
      expect(first, "one mail to the first subscriber").toHaveLength(1);
      expect(second, "one mail to the second").toHaveLength(1);
      expect(mailsOfThisRun(s3.email), "none to the third yet").toHaveLength(0);
      expect(first[0].subject).toBe(`E2E saatmine ${tag}`);
      expect(second[0].subject).toBe(`E2E отправка ${tag}`);
      for (const [mail, s] of [
        [first[0], s1],
        [second[0], s2],
      ] as const) {
        const own = `${SITE}/api/newsletter/loobu?t=${encodeURIComponent(s.token)}`;
        expect(mail.headers["List-Unsubscribe"], `${s.email}: the mail program's button`).toBe(`<${own}>`);
        expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
        expect(mail.html, `${s.email}: her own link in the mail`).toContain(own);
        expect(mail.text).toContain(own);
      }
      expect(first[0].html).toContain("Loobu uudiskirjast");
      expect(second[0].html).toContain("Отписаться от рассылки");
    });

    await test.step("the daily job: no bearer or a wrong one is 401 and nothing happens", async () => {
      expect((await request.get("/api/cron/uudiskiri")).status()).toBe(401);
      expect((await request.get("/api/cron/uudiskiri", { headers: { authorization: "Bearer not-the-secret" } })).status()).toBe(401);
      expect(await deliveryCounts(id)).toEqual({ sent: 2, waiting: 1 });
    });

    await test.step("the room is still 2 for today: the job sends nothing more and says why", async () => {
      const res = await request.get("/api/cron/uudiskiri", { headers: { authorization: `Bearer ${E2E_CRON_SECRET}` } });
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, campaignId: id, stopped: "room", total: 3, sent: 2, waiting: 1 });
      expect(mailsOfThisRun(s3.email)).toHaveLength(0);
    });

    await test.step("Dim's check: the room row is deleted, the job runs, and the third goes; „Saadetud … · 3 tellijale“", async () => {
      await room.set(null);
      const res = await request.get("/api/cron/uudiskiri", { headers: { authorization: `Bearer ${E2E_CRON_SECRET}` } });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ ok: true, campaignId: id, stopped: null, total: 3, sent: 3, waiting: 0, failed: 0, unknown: 0, skipped: 0 });
      expect(mailsOfThisRun(s3.email), "the third subscriber's mail").toHaveLength(1);
      expect(
        mailsOfThisRun(...subs.map((s) => s.email)).filter((m) => m.subject.includes(tag)),
        "three mails in all, each once",
      ).toHaveLength(3);
      await page.reload();
      await adminReady(page);
      await expect(page.locator('[data-campaign-sent="sent"]')).toBeVisible();
      await expect(page.locator("[data-campaign-sent-line]")).toHaveText(/^Saadetud \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} · 3 tellijale$/);
      await expect(page.locator(`[data-campaign-row="${id}"] [data-campaign-status]`)).toHaveText("Saadetud");
      await expect(page.locator("[data-campaign-progress], [data-campaign-stop]")).toHaveCount(0);
      expect(await deliveryCounts(id)).toEqual({ sent: 3 });
      expect((await storedCampaigns(name))[0]).toMatchObject({ status: "sent" });
      await atEveryWidth(page, "the sent campaign", ["[data-campaign-sent-line]", "[data-campaign-copy]"]);
      // nothing is going out any more: the job has nothing to do
      const idle = await request.get("/api/cron/uudiskiri", { headers: { authorization: `Bearer ${E2E_CRON_SECRET}` } });
      expect(await idle.json()).toEqual({ ok: true, campaignId: null });
    });

    const second = await insertCampaign({ name: campaignName(info.project.name, "teine") });
    const third = await insertCampaign({ name: campaignName(info.project.name, "kolmas") });
    made.campaigns.push(second, third);
    await test.step("a second campaign with the room at 1: „Saadetud 1 / 3“, and a third cannot be pressed while it is going out", async () => {
      await room.set(1);
      const before = mailsOfThisRun(...subs.map((s) => s.email)).length;
      await page.goto(`${CAMPAIGNS}&kampaania=${second}`);
      await adminReady(page);
      await page.locator("[data-send-all]").click();
      await expect(page.locator("[data-send-confirm-text]")).toHaveText("Saadad kampaania 3 tellijale (eesti keeles 2, vene keeles 1). Kas saadame?");
      await page.locator("[data-send-yes]").click();
      await expect(page.locator("[data-campaign-progress]")).toHaveText("Saadetud 1 / 3 — ülejäänud 2 lähevad järgmisel päeval.");
      expect(await deliveryCounts(second)).toEqual({ sent: 1, waiting: 2 });
      expect(mailsOfThisRun(...subs.map((s) => s.email)).length - before, "one more mail went").toBe(1);

      // one campaign at a time: the third says so and opens no question
      await page.goto(`${CAMPAIGNS}&kampaania=${third}`);
      await adminReady(page);
      await page.locator("[data-send-all]").click();
      await expect(page.locator("[data-send-status]")).toHaveText("Eelmine kampaania on veel pooleli — see läheb välja, kui eelmine on saadetud.");
      await expect(page.locator("[data-send-confirm]")).toHaveCount(0);
      expect(await deliveryCounts(third)).toEqual({});
    });

    await test.step("„Peata saatmine“ on the second: the question, then it is sent with the 1 mail that went, and nothing more goes", async () => {
      await page.goto(`${CAMPAIGNS}&kampaania=${second}`);
      await adminReady(page);
      await page.locator("[data-campaign-stop]").click();
      await expect(page.locator("[data-stop-confirm-text]")).toHaveText("Kas peatan saatmise? Veel saatmata 2 kirja ei lähe välja. Seda ei saa tagasi võtta.");
      await atEveryWidth(page, "the question of „Peata saatmine“", ["[data-stop-confirm-text]", "[data-stop-yes]", "[data-stop-no]"]);
      const before = mailsOfThisRun(...subs.map((s) => s.email)).length;
      await page.locator("[data-stop-yes]").click();
      await expect(page.locator('[data-campaign-sent="sent"]')).toBeVisible();
      await expect(page.locator("[data-campaign-sent-line]")).toHaveText(/^Saadetud \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} · 1 tellijale$/);
      expect(await deliveryCounts(second)).toEqual({ sent: 1, skipped: 2 });
      // the job finds nothing going out, and the two that were skipped are mailed by no one
      await room.set(null);
      const idle = await request.get("/api/cron/uudiskiri", { headers: { authorization: `Bearer ${E2E_CRON_SECRET}` } });
      expect(await idle.json()).toEqual({ ok: true, campaignId: null });
      expect(mailsOfThisRun(...subs.map((s) => s.email)).length, "no mail after the stop").toBe(before);
    });

    await test.step("the mail program's own unsubscribe button (RFC 8058): its one-click POST to the address in the first mail's header removes that subscriber", async () => {
      const [mail] = mailsOfThisRun(s1.email).filter((m) => m.subject === `E2E saatmine ${tag}`);
      const res = await request.post(unsubscribeAddress(mail), { form: { "List-Unsubscribe": "One-Click" } });
      expect(res.status()).toBe(200);
      expect(await storedSubscriber(s1.email)).toBeNull();
      expect((await storedSubscriber(s2.email))?.confirmed).toBe(true); // nobody else went
    });
  });

  test("the screens at 390, 834, 1194 and 1440 px — no sideways scroll, every target 44 px", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(isMobile, "sets its own widths: the desktop project only");
    undo.push(await holdNewsletter(info));
    const draft = await insertCampaign({ name: campaignName(info.project.name, "laiused mustand") });
    const sent = await insertCampaign({ name: campaignName(info.project.name, "laiused saadetud"), status: "sent", sentAt: new Date(), recipients: { et: 3, ru: 2 } });
    const sentWithCounts = await insertCampaign({ name: campaignName(info.project.name, "laiused saadetud arvudega"), status: "sent", sentAt: new Date(), recipients: { et: 3, ru: 2 } });
    await insertDeliveries(sentWithCounts, { sent: 5, failed: 2, unknown: 1, skipped: 1 });
    const going = await insertCampaign({ name: campaignName(info.project.name, "laiused pooleli"), status: "sending", recipients: { et: 3, ru: 2 } });
    await insertDeliveries(going, { sent: 3, waiting: 2, failed: 1, unknown: 1 });
    await signIn(page, context, visitorIp);
    // `shows`: what the screen must show before it is measured; `first`: what is pressed first (the question of „Peata saatmine“), then shown too
    const screens: { url: string; scope: string; shows: string[]; first?: { press: string; shows: string } }[] = [
      { url: "/admin/uudiskiri", scope: "main", shows: ["[data-newsletter-views]", '[data-csv="all"]'] },
      { url: `${CAMPAIGNS}&kampaania=${draft}`, scope: "main", shows: ["[data-campaign-form]", "[data-campaign-preview-frame]", "[data-test-send]", "[data-send-all]", "[data-test-locale]"] },
      { url: `${CAMPAIGNS}&kampaania=${sent}`, scope: "main", shows: ["[data-campaign-sent-line]", "[data-campaign-copy]", "[data-campaign-preview-frame]"] },
      { url: `${CAMPAIGNS}&kampaania=${sentWithCounts}`, scope: "main", shows: ["[data-campaign-sent-line]", "[data-campaign-failed]", "[data-campaign-unknown]", "[data-campaign-copy]"] },
      { url: `${CAMPAIGNS}&kampaania=${going}`, scope: "main", shows: ["[data-campaign-progress]", "[data-campaign-failed]", "[data-campaign-unknown]", "[data-campaign-stop]", "[data-campaign-copy]", "[data-campaign-preview-frame]"] },
      { url: `${CAMPAIGNS}&kampaania=${going}`, scope: "main", shows: ["[data-campaign-progress]"], first: { press: "[data-campaign-stop]", shows: "[data-stop-yes]" } },
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
          if (screen.first) {
            await scope.locator(screen.first.press).click();
            await expect(scope.locator(screen.first.shows)).toBeVisible();
          }
          const where = `${screen.url}${screen.first ? ` after ${screen.first.press}` : ""} at ${width} px`;
          expect(await noOverflow(page), where).toBe(true);
          // (the picture's file field and the radios of „Saada proov“ are pressed through their labels, as in admin-site.spec.ts: the labels are measured)
          expect((await smallTargets(scope)).filter((html) => !LABELLED.test(html)), where).toEqual([]);
          expect(await smallPills(scope), `${where}: the radios' labels`).toEqual([]);
        }
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });
});

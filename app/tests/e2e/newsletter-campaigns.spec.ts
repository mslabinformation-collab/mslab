import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrowserContext, FrameLocator, Locator, Page } from "@playwright/test";
import { E2E_CRON_SECRET, LOCAL_ENV } from "../local-secrets";
import { adminReady, editLang, signInAsAdmin } from "./admin-login";
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

// Newsletter letters on this machine (newsletter campaigns, Task 5; spec D4, D5; ruling R2; the 20.10 design's sending UI; admin UX pass piece 3b, Task 6:
// README B5, B9, B17, spec C4, rulings R-g, R-h, the Part 3 frame „B5 Uudiskiri“ and the Part 4 „B5 Kirjad“). What it checks is what Maria sees and what the
// site stores:
// 1. „Uudiskiri“ is the list of subscribers and its two CSV downloads, with the tabs „Tellijad“ | „Kirjad“;
// 2. Maria writes a letter: „Uus kiri +“ makes the draft „Uus kiri“ at once with the cursor in „Nimi“; with a picture, a code and a button, in both
//    languages; the preview shows her texts in the language of the page's switch, the picture (loaded), the code, the button and the footer; the fields
//    autosave (no „Salvesta“) and the sends are open at once;
// 3. „Kustuta mustand“ asks first, deletes the draft and the list says „Mustand kustutatud.“; a sent letter has no such button;
// 4. a letter that was sent (set in the database, as a send leaves it) is read-only: its sent line, no field to change, and „Kopeeri“ makes a new draft
//    („(koopia)“ after its name); one going out (`sending`) shows its progress line, the failed and unknown counts, and „Peata saatmine“, whose
//    ConfirmPanel asks first and which then ends it as sent;
// 5. the screens are looked at in a phone's, a tablet's, an iPad's and a desktop's width (390, 834, 1194, 1440): no sideways scroll, every target 44 px;
//    and on a 375 × 812 phone the list is a screen of its own and a letter has „← Kirjad“, „Muuda | Eelvaade“ and its send buttons at the foot;
// 6. a real send, once (desktop): Maria writes a letter and sends a test; with 3 test subscribers (reserved example.com addresses) and the room of one
//    letter's mails a day set to 2 (the settings row newsletter_daily_room, as Dim's check does) „Saada kõigile (3)“ asks in its ConfirmPanel, sends the
//    first batch and shows „Saadetud 2 / 3 …“; the daily job (/api/cron/uudiskiri with the e2e servers' CRON_SECRET) sends the third once the row is
//    gone; a second letter is pressed and stopped with „Peata saatmine“, and a third cannot be pressed meanwhile; the mail program's one-click POST removes
//    a subscriber. The mails are not sent: the e2e servers write a letter's mails to an outbox file (server/mail-outbox.ts, newsletter.ts readOutbox), so
//    the headers, the languages and the links in them are read from what would have been sent. The screens of that flow are measured at the four widths too.
// The signed-in tests sign in through the devLink (the production build: a stored link, admin-login.ts) and look at rows each test makes for itself (a draft
// „Uus kiri +“ made is removed by its id, whatever its name then). The file is one of the edit specs (playwright.config.ts EDITS: after every other test, so
// that the form and admin tests' subscribers are over): the real send mails every confirmed subscriber there is, and the letters that are going out are one
// at a time, so the tests that press, that set a letter going out, and admin-site.spec.ts's sign-ups take turns (newsletter.ts holdNewsletter).

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
    // the rows by exact id (the drafts „Uus kiri +“ made, the press test's; deliveries go with their letter) and exact address
    expect(await removeCampaignsById(made.campaigns), "the letters of the test left").toBe(0);
    expect(await removeSubscribers(made.subscribers), "the test subscribers left").toBe(0);
    // a letter's name with anything after it ("(koopia)") is removed with it
    for (const name of names.splice(0)) expect(await removeCampaignRows(`${name}%`), `the letters of "${name}" left`).toBe(0);
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

/** A name for this test's letter, removed (with its copy) after the test. */
function campaignName(project: string, label: string): string {
  const name = `${E2E_CAMPAIGN_PREFIX} ${label} ${project} ${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  names.push(name);
  return name;
}

/** The phone's „Muuda | Eelvaade“ (below 900 px the letter shows its fields or its preview; wider, both, and there is no switch). */
async function pane(page: Page, which: "edit" | "preview"): Promise<void> {
  const button = page.locator(`[data-campaign-panes] [data-pane="${which}"]`);
  if (await button.isVisible()) await button.click();
}

/**
 * Types into the language `lang` of an I18nInput (`data-i18n`): the page's ET | RU switch (in the heading, above the form) goes to that language first,
 * and a phone shows the fields („Muuda“).
 */
async function fillIn(form: Locator, key: string, lang: "et" | "ru", value: string): Promise<void> {
  await pane(form.page(), "edit");
  await editLang(form.page(), lang);
  await form.locator(`[data-i18n="${key}"]`).fill(value);
}

/** Opens letter `id` from the list (on a phone the list is a screen of its own: „← Kirjad“ goes to it first). */
async function openFromList(page: Page, id: number): Promise<void> {
  const back = page.locator("[data-campaign-back]");
  if (await back.isVisible()) {
    await back.click();
    await expect(page.locator("[data-campaigns-list]")).toBeVisible();
  }
  await page.locator(`[data-campaign-row="${id}"]`).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`kampaania=${id}$`));
}

/** „Uus kiri +“: the draft is made at once and opens at its own address; its id is the test's (removed after it, whatever its name). */
async function newLetter(page: Page): Promise<{ id: number; form: Locator }> {
  await page.locator("[data-campaign-new]").click();
  await expect(page).toHaveURL(/kampaania=\d+$/);
  const id = Number(new URL(page.url()).searchParams.get("kampaania"));
  made.campaigns.push(id);
  const form = page.locator(`[data-campaign-form="${id}"]`);
  await expect(form).toBeVisible();
  return { id, form };
}

/** The letter as stored, by its id. */
const storedLetter = (id: number) =>
  onLocalDb(
    async (sql) =>
      (
        await sql<{ name: string; subject: unknown; preheader: unknown; body: unknown; status: string; updatedAt: Date }[]>`
          select name, subject, preheader, body, status, updated_at as "updatedAt" from newsletter_campaigns where id = ${id}`
      )[0] ?? null,
    { marksPages: false },
  );

/** The one SaveStatus of the letter's card says everything is stored. */
const allSaved = (page: Page) => expect(page.locator("[data-campaign-form] [data-save-status]")).toHaveAttribute("data-save-kind", "saved");

/** Maria's address on the e2e servers (MARIA_EMAIL of .env.example): the first target of „Saada proov“. */
const MARIA = LOCAL_ENV.MARIA_EMAIL;

/**
 * Measures the screen as it is at 390, 834, 1194 and 1440 px (the tablet's both ways): the parts in `shows` are visible, there is no sideways scroll, and
 * every target is 44 px. The state of the page (an open question) stays as it is; the width goes back to the desktop's after.
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

/** A ConfirmPanel's question and lines, as shown. */
async function panelWords(panel: Locator): Promise<{ question: string; lines: string[] }> {
  return { question: (await panel.locator("p").first().textContent())?.trim() ?? "", lines: (await panel.locator("li").allTextContents()).map((l) => l.trim()) };
}

test.describe("„Uudiskiri“ and „Kirjad“", () => {
  test("„Uudiskiri“ is the list and its CSV; nothing of Resend on it; the tab „Kirjad“ works", async ({ page, context, visitorIp }) => {
    await signIn(page, context, visitorIp);
    await page.goto("/admin/uudiskiri");
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Uudiskirja tellijad");
    await expect(page.locator('[data-csv="confirmed"]')).toHaveAttribute("href", "/api/admin/subscribers.csv?kinnitatud=1");
    await expect(page.locator('[data-csv="all"]')).toHaveAttribute("href", "/api/admin/subscribers.csv");
    await expect(page.locator("[data-newsletter-sync], [data-sync-off], [data-sync-run], [data-subscriber-suppressed], [data-subscriber-rejected]")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("Resend");
    // the tabs „Tellijad“ | „Kirjad“ (the address keeps ?vaade=kampaaniad)
    await expect(page.locator("[data-tab-pills] a")).toHaveText(["Tellijad", "Kirjad"]);
    await page.locator("[data-tab-pills]").getByRole("link", { name: "Kirjad" }).click();
    await expect(page).toHaveURL(/\/admin\/uudiskiri\?vaade=kampaaniad$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kirjad");
    await expect(page.locator("[data-tab-pills] a[aria-current='page']")).toHaveText("Kirjad");
    await expect(page.locator("[data-campaign-new]")).toHaveText("Uus kiri +");
    expect(await noOverflow(page)).toBe(true);
  });

  test("Maria writes a letter: „Uus kiri +“, a picture, a code and a button; the preview follows the page's switch; it autosaves; a sent one is read-only and „Kopeeri“ makes a draft", async ({ page, context, visitorIp }, info) => {
    const name = campaignName(info.project.name, "kogu tee");
    await signIn(page, context, visitorIp);
    await page.goto(CAMPAIGNS);
    await adminReady(page);
    const { id, form } = await newLetter(page);

    await test.step("„Uus kiri +“ made the draft „Uus kiri“ at once (S3-P3-h): the cursor in „Nimi“, the list's row, nothing to save", async () => {
      await expect(form.locator('[data-field="name"]')).toHaveValue("Uus kiri");
      await expect(form.locator('[data-field="name"]')).toBeFocused();
      await expect(page.locator(`[data-campaign-row="${id}"] [data-campaign-row-line]`)).toHaveText(/^Mustand · muudetud \d{2}\.\d{2} \d{2}:\d{2}$/);
      expect(await storedLetter(id)).toMatchObject({ name: "Uus kiri", subject: { et: "", ru: "" }, body: { et: "", ru: "" }, status: "draft" });
      await expect(page.getByRole("button", { name: "Salvesta" })).toHaveCount(0);
    });

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
      await pane(page, "preview");
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
      // the preview has no switch of its own: the page's sets it (ledger L152)
      await expect(page.locator("[data-campaign-preview] [data-lang]")).toHaveCount(0);
    });

    await test.step("the page's switch to RU: without a Russian text the Russian subscribers get the Estonian one, under a Russian footer, and the page says so", async () => {
      await editLang(page, "ru");
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
      await pane(page, "preview");
      const ru = page.frameLocator('[data-campaign-preview-frame="ru"]');
      await expect(ru.getByText("E2E второй абзац.")).toBeVisible();
      await expect(ru.getByText("E2E-SUGIS15")).toBeVisible();
      await expect(ru.getByRole("link", { name: "Смотреть курсы" }).first()).toHaveAttribute("href", `${SITE}/ru/koolitused`);
      await expect(ru.getByText("E2E teine lõik.")).toHaveCount(0);
      await expect(page.locator("[data-campaign-preview-fallback]")).toHaveCount(0);
      await expect(page.locator("[data-campaign-preview-subject]")).toHaveText("E2E осеннее предложение");
      await expect.poll(() => pictureLoaded(ru), { message: "the picture of the Russian mail loads" }).toBe(true);
    });

    await test.step("it autosaved (no „Salvesta“): the stored draft is what she typed, and the sends are open at once", async () => {
      await pane(page, "edit");
      await form.locator('[data-field="buttonHref"]').press("Tab"); // (a field left saves at once)
      await expect
        .poll(async () => (await storedCampaigns(name))[0] ?? null, { message: "the letter as typed is stored", timeout: 15_000 })
        .toMatchObject({
          id,
          status: "draft",
          code: "E2E-SUGIS15",
          subject: { et: "E2E sügispakkumine", ru: "E2E осеннее предложение" },
          body: { et: "E2E esimene lõik.\n\nE2E teine lõik.", ru: "E2E первый абзац.\n\nE2E второй абзац." },
          buttonLabel: { et: "Vaata koolitusi", ru: "Смотреть курсы" },
          buttonHref: "/koolitused",
        });
      await allSaved(page);
      expect((await storedCampaigns(name))[0].imageKey).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
      await expect(page.locator(`[data-campaign-row="${id}"] [data-campaign-row-line]`)).toHaveAttribute("data-campaign-status", "draft");
      await expect(page.locator(`[data-campaign-row="${id}"]`)).toContainText(name);
      await expect(page.locator("[data-campaign-save-first]")).toHaveCount(0);
      await expect(page.locator("[data-test-send] [data-label-wide]")).toHaveText("Saada proov");
      await expect(page.locator("[data-test-target] option").first()).toHaveText(`${MARIA} · eesti keeles`);
      await expect(page.locator("[data-send-blocked]")).toHaveCount(0);
      // opened again: the stored fields
      await page.reload();
      await adminReady(page);
      await editLang(page, "et");
      await expect(form.locator('[data-field="name"]')).toHaveValue(name);
      await expect(form.locator('[data-i18n="subject"]')).toHaveValue("E2E sügispakkumine");
    });

    await test.step("a letter that was sent (set in the database, as a send leaves it) is read-only", async () => {
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
      await expect(page.locator(`[data-campaign-row="${id}"] [data-campaign-row-line]`)).toHaveText(/^Saadetud \d{2}\.\d{2} · 5 tellijale$/);
      // nothing to change: no form, no field, no „Kustuta mustand“, no send
      await expect(page.locator("[data-campaign-form]")).toHaveCount(0);
      await expect(page.locator("main input, main textarea, main select")).toHaveCount(0);
      await expect(page.locator("[data-send-all], [data-test-send], [data-campaign-delete]")).toHaveCount(0);
      await expect(page.getByText("Saadetud kirja ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.")).toBeVisible();
      // the preview of what went stays (in the page's language)
      await editLang(page, "et");
      await expect(page.frameLocator('[data-campaign-preview-frame="et"]').getByText("E2E teine lõik.")).toBeVisible();
    });

    await test.step("„Kopeeri“ makes a new draft with the same content; the sent one stays as it was", async () => {
      await page.locator("[data-campaign-copy]").click();
      await expect(page).toHaveURL(/kampaania=\d+$/);
      await expect(page).not.toHaveURL(new RegExp(`kampaania=${id}$`));
      const copyForm = page.locator("[data-campaign-form]");
      const copyName = `${name} (koopia)`;
      await expect(copyForm.locator('[data-field="name"]')).toHaveValue(copyName);
      await expect(copyForm.locator('[data-field="code"]')).toHaveValue("E2E-SUGIS15");
      await expect(copyForm.locator('[data-field="buttonHref"]')).toHaveValue("/koolitused");
      await editLang(page, "ru");
      await expect(copyForm.locator('[data-i18n="subject"]')).toHaveValue("E2E осеннее предложение");
      await editLang(page, "et");
      await expect(copyForm.locator('[data-i18n="subject"]')).toHaveValue("E2E sügispakkumine");
      await expect(copyForm.locator("[data-current-image]")).toHaveAttribute("data-current-image", /^img\/[0-9a-f-]{36}\.jpg$/);
      const [copy] = await storedCampaigns(copyName);
      expect(copy.id).not.toBe(id);
      const [original] = await storedCampaigns(name);
      expect(copy).toMatchObject({ status: "draft", code: original.code, subject: original.subject, body: original.body, buttonLabel: original.buttonLabel, buttonHref: original.buttonHref, imageKey: original.imageKey });
      expect(original.status).toBe("sent"); // frozen
      // the list: the copy is a draft, the sent one is sent, and the draft is above it
      await expect(page.locator(`[data-campaign-row="${copy.id}"] [data-campaign-row-line]`)).toHaveAttribute("data-campaign-status", "draft");
      await expect(page.locator(`[data-campaign-row="${id}"] [data-campaign-row-line]`)).toHaveAttribute("data-campaign-status", "sent");
      const order = await page.locator("[data-campaign-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-campaign-row")));
      expect(order.indexOf(String(copy.id))).toBeLessThan(order.indexOf(String(id)));
      // the sent one opens as before: still read-only
      await openFromList(page, id);
      await expect(page.locator('[data-campaign-sent="sent"]')).toBeVisible();
      await expect(page.locator("[data-campaign-form]")).toHaveCount(0);
    });
  });

  test("„Kustuta mustand“ (B17) asks first in its ConfirmPanel, deletes the draft, and the list says „Mustand kustutatud.“; a sent letter has no such button", async ({ page, context, visitorIp }, info) => {
    const name = campaignName(info.project.name, "kustuta");
    // (a sent letter in the list, to open once the draft is gone)
    const sent = await insertCampaign({ name: campaignName(info.project.name, "kustuta saadetud"), status: "sent", sentAt: new Date(), recipients: { et: 1, ru: 0 } });
    await signIn(page, context, visitorIp);
    await page.goto(CAMPAIGNS);
    await adminReady(page);
    const { id, form } = await newLetter(page);
    await form.locator('[data-field="name"]').fill(name);
    await form.locator('[data-field="name"]').press("Tab");
    await expect.poll(async () => (await storedLetter(id))?.name, { timeout: 15_000 }).toBe(name);
    const remove = page.locator("[data-campaign-delete]");
    await expect(remove).toHaveText("Kustuta mustand");
    await remove.click();
    const panel = page.locator("[data-campaign-delete-part] [data-confirm-panel]");
    expect(await panelWords(panel)).toEqual({ question: `Kas kustutan mustandi „${name}“?`, lines: ["Seda ei saa tagasi võtta."] });
    await panel.getByRole("button", { name: "Katkesta" }).click();
    await expect(panel).toHaveCount(0);
    await expect(remove).toBeFocused();
    expect((await storedLetter(id))?.status).toBe("draft");
    await remove.click();
    await panel.getByRole("button", { name: "Jah, kustuta" }).click();
    await expect(page).toHaveURL(/\/admin\/uudiskiri\?vaade=kampaaniad$/);
    await expect(page.locator("[data-campaign-deleted]")).toHaveText("Mustand kustutatud.");
    await expect(page.locator(`[data-campaign-row="${id}"]`)).toHaveCount(0);
    expect(await storedLetter(id)).toBeNull();
    // a sent letter: no „Kustuta mustand“
    await openFromList(page, sent);
    await expect(page.locator('[data-campaign-sent="sent"]')).toBeVisible();
    await expect(page.locator("[data-campaign-deleted]")).toHaveCount(0); // (another letter opened: the line is gone)
    await expect(page.locator("[data-campaign-delete]")).toHaveCount(0);
  });

  test("a letter that is going out (`sending`) shows its progress and the counts, is read-only, can be copied, and „Peata saatmine“ asks first and ends it", async ({ page, context, visitorIp }, info) => {
    undo.push(await holdNewsletter(info)); // (a letter going out is the one the daily job takes, and the one a press must not find)
    const goingName = campaignName(info.project.name, "pooleli");
    const going = await insertCampaign({ name: goingName, status: "sending", recipients: { et: 4, ru: 2 } });
    // 3 mails went, 2 wait for the next day, 1 address was refused, 1 mail got no answer
    await insertDeliveries(going, { sent: 3, waiting: 2, failed: 1, unknown: 1 });
    await signIn(page, context, visitorIp);
    await page.goto(`${CAMPAIGNS}&kampaania=${going}`);
    await adminReady(page);
    await expect(page.locator('[data-campaign-sent="sending"]')).toBeVisible();
    // the list row says what went of all (P-13); the card says the rest
    await expect(page.locator(`[data-campaign-row="${going}"] [data-campaign-row-line]`)).toHaveText("Saatmine pooleli · 3 / 7");
    await expect(page.locator("[data-campaign-progress]")).toHaveText("Saadetud 3 / 7 — ülejäänud 2 lähevad järgmisel päeval.");
    await expect(page.locator("[data-campaign-failed]")).toHaveText("Kiri ei läinud 1 aadressile: aadress ei sobinud.");
    await expect(page.locator("[data-campaign-unknown]")).toHaveText("1 kirja kohta pole teada, kas see läks. Neid ei saadeta uuesti.");
    await expect(page.locator("[data-campaign-refused]")).toHaveCount(0);
    await expect(page.locator("[data-campaign-sent-line]")).toHaveCount(0);
    await expect(page.locator("[data-campaign-form], [data-send-all], [data-test-send]")).toHaveCount(0);
    await expect(page.locator("main input, main textarea, main select")).toHaveCount(0);
    await expect(page.locator("[data-campaign-copy]")).toBeVisible();
    await expect(page.locator("main")).not.toContainText("Märgi saatmata");
    expect(await noOverflow(page)).toBe(true);

    const panel = page.locator("[data-stop-confirm] [data-confirm-panel]");
    await test.step("„Peata saatmine“ asks first in its ConfirmPanel; „Katkesta“ leaves everything as it was", async () => {
      await page.locator("[data-campaign-stop]").click();
      expect(await panelWords(panel)).toEqual({ question: "Kas peatan saatmise?", lines: ["Veel saatmata 2 kirja ei lähe välja.", "Seda ei saa tagasi võtta."] });
      await expect(panel).toBeFocused();
      await panel.getByRole("button", { name: "Katkesta" }).click();
      await expect(panel).toHaveCount(0);
      await expect(page.locator("[data-campaign-stop]")).toBeFocused();
      expect(await deliveryCounts(going)).toEqual({ sent: 3, waiting: 2, failed: 1, unknown: 1 });
      expect((await storedCampaigns(goingName))[0].status).toBe("sending");
    });

    await test.step("„Jah, peata“ skips what waits and the letter is sent with the mails that went", async () => {
      await page.locator("[data-campaign-stop]").click();
      await panel.getByRole("button", { name: "Jah, peata" }).click();
      // the page is refreshed by the action: the sent state replaces the progress
      await expect(page.locator('[data-campaign-sent="sent"]')).toBeVisible();
      await expect(page.locator("[data-campaign-sent-line]")).toHaveText(/^Saadetud \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} · 3 tellijale$/);
      await expect(page.locator("[data-campaign-progress], [data-campaign-stop]")).toHaveCount(0);
      await expect(page.locator("[data-campaign-failed]")).toHaveText("Kiri ei läinud 1 aadressile: aadress ei sobinud.");
      await expect(page.locator(`[data-campaign-row="${going}"] [data-campaign-row-line]`)).toHaveText(/^Saadetud \d{2}\.\d{2} · 3 tellijale$/);
      expect(await deliveryCounts(going)).toEqual({ sent: 3, skipped: 2, failed: 1, unknown: 1 });
      expect((await storedCampaigns(goingName))[0].status).toBe("sent");
      await expect(page.locator("[data-campaign-copy]")).toBeVisible();
    });
  });

  test("the press on a real send: 3 subscribers and a room of 2 give „Saadetud 2 / 3“, the daily job sends the third, „Peata saatmine“ ends a second letter; the mails go to the e2e outbox, never to Resend", async ({ page, context, visitorIp, request, isMobile }, info) => {
    test.skip(isMobile, "presses a real send once, and sets its own widths: the desktop project only");
    test.setTimeout(240_000);
    undo.push(await holdNewsletter(info)); // (a press mails every confirmed subscriber there is, and only one letter goes out at a time)
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
    await test.step("Maria writes the letter in both languages; it autosaves", async () => {
      await page.goto(CAMPAIGNS);
      await adminReady(page);
      const letter = await newLetter(page);
      id = letter.id;
      const form = letter.form;
      await form.locator('[data-field="name"]').fill(name);
      await fillIn(form, "subject", "et", `E2E saatmine ${tag}`);
      await fillIn(form, "body", "et", "E2E tere!\n\nE2E teine lõik.");
      await fillIn(form, "subject", "ru", `E2E отправка ${tag}`);
      await fillIn(form, "body", "ru", "E2E привет!\n\nE2E второй абзац.");
      await expect(page.frameLocator('[data-campaign-preview-frame="ru"]').getByText("E2E второй абзац.")).toBeVisible();
      await expect
        .poll(async () => (await storedLetter(id))?.body, { message: "the letter as typed is stored", timeout: 15_000 })
        .toEqual({ et: "E2E tere!\n\nE2E teine lõik.", ru: "E2E привет!\n\nE2E второй абзац." });
      await allSaved(page);
    });

    await test.step("„Saada proov“ goes to the outbox: this server has one, so nothing can reach Resend", async () => {
      await expect(page.locator("[data-test-target]")).toHaveValue("maria:et");
      await page.locator("[data-test-send]").click();
      await expect(page.locator("[data-test-status]")).toContainText("Proov läks aadressile");
      await expect
        .poll(() => mailsOfThisRun(MARIA).filter((m) => m.subject === `[Proov] E2E saatmine ${tag}`).length, {
          message: "the server under test wrote no mail to the e2e outbox: is it a server you started yourself? Playwright starts its own with the e2e settings (tests/local-secrets.ts E2E_MAIL_OUTBOX): stop yours and run again",
          timeout: 15_000,
        })
        .toBe(1);
    });

    const sendPanel = page.locator("[data-send-confirm] [data-confirm-panel]");
    await test.step("C4: typed right before „Saada kõigile (3)“ — the press flushes first, and the panel counts the 3 by language (B9)", async () => {
      await room.set(2);
      await page.reload();
      await adminReady(page);
      await expect(page.locator("[data-send-all]")).toHaveText("Saada kõigile (3)");
      await expect(page.locator("[data-send-hint]")).toHaveText(/^2 eesti, 1 vene keeles( · näidisaadressidele ei saadeta)?$/);
      await editLang(page, "et");
      await page.locator('[data-campaign-form] [data-i18n="preheader"]').fill(`E2E viimane rida ${tag}`);
      await page.locator("[data-send-all]").click();
      const words = await panelWords(sendPanel);
      expect(words.question).toBe(`Kas saadan kirja „${name}“?`);
      expect(words.lines[0]).toBe("3 kinnitatud tellijat: 2 eesti, 1 vene keeles.");
      expect(words.lines.at(-1)).toBe("Saadetud kirja ei saa tagasi võtta ega muuta.");
      await expect(sendPanel).toBeFocused();
      // what she typed was stored before the panel's read: the press sends it
      expect((await storedLetter(id))?.preheader).toEqual({ et: `E2E viimane rida ${tag}`, ru: "" });
      await atEveryWidth(page, "the panel", ["[data-send-confirm] [data-confirm-panel]"]);
      await sendPanel.getByRole("button", { name: "Jah, saada 3 tellijale" }).click();
    });

    await test.step("the first batch went at once: „Saadetud 2 / 3“ and the third waits for the next day", async () => {
      await expect(page.locator("[data-campaign-progress]")).toHaveText("Saadetud 2 / 3 — ülejäänud 1 lähevad järgmisel päeval.");
      await expect(page.locator(`[data-campaign-row="${id}"] [data-campaign-row-line]`)).toHaveText("Saatmine pooleli · 2 / 3");
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
      expect(first[0].html).toContain(`E2E viimane rida ${tag}`); // (the line typed right before the press went out)
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
      await expect(page.locator(`[data-campaign-row="${id}"] [data-campaign-row-line]`)).toHaveText(/^Saadetud \d{2}\.\d{2} · 3 tellijale$/);
      await expect(page.locator("[data-campaign-progress], [data-campaign-stop]")).toHaveCount(0);
      expect(await deliveryCounts(id)).toEqual({ sent: 3 });
      expect((await storedCampaigns(name))[0]).toMatchObject({ status: "sent" });
      await atEveryWidth(page, "the sent letter", ["[data-campaign-sent-line]", "[data-campaign-copy]"]);
      // nothing is going out any more: the job has nothing to do
      const idle = await request.get("/api/cron/uudiskiri", { headers: { authorization: `Bearer ${E2E_CRON_SECRET}` } });
      expect(await idle.json()).toEqual({ ok: true, campaignId: null });
    });

    const second = await insertCampaign({ name: campaignName(info.project.name, "teine") });
    const third = await insertCampaign({ name: campaignName(info.project.name, "kolmas") });
    made.campaigns.push(second, third);
    await test.step("a second letter with the room at 1: „Saadetud 1 / 3“, and a third cannot be pressed while it is going out", async () => {
      await room.set(1);
      const before = mailsOfThisRun(...subs.map((s) => s.email)).length;
      await page.goto(`${CAMPAIGNS}&kampaania=${second}`);
      await adminReady(page);
      await page.locator("[data-send-all]").click();
      expect((await panelWords(sendPanel)).lines[0]).toBe("3 kinnitatud tellijat: 2 eesti, 1 vene keeles.");
      await sendPanel.getByRole("button", { name: "Jah, saada 3 tellijale" }).click();
      await expect(page.locator("[data-campaign-progress]")).toHaveText("Saadetud 1 / 3 — ülejäänud 2 lähevad järgmisel päeval.");
      expect(await deliveryCounts(second)).toEqual({ sent: 1, waiting: 2 });
      expect(mailsOfThisRun(...subs.map((s) => s.email)).length - before, "one more mail went").toBe(1);

      // one letter at a time: the third says so (README B5) and opens no panel
      await page.goto(`${CAMPAIGNS}&kampaania=${third}`);
      await adminReady(page);
      await page.locator("[data-send-all]").click();
      await expect(page.locator("[data-send-status]")).toHaveText("Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud.");
      await expect(page.locator("[data-send-confirm]")).toHaveCount(0);
      expect(await deliveryCounts(third)).toEqual({});
    });

    await test.step("„Peata saatmine“ on the second: its panel, then it is sent with the 1 mail that went, and nothing more goes", async () => {
      await page.goto(`${CAMPAIGNS}&kampaania=${second}`);
      await adminReady(page);
      await page.locator("[data-campaign-stop]").click();
      const stopPanel = page.locator("[data-stop-confirm] [data-confirm-panel]");
      expect(await panelWords(stopPanel)).toEqual({ question: "Kas peatan saatmise?", lines: ["Veel saatmata 2 kirja ei lähe välja.", "Seda ei saa tagasi võtta."] });
      await atEveryWidth(page, "the panel of „Peata saatmine“", ["[data-stop-confirm] [data-confirm-panel]"]);
      const before = mailsOfThisRun(...subs.map((s) => s.email)).length;
      await stopPanel.getByRole("button", { name: "Jah, peata" }).click();
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
    // `shows`: what the screen must show before it is measured; `first`: what is pressed first (the panel of „Peata saatmine“), then shown too
    const screens: { url: string; scope: string; shows: string[]; first?: { press: string; shows: string } }[] = [
      { url: "/admin/uudiskiri", scope: "main", shows: ["[data-tab-pills]", '[data-csv="all"]'] },
      { url: CAMPAIGNS, scope: "main", shows: ["[data-campaign-new]", `[data-campaign-row="${draft}"]`] },
      { url: `${CAMPAIGNS}&kampaania=${draft}`, scope: "main", shows: ["[data-campaign-form]", "[data-test-send]", "[data-test-target]", "[data-send-buttons]", "[data-campaign-delete]"] },
      { url: `${CAMPAIGNS}&kampaania=${draft}`, scope: "main", shows: ["[data-campaign-form]"], first: { press: "[data-campaign-delete]", shows: "[data-campaign-delete-part] [data-confirm-panel]" } },
      { url: `${CAMPAIGNS}&kampaania=${sent}`, scope: "main", shows: ["[data-campaign-sent-line]", "[data-campaign-copy]", "[data-campaign-preview-frame]"] },
      { url: `${CAMPAIGNS}&kampaania=${sentWithCounts}`, scope: "main", shows: ["[data-campaign-sent-line]", "[data-campaign-failed]", "[data-campaign-unknown]", "[data-campaign-copy]"] },
      { url: `${CAMPAIGNS}&kampaania=${going}`, scope: "main", shows: ["[data-campaign-progress]", "[data-campaign-failed]", "[data-campaign-unknown]", "[data-campaign-stop]", "[data-campaign-copy]", "[data-campaign-preview-frame]"] },
      { url: `${CAMPAIGNS}&kampaania=${going}`, scope: "main", shows: ["[data-campaign-progress]"], first: { press: "[data-campaign-stop]", shows: "[data-stop-confirm] [data-confirm-panel]" } },
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
          // (the picture's file field is pressed through its label, as in admin-site.spec.ts: the label is measured)
          expect((await smallTargets(scope)).filter((html) => !LABELLED.test(html)), where).toEqual([]);
          expect(await smallPills(scope), `${where}: the radios' labels`).toEqual([]);
        }
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("the Kirjad layout (README B5, the Part 3 frame): 300 px list | the letter's card | 380 px column at 1440 px; the column under the card at 1194; all stacked at 1024", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(isMobile, "sets its own widths: the desktop project only");
    const draft = await insertCampaign({ name: campaignName(info.project.name, "paigutus") });
    await signIn(page, context, visitorIp);
    const boxes = async () => {
      const box = async (selector: string) => {
        const b = await page.locator(selector).first().boundingBox();
        expect(b, selector).not.toBeNull();
        return b!;
      };
      return { list: await box("[data-campaigns-list]"), card: await box("[data-campaign-card]"), aside: await box("[data-campaign-aside]") };
    };
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${CAMPAIGNS}&kampaania=${draft}`);
      await adminReady(page);
      const wide = await boxes();
      // three columns side by side, 18 px apart, their tops on one line
      expect(Math.round(wide.list.width)).toBe(300);
      expect(Math.round(wide.aside.width)).toBe(380);
      expect(Math.round(wide.card.x - (wide.list.x + wide.list.width))).toBe(18);
      expect(Math.round(wide.aside.x - (wide.card.x + wide.card.width))).toBe(18);
      expect(Math.abs(wide.card.y - wide.list.y)).toBeLessThan(2);
      expect(Math.abs(wide.aside.y - wide.list.y)).toBeLessThan(2);
      expect(wide.card.width).toBeGreaterThan(380);
      expect(await noOverflow(page)).toBe(true);

      // an iPad across: the list beside, the column under the card
      await page.setViewportSize({ width: 1194, height: 834 });
      const mid = await boxes();
      expect(Math.round(mid.list.width)).toBe(300);
      expect(mid.card.x).toBeGreaterThan(mid.list.x + mid.list.width);
      expect(mid.aside.y).toBeGreaterThanOrEqual(mid.card.y + mid.card.height);
      expect(Math.round(mid.aside.x)).toBe(Math.round(mid.card.x));
      expect(await noOverflow(page)).toBe(true);

      // narrow: the list over the letter, the column under the card
      await page.setViewportSize({ width: 1024, height: 768 });
      const narrow = await boxes();
      expect(narrow.card.y).toBeGreaterThanOrEqual(narrow.list.y + narrow.list.height);
      expect(Math.round(narrow.card.x)).toBe(Math.round(narrow.list.x));
      expect(narrow.aside.y).toBeGreaterThanOrEqual(narrow.card.y + narrow.card.height);
      // the card holds „Kood | Nupu tekst | Nupu aadress“ in one row here (640 px of card, review M1); at 1440 its 399 px stack them
      const code = await page.locator('[data-campaign-card] [data-field="code"]').boundingBox();
      const href = await page.locator('[data-campaign-card] [data-field="buttonHref"]').boundingBox();
      // (side by side, on one row: the fields' labels differ in height, so their inputs need not share a top)
      expect(href!.x).toBeGreaterThan(code!.x + code!.width);
      expect(Math.abs(code!.y - href!.y)).toBeLessThan(code!.height);
      expect(await noOverflow(page)).toBe(true);
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("a 375 × 812 phone (Part 4 „B5 Kirjad“): the list is its own screen; a letter has „← Kirjad“, „Muuda | Eelvaade“ and its send buttons at the foot; nothing scrolls sideways", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(isMobile, "sets its own size: the desktop project only");
    const name = campaignName(info.project.name, "telefon");
    const draft = await insertCampaign({ name });
    await signIn(page, context, visitorIp);
    try {
      await page.setViewportSize({ width: 375, height: 812 });
      const main = page.locator("main");
      await page.goto(CAMPAIGNS);
      await adminReady(page);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kirjad");
      await expect(page.locator("[data-campaigns-list]")).toBeVisible();
      await expect(page.locator("[data-campaign-new]")).toBeVisible();
      expect(await noOverflow(page), "the list").toBe(true);
      expect((await smallTargets(main)).filter((html) => !LABELLED.test(html)), "the list's targets").toEqual([]);

      await page.locator(`[data-campaign-row="${draft}"]`).getByRole("link").click();
      await expect(page).toHaveURL(new RegExp(`kampaania=${draft}$`));
      const form = page.locator(`[data-campaign-form="${draft}"]`);
      await expect(form).toBeVisible();
      // the letter is a screen of its own: no list, no H1 or tabs; its „← Kirjad“, its name and SaveStatus, the switch
      await expect(page.locator("[data-campaigns-list]")).toBeHidden();
      await expect(page.getByRole("heading", { level: 1 })).toBeHidden();
      await expect(page.locator("[data-tab-pills]")).toBeHidden();
      await expect(page.locator("[data-campaign-back]")).toHaveText("← Kirjad");
      await expect(page.locator("[data-campaign-title]")).toHaveText(name);
      await expect(form.locator("[data-save-status]")).toBeVisible();
      await expect(page.locator("[data-edit-lang-switch]")).toBeVisible(); // (the letter's Russian needs it)
      const panes = page.locator("[data-campaign-panes] button");
      await expect(panes).toHaveText(["Muuda", "Eelvaade"]);
      await expect(panes.first()).toHaveAttribute("aria-pressed", "true");
      await expect(form.locator('[data-field="name"]')).toBeVisible();
      await expect(page.locator("[data-campaign-preview]")).toBeHidden();
      expect(await noOverflow(page), "Muuda").toBe(true);
      expect((await smallTargets(main)).filter((html) => !LABELLED.test(html)), "Muuda's targets").toEqual([]);

      // the two buttons at the foot of the screen, white, above the 💬 bubble (data-fab-avoid); the test's button carries the choice (Part 4)
      const bar = page.locator("[data-send-buttons]");
      await expect(bar).toHaveAttribute("data-fab-avoid", "");
      const box = await bar.boundingBox();
      expect(box, "the bar").not.toBeNull();
      expect(Math.round(box!.y + box!.height), "the bar stands at the foot").toBe(812);
      expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
      await expect(page.locator("[data-test-send] [data-label-phone]")).toHaveText(/^Saada proov · .+@… · ET$/);
      await expect(page.locator("[data-test-send] [data-label-wide]")).toBeHidden();

      await panes.nth(1).click();
      await expect(panes.nth(1)).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("[data-campaign-preview]")).toBeVisible();
      await expect(form.locator('[data-field="name"]')).toBeHidden();
      await expect(page.frameLocator('[data-campaign-preview-frame="et"]').getByText("E2E teine lõik.")).toBeVisible();
      expect(await noOverflow(page), "Eelvaade").toBe(true);

      await page.locator("[data-campaign-back]").click();
      await expect(page).toHaveURL(/\?vaade=kampaaniad$/);
      await expect(page.locator("[data-campaigns-list]")).toBeVisible();
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });
});

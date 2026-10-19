import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrowserContext, FrameLocator, Locator, Page } from "@playwright/test";
import { adminReady, signInAsAdmin } from "./admin-login";
import { E2E_CAMPAIGN_PREFIX, insertCampaign, onLocalDb, removeAdminRows, removeCampaignRows, sha256Hex, storedCampaigns, testEmail } from "./fixtures";
import { PROD_ENV } from "./prod-build";
import { E2E_RESEND } from "./resend-values";
import { DEV_ENV } from "./server";
import { PROD_BUILD } from "./target";
import { smallTargets } from "./targets";
import { expect, submitsForms, test } from "./test";

// Newsletter campaigns, the whole path on this machine (newsletter campaigns, Task 5; spec D4–D6, §5, §6; rulings R2, R4, R12, R13): the e2e run
// has no Resend key (tests/local-secrets.ts LOCAL_ENV), so nothing is ever synced with Resend or sent, and what it checks is what Maria sees and
// what the site stores:
// 1. „Uudiskiri“ says „pole veel seadistatud“ (the sync part), and the list and its CSV stay as they were;
// 2. Maria writes a campaign with a picture, a code and a button, in both languages: the Estonian and the Russian preview show her texts, the picture
//    (loaded), the code, the button and the footer (why she got the mail, the way out, the school), and „Salvesta“ stores it;
// 3. a sent campaign (set in the database, as a send leaves it) is read-only: its sent line, the links to its broadcasts in Resend's dashboard, no
//    field to change, and „Kopeeri“ makes a new draft (the first draft's copy, „(koopia)“ after its name) that the list marks „Mustand“ while the
//    sent one keeps its „Saadetud“; a campaign whose send stopped half way (`sending`, ruling R13) offers „Kopeeri“ only after the warning to look in Resend;
// 4. the screens are looked at in a phone's, a tablet's, an iPad's and a desktop's width (390, 834, 1194, 1440): no sideways scroll, every target 44 px;
// 5. Resend's webhook (/api/resend/webhook): a fake event, signed with the run's made-up secret the way Resend (svix) signs, deletes a subscriber's row;
//    a bad signature is 400 and changes nothing. The app's server is started with the webhook secret and without the marketing key.
// The signed-in tests sign in through the devLink (the production build: a stored link, admin-login.ts) and look at rows each test makes for itself.

const created = { tokens: new Set<string>(), sessions: new Set<string>() };
const names: string[] = [];
const addresses: string[] = [];
/** The ids of the webhook events this test sent: the route remembers each handled one in the KV for a week, and the test forgets them again. */
const eventIds: string[] = [];

test.beforeEach(() => {
  submitsForms();
});
test.afterEach(async () => {
  await removeAdminRows({ tokens: created.tokens, sessions: created.sessions }).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
  // a campaign's name with anything after it ("(koopia)") is removed with it
  for (const name of names.splice(0)) expect(await removeCampaignRows(`${name}%`), `the campaigns of "${name}" left`).toBe(0);
  // (exact addresses and ids only: the other tests run side by side on the same tables)
  for (const address of addresses.splice(0)) await onLocalDb((sql) => sql`delete from subscribers where email = ${address}`, { marksPages: false });
  for (const id of eventIds.splice(0)) await onLocalDb((sql) => sql`delete from kv_entries where key = ${`resend-webhook:${sha256Hex(id)}`}`, { marksPages: false });
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

test.describe("without a Resend key", () => {
  test("„Uudiskiri“ says the sync with Resend is not set up yet, and the list stays as it was", async ({ page, context, visitorIp }) => {
    await signIn(page, context, visitorIp);
    await page.goto("/admin/uudiskiri");
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Uudiskirja tellijad");
    await expect(page.locator("[data-sync-off]")).toHaveText("Resendi uudiskirja saatmine pole veel seadistatud.");
    await expect(page.locator("[data-sync-off]")).toContainText("pole veel seadistatud");
    await expect(page.locator("[data-sync-run]")).toHaveCount(0); // nothing to press
    await expect(page.locator("[data-sync-resend], [data-sync-warning], [data-sync-limit]")).toHaveCount(0);
    await expect(page.locator('[data-csv="confirmed"]')).toHaveAttribute("href", "/api/admin/subscribers.csv?kinnitatud=1");
    await expect(page.locator('[data-csv="all"]')).toHaveAttribute("href", "/api/admin/subscribers.csv");
    // the tab for the campaigns is there, and works the same without the key
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
    await test.step("„Salvesta“ stores a draft; the sends say that sending is not set up", async () => {
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
      await expect(page.locator("[data-campaign-send-off]")).toHaveText("Resendi uudiskirja saatmine pole veel seadistatud.");
      for (const button of ["[data-test-send]", "[data-send-all]"]) await expect(page.locator(button)).toHaveAttribute("aria-disabled", "true");
    });

    await test.step("a campaign that was sent (set in the database, as a send leaves it) is read-only", async () => {
      await onLocalDb(
        (sql) => sql`
          update newsletter_campaigns
          set status = 'sent', sent_at = now(), recipients = ${sql.json({ et: 3, ru: 2 })}, broadcasts = ${sql.json({ et: "bc_e2e_et", ru: "bc_e2e_ru" })}
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
      await expect(page.locator("[data-campaign-broadcast]")).toHaveCount(2);
      await expect(page.locator('[data-campaign-broadcast="et"]')).toHaveAttribute("href", "https://resend.com/broadcasts/bc_e2e_et");
      await expect(page.locator('[data-campaign-broadcast="ru"]')).toHaveAttribute("href", "https://resend.com/broadcasts/bc_e2e_ru");
      await expect(page.locator("[data-campaign-missing]")).toHaveCount(0); // both languages went
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

  test("a campaign whose send stopped half way is not offered again by itself; a campaign sent in one language only says which is missing", async ({ page, context, visitorIp }, info) => {
    const stopped = await insertCampaign({ name: campaignName(info.project.name, "pooleli"), status: "sending", recipients: { et: 2, ru: 1 }, broadcasts: { et: "bc_e2e_et" } });
    const half = await insertCampaign({ name: campaignName(info.project.name, "pool"), status: "sent", sentAt: new Date(), recipients: { et: 2, ru: 1 }, broadcasts: { et: "bc_e2e_et" } });
    await signIn(page, context, visitorIp);

    await page.goto(`${CAMPAIGNS}&kampaania=${stopped}`);
    await adminReady(page);
    await expect(page.locator('[data-campaign-sent="sending"]')).toBeVisible();
    await expect(page.locator(`[data-campaign-row="${stopped}"] [data-campaign-status]`)).toHaveText("Saatmine pooleli");
    await expect(page.locator("[data-campaign-sending]")).toContainText("Saatmine jäi pooleli");
    await expect(page.locator("[data-campaign-broadcasts-list]")).toHaveAttribute("href", "https://resend.com/broadcasts");
    await expect(page.locator("[data-campaign-sending-check]")).toHaveText("Ära kopeeri enne, kui oled Resendis kontrollinud.");
    await expect(page.locator('[data-campaign-broadcast="et"]')).toHaveAttribute("href", "https://resend.com/broadcasts/bc_e2e_et");
    await expect(page.locator("[data-campaign-sent-line]")).toHaveCount(0); // nothing says it went
    await expect(page.locator("[data-send-all], [data-send-missing], [data-campaign-form]")).toHaveCount(0);
    // „Kopeeri“ is there, but the warning to look in Resend first stands before it
    await expect(page.locator("[data-campaign-copy]")).toBeVisible();
    expect(
      await page.evaluate(() => {
        const warning = document.querySelector("[data-campaign-sending-check]")!;
        const copy = document.querySelector("[data-campaign-copy]")!;
        return Boolean(warning.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
      "the warning comes before „Kopeeri“",
    ).toBe(true);

    await page.goto(`${CAMPAIGNS}&kampaania=${half}`);
    await expect(page.locator('[data-campaign-sent="sent"]')).toBeVisible();
    await expect(page.locator("[data-campaign-sent-line]")).toHaveText(/ · 2 tellijale$/); // only the Estonian ones were reached
    await expect(page.locator('[data-campaign-missing="ru"]')).toHaveText("Venekeelne kiri jäi saatmata — saada see nupuga „Saada puuduv keel“.");
    await expect(page.locator('[data-campaign-broadcast="ru"]')).toHaveCount(0);
    await expect(page.locator("[data-send-missing]")).toHaveCount(0); // (without the key there is nothing to send with)
  });

  test("the screens at 390, 834, 1194 and 1440 px — no sideways scroll, every target 44 px", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(isMobile, "sets its own widths: the desktop project only");
    const draft = await insertCampaign({ name: campaignName(info.project.name, "laiused mustand") });
    const sent = await insertCampaign({ name: campaignName(info.project.name, "laiused saadetud"), status: "sent", sentAt: new Date(), recipients: { et: 3, ru: 2 }, broadcasts: { et: "bc_e2e_et", ru: "bc_e2e_ru" } });
    await signIn(page, context, visitorIp);
    // `shows`: what the screen must show before it is measured
    const screens = [
      { url: "/admin/uudiskiri", scope: "main", shows: ["[data-sync-off]", "[data-newsletter-views]"] },
      { url: `${CAMPAIGNS}&kampaania=${draft}`, scope: "main", shows: ["[data-campaign-form]", "[data-campaign-preview-frame]", "[data-campaign-send-off]"] },
      { url: `${CAMPAIGNS}&kampaania=${sent}`, scope: "main", shows: ["[data-campaign-sent-line]", "[data-campaign-copy]", "[data-campaign-preview-frame]"] },
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

// ---------- Resend's webhook ----------

/** The svix signature of a payload as Resend signs it: base64 HMAC-SHA256 of "<id>.<timestamp>.<body>" with the secret's bytes, as `v1,<signature>`. */
function sign(id: string, timestamp: number, body: string, secret: string = E2E_RESEND.webhookSecret): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** A POST as Resend sends it: the raw JSON body and the three svix headers. `secret`: the secret the signature is made with. */
function post(request: Page["request"], event: unknown, o: { secret?: string; id?: string } = {}) {
  const body = JSON.stringify(event);
  const id = o.id ?? `msg_e2e_${randomBytes(8).toString("hex")}`;
  eventIds.push(id);
  const timestamp = Math.floor(Date.now() / 1000);
  return request.post("/api/resend/webhook", {
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": sign(id, timestamp, body, o.secret) },
    data: body,
    failOnStatusCode: false,
    maxRedirects: 0,
  });
}

const contactUpdated = (email: string, unsubscribed: boolean) => ({
  type: "contact.updated",
  created_at: new Date().toISOString(),
  data: { id: "ct_e2e", audience_id: "seg_e2e", segment_ids: ["seg_e2e"], created_at: new Date(Date.now() - 86_400_000).toISOString(), updated_at: new Date().toISOString(), email, first_name: null, last_name: null, unsubscribed },
});
const suppression = (type: "suppression.added" | "suppression.removed", email: string) => ({
  type,
  created_at: new Date().toISOString(),
  data: { id: "sup_e2e", email, origin: "bounce", source_id: "em_e2e", created_at: new Date().toISOString() },
});

test.describe("Resend's webhook", () => {
  const stored = (email: string) => onLocalDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from subscribers where email = ${email}`, { marksPages: false }).then(([r]) => r.n);
  const suppressions = (email: string) =>
    onLocalDb((sql) => sql<{ reason: string; cleared: boolean }[]>`select reason, cleared_at is not null as cleared from mail_suppressions where email = ${email}`, { marksPages: false });

  test("a signed event deletes the subscriber's row, a bad signature is 400 and changes nothing, a replayed event does nothing twice", async ({ request }, info) => {
    const email = testEmail("webhook", info.project.name);
    addresses.push(email);
    await onLocalDb(
      (sql) => sql`
        insert into subscribers (email, locale, token, consent_at, confirmed_at)
        values (${email}, 'et', ${`e2e-webhook-${info.project.name}-${randomBytes(6).toString("hex")}`}, now() - interval '1 hour', now() - interval '1 hour')`,
      { marksPages: false },
    );
    expect(await stored(email)).toBe(1);

    // not Resend's: another secret, a missing header, an unsigned body, a signature for another body
    const unsubscribed = contactUpdated(email, true);
    for (const res of [
      await post(request, unsubscribed, { secret: `whsec_${Buffer.from("another-secret-of-another-webhook").toString("base64")}` }),
      await request.post("/api/resend/webhook", { data: JSON.stringify(unsubscribed), headers: { "content-type": "application/json" }, failOnStatusCode: false }),
      await request.post("/api/resend/webhook", {
        data: JSON.stringify(unsubscribed),
        headers: { "content-type": "application/json", "svix-id": "msg_e2e_x", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": sign("msg_e2e_x", Math.floor(Date.now() / 1000), JSON.stringify(contactUpdated(email, false))) },
        failOnStatusCode: false,
      }),
    ]) {
      expect(res.status()).toBe(400);
      expect(res.headers()["cache-control"]).toContain("no-store");
    }
    expect(await stored(email), "a refused event deletes nothing").toBe(1);

    // an event that says she did not unsubscribe changes nothing either (the site's own sync also fires contact.updated)
    expect((await post(request, contactUpdated(email, false))).status()).toBe(200);
    expect(await stored(email)).toBe(1);

    // Resend's: the contact unsubscribed there, so the row goes
    const id = `msg_e2e_${randomBytes(8).toString("hex")}`;
    const res = await post(request, unsubscribed, { id });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await stored(email), "the row of the contact that unsubscribed in Resend").toBe(0);

    // Resend sends an event again until it is answered: the same event (its id) again is answered, and remembered
    const again = await post(request, unsubscribed, { id });
    expect(again.status()).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
  });

  test("a suppression is recorded and cleared by its events", async ({ request }, info) => {
    const email = testEmail("webhook-supp", info.project.name);
    try {
      expect((await post(request, suppression("suppression.added", email))).status()).toBe(200);
      expect(await suppressions(email)).toEqual([{ reason: "bounce", cleared: false }]);
      expect((await post(request, suppression("suppression.removed", email))).status()).toBe(200);
      expect(await suppressions(email)).toEqual([{ reason: "bounce", cleared: true }]);
    } finally {
      await onLocalDb((sql) => sql`delete from mail_suppressions where email = ${email}`, { marksPages: false });
    }
    expect(await suppressions(email)).toEqual([]);
  });
});

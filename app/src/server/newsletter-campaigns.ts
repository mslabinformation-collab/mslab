import { and, desc, eq, sql } from "drizzle-orm";
import type { Db, Q } from "@/db/client";
import { newsletterCampaigns, type NewsletterCampaign } from "@/db/schema";
import { CAMPAIGN_LIMITS, campaignContentFor, checkCampaignDraft, isCampaignHref, ruFallsBack, type NewsletterCampaignDraft } from "@/domain/newsletter-campaign";
import { isWelcomeCode, normalizeWelcomeCode, WELCOME_CODE_MAX } from "@/domain/welcome-code";
import { adminEt } from "@/i18n/dict/admin";
import { isStorableImageKey, mediaUrl } from "@/lib/media";
import { toStorable } from "@/lib/to-storable";
import { campaignMail, TEST_SUBJECT_PREFIX } from "./campaign-mail";
import { getInvoiceSettings } from "./invoices";
import { logFailure } from "./log";
import { releaseSlot, reserveSlot, windowKey } from "./ratelimit";
import {
  FullSyncBusy,
  fullSync,
  fullSyncThen,
  keyRefused,
  MarketingUnavailable,
  marketingConfigured,
  recipientCounts,
  sendTestBroadcast,
  testUnsubscribeUrl,
  UNSUBSCRIBE_PLACEHOLDER,
  type BroadcastMail,
  type FullSyncReport,
  type MarketingDeps,
} from "./resend-marketing";

// Maria's newsletter campaigns (newsletter campaigns, Task 4; spec D4–D8, §5; rulings R2, R4, R5, R7, R9, R11): the drafts she writes on the
// „Kampaaniad“ tab, „Kopeeri“, the live preview, „Saada proov“ and „Saada kõigile“. The rules of a draft are domain/newsletter-campaign.ts, the mail is
// campaign-mail.ts campaignMail, and Resend's side (the sync, the broadcasts, the test segment) is resend-marketing.ts. Without Next.js: the actions
// (actions/admin-newsletter.ts) and the preview route call these. Logs carry ids and counts, never an address or a text of hers.
//
// A send, in order (sendCampaign): the full sync, and under the same lease (no other sync, send or test meanwhile) the refusal while any subscriber
// is left unsynced for a reason other than the plan's contact limit (ruling R5: those are counted, and the send goes to the ones in Resend); then
// in one short transaction the campaign row locked (FOR UPDATE), its status checked to be `draft`, and `sending` written with the counts; then one
// broadcast per segment that has subscribers, each recorded as soon as it is made; then `sent`. No row lock is held across a Resend call. A
// campaign found `sending` (a send that died, or a broadcast whose outcome is unknown) is never sent again by itself: Maria sees what is recorded
// and Resend's links, and „Kopeeri“ makes a new draft.

export type CampaignStatus = NewsletterCampaign["status"];
type Locale = "et" | "ru";
const LOCALES: readonly Locale[] = ["et", "ru"];

/** „Saada proov“ at most this many an hour (spec D6). */
export const TEST_SEND_LIMIT = 10;
const TEST_WINDOW_SEC = 60 * 60;
/** The test sends' counter (a fixed clock hour: ratelimit.ts windowKey; the entry lives for two windows). */
const TEST_KEY = "newsletter:proov";

/** The stored row as the rules' draft (the editor's values, the preview, the mails). */
export function draftOf(row: NewsletterCampaign): NewsletterCampaignDraft {
  const both = (v: { et: string; ru?: string } | null) => ({ et: v?.et ?? "", ru: v?.ru ?? "" });
  return {
    name: row.name,
    subject: both(row.subject),
    preheader: both(row.preheader),
    imageKey: row.imageKey,
    body: both(row.body),
    code: row.code,
    buttonLabel: row.buttonLabel ? both(row.buttonLabel) : null,
    buttonHref: row.buttonHref,
  };
}

/** The columns a draft writes. */
const columnsOf = (d: NewsletterCampaignDraft) => ({
  name: d.name,
  subject: d.subject,
  preheader: d.preheader,
  imageKey: d.imageKey,
  body: d.body,
  code: d.code,
  buttonLabel: d.buttonLabel,
  buttonHref: d.buttonHref,
});

export async function getCampaign(q: Q, id: number): Promise<NewsletterCampaign | null> {
  const [row] = await q.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, id)).limit(1);
  return row ?? null;
}

/** The tab's list: the drafts first (the last changed first), then the sent ones and any being sent (the newest send first). */
export async function listCampaigns(db: Db): Promise<NewsletterCampaign[]> {
  return db
    .select()
    .from(newsletterCampaigns)
    .orderBy(
      sql`case when ${newsletterCampaigns.status} = 'draft' then 0 else 1 end`,
      sql`case when ${newsletterCampaigns.status} = 'draft' then ${newsletterCampaigns.updatedAt} else coalesce(${newsletterCampaigns.sentAt}, ${newsletterCampaigns.updatedAt}) end desc`,
      desc(newsletterCampaigns.id),
    );
}

/**
 * „Salvesta“: `raw` (the editor's fields) through the rules (checkCampaignDraft: refused fields by name, nothing stored), then a new draft (`id`
 * null) or the draft `id` again, with `now` as its change time. A campaign that is sent or being sent never changes (`sent`: frozen once sent), one
 * that is not there is `notFound`. The update is one statement that requires `draft`, so a send that begins meanwhile wins.
 */
export async function saveCampaign(
  db: Db,
  id: number | null,
  raw: unknown,
  now: Date,
): Promise<{ ok: true; id: number } | { ok: false; fields: Record<string, string> } | { ok: false; error: "sent" | "notFound" }> {
  const checked = checkCampaignDraft(raw);
  if (!checked.ok) return { ok: false, fields: checked.fields };
  if (id === null) {
    const [row] = await db
      .insert(newsletterCampaigns)
      .values({ ...columnsOf(checked.value), status: "draft", createdAt: now, updatedAt: now })
      .returning();
    console.info(`[newsletter] campaign ${row.id} created`);
    return { ok: true, id: row.id };
  }
  const updated = await db
    .update(newsletterCampaigns)
    .set({ ...columnsOf(checked.value), updatedAt: now })
    .where(and(eq(newsletterCampaigns.id, id), eq(newsletterCampaigns.status, "draft")))
    .returning();
  if (updated.length > 0) return { ok: true, id };
  return { ok: false, error: (await getCampaign(db, id)) ? "sent" : "notFound" };
}

/** „Kopeeri“: a new draft with the content of campaign `id` (sent or not) and „ (koopia)“ after its name, cut to the name's limit. */
export async function copyCampaign(db: Db, id: number, now: Date): Promise<{ ok: true; id: number } | { ok: false }> {
  const row = await getCampaign(db, id);
  if (!row) return { ok: false };
  const suffix = adminEt.newsletter.campaigns.copySuffix;
  const name = `${row.name.slice(0, CAMPAIGN_LIMITS.name - suffix.length).trimEnd()}${suffix}`;
  const [copy] = await db
    .insert(newsletterCampaigns)
    .values({ ...columnsOf(draftOf(row)), name, status: "draft", createdAt: now, updatedAt: now })
    .returning();
  console.info(`[newsletter] campaign ${copy.id} copied from campaign ${id}`);
  return { ok: true, id: copy.id };
}

// ---------- the mail ----------

/** The picture as an absolute address on the site's own address (SITE_URL, never the request's): the key's /media or /seed path after it. */
function imageUrlOf(siteUrl: string, key: string | null): string | null {
  if (!key) return null;
  const path = mediaUrl(key);
  if (!path) return null;
  return /^https?:\/\//i.test(path) ? path : `${siteUrl.replace(/\/+$/, "")}${path}`;
}

/** The school under the mail: Seaded → „Arve andmed“, "MS LAB" and no address when it has none (campaign-mail.ts says the same). */
async function schoolOf(q: Q, now: Date): Promise<{ name: string; address: string }> {
  const s = await getInvoiceSettings(q, now);
  return { name: s.company.trim() || "MS LAB", address: s.address.trim() };
}

type MailOptions = { siteUrl: string; school: { name: string; address: string }; unsubscribeHref: string; test: boolean };

/** The campaign's mail for a subscriber of `locale` (the footer hers, the text the campaign's in her language or the Estonian one: Review Focus 5). */
function mailOf(draft: NewsletterCampaignDraft, locale: Locale, o: MailOptions): { subject: string; html: string; text: string } {
  return campaignMail({
    content: campaignContentFor(draft, locale),
    pageLocale: locale,
    imageUrl: imageUrlOf(o.siteUrl, draft.imageKey),
    code: draft.code,
    buttonHref: draft.buttonHref,
    siteUrl: o.siteUrl,
    school: o.school,
    unsubscribeHref: o.unsubscribeHref,
    test: o.test,
  });
}

/** The broadcast's name in Resend's dashboard: her name for the campaign and the language („[Proov] “ in front for a test). */
const broadcastName = (draft: NewsletterCampaignDraft, locale: Locale, test: boolean) => `${test ? TEST_SUBJECT_PREFIX : ""}${draft.name} (${locale.toUpperCase()})`;

// ---------- the preview ----------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The editor's fields as they stand, made fit for the preview: nothing is required, each text is cleaned as the rules clean it (toStorable, a
 * one-line text without breaks) and cut to its limit, and a part that is not valid yet is left out (a code of another shape, a picture that is not
 * the site's, a button without its address or its label). What the rules would refuse is the editor's business (it says so on „Salvesta“).
 */
export function previewDraft(raw: unknown): NewsletterCampaignDraft {
  const o = isObject(raw) ? raw : {};
  const L = CAMPAIGN_LIMITS;
  const text = (v: unknown, max: number, oneLine: boolean): string => {
    if (typeof v !== "string") return "";
    const clean = toStorable(v);
    return (oneLine ? clean.replace(/[ \t]*[\r\n]+[ \t]*|\t/g, " ") : clean.replace(/\r\n?/g, "\n")).trim().slice(0, max);
  };
  const both = (v: unknown, max: number, oneLine: boolean) => {
    const b = isObject(v) ? v : {};
    return { et: text(b.et, max, oneLine), ru: text(b.ru, max, oneLine) };
  };
  const imageKey = text(o.imageKey, L.href, true);
  const code = normalizeWelcomeCode(text(o.code, WELCOME_CODE_MAX, true));
  const href = text(o.buttonHref, L.href, true);
  const label = both(o.buttonLabel, L.buttonLabel, true);
  const button = isCampaignHref(href) && (label.et !== "" || label.ru !== "");
  return {
    name: text(o.name, L.name, true),
    subject: both(o.subject, L.subject, true),
    preheader: both(o.preheader, L.preheader, true),
    imageKey: imageKey !== "" && isStorableImageKey(imageKey) ? imageKey : null,
    body: both(o.body, L.body, false),
    code: code !== "" && isWelcomeCode(code) ? code : null,
    buttonLabel: button ? label : null,
    buttonHref: button ? href : null,
  };
}

export type PreviewMail = { subject: string; preheader: string; html: string };

/**
 * The live preview (POST /api/admin/kampaania-eelvaade): the real mail of `raw` (previewDraft) for an Estonian and for a Russian subscriber, as a
 * send makes it but for the unsubscribe link, which is the test page's (a click in the preview unsubscribes no one). `ruFallsBack`: the Russian
 * subscribers get the Estonian text. Stores nothing.
 */
export async function campaignPreview(q: Q, siteUrl: string, raw: unknown, now: Date): Promise<{ et: PreviewMail; ru: PreviewMail; ruFallsBack: boolean }> {
  const draft = previewDraft(raw);
  const o: MailOptions = { siteUrl, school: await schoolOf(q, now), unsubscribeHref: testUnsubscribeUrl(siteUrl), test: false };
  const one = (locale: Locale): PreviewMail => {
    const content = campaignContentFor(draft, locale);
    return { subject: content.subject, preheader: content.preheader, html: mailOf(draft, locale, o).html };
  };
  return { et: one("et"), ru: one("ru"), ruFallsBack: ruFallsBack(draft) };
}

// ---------- the sends ----------

type ResendRefusal = "notConfigured" | "busy" | "permission" | "unavailable";

/** A refusal of Resend's side in a code: not set up, another sync running, a key that may not do this, Resend not answering. Anything else is thrown on. */
function refusalOf(e: unknown, where: string): ResendRefusal {
  if (e instanceof FullSyncBusy) return "busy"; // (logged by the lease)
  if (!(e instanceof MarketingUnavailable)) throw e;
  if (e.code === "not_configured") return "notConfigured";
  logFailure(where, e);
  return keyRefused(e) ? "permission" : "unavailable";
}

/**
 * „Saada proov“ (rulings R4, R7): the stored campaign `id` in `locale` (Estonian unless told), as one broadcast to the test segment holding `to`
 * alone (resend-marketing.ts sendTestBroadcast): the very mail of a send, Resend's placeholder for the unsubscribe link included, with „[Proov] “
 * before the subject. `realLink`: `to` is a subscriber's, so the mail carries her real unsubscribe link. At most TEST_SEND_LIMIT an hour (`limited`,
 * nothing asked of Resend); a test that did not go is not counted. `notConfigured` without the newsletter's key, `busy` while a sync or send runs,
 * `permission` / `unavailable` when Resend refuses or does not answer.
 */
export async function sendTest(
  deps: MarketingDeps,
  id: number,
  to: string,
  locale: Locale = "et",
): Promise<{ ok: true; realLink: boolean } | { ok: false; error: "notFound" | "limited" | ResendRefusal }> {
  if (!marketingConfigured(deps.env)) return { ok: false, error: "notConfigured" };
  const row = await getCampaign(deps.db, id);
  if (!row) return { ok: false, error: "notFound" };
  const key = windowKey(TEST_KEY, deps.now, TEST_WINDOW_SEC);
  if (!(await reserveSlot(deps.env.KV, key, TEST_SEND_LIMIT, 2 * TEST_WINDOW_SEC))) {
    console.info(`[newsletter] campaign ${id}: a test refused, ${TEST_SEND_LIMIT} this hour already`);
    return { ok: false, error: "limited" };
  }
  try {
    const draft = draftOf(row);
    const mail = mailOf(draft, locale, { siteUrl: deps.siteUrl, school: await schoolOf(deps.db, deps.now), unsubscribeHref: UNSUBSCRIBE_PLACEHOLDER, test: true });
    const sent = await sendTestBroadcast(deps, to, { name: broadcastName(draft, locale, true), ...mail });
    console.info(`[newsletter] campaign ${id}: test broadcast ${sent.id} (${locale})`);
    return { ok: true, realLink: sent.realLink };
  } catch (e) {
    await releaseSlot(deps.env.KV, key, 2 * TEST_WINDOW_SEC).catch(() => {});
    return { ok: false, error: refusalOf(e, `[newsletter] campaign ${id}: the test failed`) };
  }
}

/** What „Saada kõigile“ asks Maria to confirm: the subscribers in Resend by language, whether the Russian ones get the Estonian text, those left out by the plan's limit, and the sync's report. */
export type SendPlan = { et: number; ru: number; ruFallsBack: boolean; left: number; report: FullSyncReport };

/**
 * May a send follow this sync (Review Focus 2, ruling R5)? Not when the sync did not finish (its time ran out, or a contact that had to leave our
 * segments is still there), when a push or a removal failed, or when a subscriber is left unsynced while the plan's contacts are not used up. Rows
 * left out by the limit alone do not stop it: they are counted (`left`).
 */
const syncBlocks = (r: FullSyncReport): boolean => !r.finished || r.failed > 0 || (r.unsynced > 0 && !r.limitReached);
const leftOut = (r: FullSyncReport): number => (r.limitReached ? r.unsynced : 0);

/**
 * „Saada kõigile“, before the confirmation: the full sync (D2; its lease: `busy` while another runs), then the plan. `sent` for a campaign that is
 * sent or being sent, `unsynced` when the sync leaves a subscriber out for any reason but the plan's limit (syncBlocks), `empty` when Resend has no
 * subscriber of ours. Sends nothing.
 */
export async function prepareSend(
  deps: MarketingDeps,
  id: number,
): Promise<{ ok: true; plan: SendPlan } | { ok: false; error: "notFound" | "sent" | "unsynced" | "empty" | ResendRefusal }> {
  if (!marketingConfigured(deps.env)) return { ok: false, error: "notConfigured" };
  const row = await getCampaign(deps.db, id);
  if (!row) return { ok: false, error: "notFound" };
  if (row.status !== "draft") return { ok: false, error: "sent" };
  let report: FullSyncReport;
  try {
    report = await fullSync(deps);
  } catch (e) {
    return { ok: false, error: refusalOf(e, `[newsletter] campaign ${id}: the sync before the send failed`) };
  }
  if (syncBlocks(report)) {
    console.info(`[newsletter] campaign ${id}: not ready to send, ${report.unsynced} subscribers not synced, ${report.failed} failed`);
    return { ok: false, error: "unsynced" };
  }
  const counts = await recipientCounts(deps.db);
  if (counts.et + counts.ru === 0) return { ok: false, error: "empty" };
  return { ok: true, plan: { ...counts, ruFallsBack: ruFallsBack(draftOf(row)), left: leftOut(report), report } };
}

export type SendResult =
  | { ok: true; recipients: { et: number; ru: number }; missing: Locale[]; left: number }
  | { ok: false; error: "notFound" | "sent" | "unsynced" | "empty" | "interrupted" | ResendRefusal };

/**
 * „Saada“ after the confirmation (spec D6, §5; Review Focus 2, 3, 5; rulings R5, R9, R11), under one lease from the sync to the last broadcast:
 * 1. the full sync again; refused (`unsynced`) as prepareSend refuses, `empty` without a subscriber in Resend;
 * 2. one short transaction: the row locked (FOR UPDATE), `draft` required (else `sent`: a second press, another tab), and `sending` written with
 *    the counts, so that from here on nothing can send it again by itself;
 * 3. one broadcast per segment that has subscribers, Estonian first: from MAIL_FROM, Maria as the reply-to, its language's subject, the html and
 *    text of campaignMail with Resend's placeholder for her unsubscribe link and the segment's language as the footer's; each recorded at once;
 * 4. `sent` with the time, the counts and the broadcasts.
 * When a broadcast fails: Resend refused it (a 4xx), so it was not made: the first one refused leaves nothing sent and the campaign a draft again
 * (`unavailable` / `permission`, a later press may send), the second refused after the first went leaves it `sent` with the one that went (its
 * language in `missing`: „… kiri jäi saatmata — kopeeri kampaania ja saada uuesti.“). One that got no answer (a timeout, a 5xx) may have gone:
 * the campaign stays `sending` with what is recorded (`interrupted`), and Maria looks in Resend. Nothing is ever sent twice by the site.
 */
export async function sendCampaign(deps: MarketingDeps, id: number): Promise<SendResult> {
  if (!marketingConfigured(deps.env)) return { ok: false, error: "notConfigured" };
  const before = await getCampaign(deps.db, id);
  if (!before) return { ok: false, error: "notFound" };
  if (before.status !== "draft") return { ok: false, error: "sent" };
  try {
    return await fullSyncThen(deps, async (report, broadcast): Promise<SendResult> => {
      if (syncBlocks(report)) {
        console.info(`[newsletter] campaign ${id}: not sent, ${report.unsynced} subscribers not synced, ${report.failed} failed`);
        return { ok: false, error: "unsynced" };
      }
      const counts = await recipientCounts(deps.db);
      if (counts.et + counts.ru === 0) return { ok: false, error: "empty" };
      const school = await schoolOf(deps.db, deps.now);

      const marked = await deps.db.transaction(async (tx) => {
        const [row] = await tx.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, id)).for("update");
        if (!row) return "notFound" as const;
        if (row.status !== "draft") return "sent" as const;
        const [sending] = await tx
          .update(newsletterCampaigns)
          .set({ status: "sending", recipients: counts, broadcasts: {}, updatedAt: deps.now })
          .where(eq(newsletterCampaigns.id, id))
          .returning();
        return sending;
      });
      if (typeof marked === "string") return { ok: false, error: marked };

      const draft = draftOf(marked);
      const went: { et?: string; ru?: string } = {};
      const missing: Locale[] = [];
      let refused: MarketingUnavailable | null = null;
      let unknown = false;
      for (const locale of LOCALES) {
        if (counts[locale] === 0) continue;
        if (refused || unknown) {
          missing.push(locale);
          continue;
        }
        const mail = mailOf(draft, locale, { siteUrl: deps.siteUrl, school, unsubscribeHref: UNSUBSCRIBE_PLACEHOLDER, test: false });
        const result = await broadcast(locale, { name: broadcastName(draft, locale, false), ...mail } satisfies BroadcastMail);
        if (result.ok) {
          went[locale] = result.id;
          await deps.db.update(newsletterCampaigns).set({ broadcasts: { ...went } }).where(eq(newsletterCampaigns.id, id));
          console.info(`[newsletter] campaign ${id}: broadcast ${result.id} sent to ${counts[locale]} subscribers (${locale})`);
          continue;
        }
        logFailure(`[newsletter] campaign ${id}: the ${locale} broadcast ${result.refused ? "was refused" : "got no answer"}`, result.error);
        missing.push(locale);
        if (result.refused) refused = result.error;
        else unknown = true;
      }

      if (unknown) {
        console.info(`[newsletter] campaign ${id}: left sending, a broadcast's outcome is not known`);
        return { ok: false, error: "interrupted" };
      }
      if (Object.keys(went).length === 0) {
        await deps.db
          .update(newsletterCampaigns)
          .set({ status: "draft", recipients: null, broadcasts: null })
          .where(and(eq(newsletterCampaigns.id, id), eq(newsletterCampaigns.status, "sending")));
        console.info(`[newsletter] campaign ${id}: nothing sent, a draft again`);
        return { ok: false, error: keyRefused(refused) ? "permission" : "unavailable" };
      }
      await deps.db.update(newsletterCampaigns).set({ status: "sent", sentAt: deps.now, recipients: counts, broadcasts: went, updatedAt: deps.now }).where(eq(newsletterCampaigns.id, id));
      console.info(`[newsletter] campaign ${id}: sent${missing.length ? `, the ${missing.join(" and ")} broadcast not` : ""}`);
      return { ok: true, recipients: { et: went.et ? counts.et : 0, ru: went.ru ? counts.ru : 0 }, missing, left: leftOut(report) };
    });
  } catch (e) {
    return { ok: false, error: refusalOf(e, `[newsletter] campaign ${id}: the send's sync failed`) };
  }
}

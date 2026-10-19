import { and, desc, eq, sql } from "drizzle-orm";
import type { Db, Q } from "@/db/client";
import { newsletterCampaigns, type NewsletterCampaign } from "@/db/schema";
import {
  CAMPAIGN_LIMITS,
  campaignContentFor,
  checkCampaignDraft,
  isCampaignHref,
  ruFallsBack,
  sendLanguages,
  unsentCandidate,
  type NewsletterCampaignDraft,
} from "@/domain/newsletter-campaign";
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
// is left unsynced for a reason other than the plan's contact limit or Resend's refusal of an address (rulings R5, R17: those are counted, and the
// send goes to the ones in Resend); then in one short transaction the campaign row locked (FOR UPDATE), its status checked to be `draft`, and
// `sending` written with the counts; then one broadcast per segment that has subscribers, each recorded as soon as it is made; then `sent`. No row
// lock is held across a Resend call. A campaign found `sending` (a send that died, or a broadcast whose outcome is unknown) is never sent again by
// itself: Maria sees each language's state (sent, with its Resend link, or unknown) and Resend's list of broadcasts, and for the language she does
// not find there she presses „Märgi saatmata“ (markNotSent, ruling R16); never „Kopeeri“, which would mail the language that went a second time.
// The send goes only to the counts and the campaign Maria confirmed (ruling R14, the review's M3). A campaign sent in one language only (Resend
// refused the other, or Maria marked it not sent) offers „Saada puuduv keel“ (ruling R12): the same send, scope "missing", to that language's
// segment alone.

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
 * nothing asked of Resend); a test that did not go is not counted. `unsubscribed`: `to` is a subscriber's whose contact unsubscribed in Resend, so
 * nothing would arrive and nothing is sent (the review's M7). `notConfigured` without the newsletter's key, `busy` while a sync or send runs,
 * `permission` / `unavailable` when Resend refuses or does not answer.
 */
export async function sendTest(
  deps: MarketingDeps,
  id: number,
  to: string,
  locale: Locale = "et",
): Promise<{ ok: true; realLink: boolean } | { ok: false; error: "notFound" | "limited" | "unsubscribed" | ResendRefusal }> {
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
    if (!sent.sent) {
      // (the review's M7) a subscriber's contact unsubscribed in Resend: no mail would arrive, so none was sent and the hour is not spent
      await releaseSlot(deps.env.KV, key, 2 * TEST_WINDOW_SEC).catch(() => {});
      console.info(`[newsletter] campaign ${id}: no test, the address's contact unsubscribed in Resend`);
      return { ok: false, error: "unsubscribed" };
    }
    console.info(`[newsletter] campaign ${id}: test broadcast ${sent.id} (${locale})`);
    return { ok: true, realLink: sent.realLink };
  } catch (e) {
    await releaseSlot(deps.env.KV, key, 2 * TEST_WINDOW_SEC).catch(() => {});
    return { ok: false, error: refusalOf(e, `[newsletter] campaign ${id}: the test failed`) };
  }
}

/**
 * What „Saada kõigile“ asks Maria to confirm: the subscribers in Resend by language, whether the Russian ones get the Estonian text, those left out
 * by the plan's limit (`left`) and those whose address Resend refused (`rejected`, ruling R17), the sync's report, and `updatedAt`, the campaign's
 * last change as this plan read it (ISO): the send goes only if the campaign is still that one (the review's M3).
 */
export type SendPlan = { et: number; ru: number; ruFallsBack: boolean; left: number; rejected: number; updatedAt: string; report: FullSyncReport };

/** What Maria confirmed: the plan's counts and its `updatedAt` (rulings R14, and the review's M3). */
export type Confirmed = { et: number; ru: number; updatedAt: string };

/**
 * May a send follow this sync (Review Focus 2, rulings R5, R17)? Not when the sync did not finish (its time ran out, or a contact that had to leave
 * our segments is still there), when a push or a removal failed, or when a subscriber is left unsynced while the plan's contacts are not used up.
 * Rows left out by the limit alone do not stop it (they are counted, `left`), nor do the rows whose address Resend refused (`rejected`: the
 * report never counts them `unsynced` or `failed`).
 */
const syncBlocks = (r: FullSyncReport): boolean => !r.finished || r.failed > 0 || (r.unsynced > 0 && !r.limitReached);
const leftOut = (r: FullSyncReport): number => (r.limitReached ? r.unsynced : 0);

/** The plan of a send of `row` with these counts after this sync's `report`. */
const planOf = (row: NewsletterCampaign, counts: Counts, report: FullSyncReport): SendPlan => ({
  ...counts,
  ruFallsBack: ruFallsBack(draftOf(row)),
  left: leftOut(report),
  rejected: report.rejected,
  updatedAt: row.updatedAt.toISOString(),
  report,
});

/** Is the campaign still the one Maria confirmed (its last change as her confirmation read it)? A time that is no time never is. */
const sameVersion = (row: NewsletterCampaign, confirmedAt: string): boolean => row.updatedAt.getTime() === Date.parse(confirmedAt);

/**
 * What a send is for: „Saada kõigile“ of a draft (`all`: both segments), or „Saada puuduv keel“ (`missing`, ruling R12) of a sent campaign whose
 * other language Resend refused: only that language's segment, never the one that already got it.
 */
export type SendScope = "all" | "missing";

type Counts = { et: number; ru: number };

/** The languages of a sent campaign that did not go: planned for subscribers at its send, and without a broadcast recorded (R12). */
export function missingLocales(row: Pick<NewsletterCampaign, "recipients" | "broadcasts">): Locale[] {
  return LOCALES.filter((l) => (row.recipients?.[l] ?? 0) > 0 && !row.broadcasts?.[l]);
}

/** The languages a send of `scope` may go to now, or null when there is none: `all` needs a draft; `missing` a sent campaign with a language missing. */
function scopeLocales(row: NewsletterCampaign, scope: SendScope): Locale[] | null {
  if (scope === "all") return row.status === "draft" ? [...LOCALES] : null;
  if (row.status !== "sent") return null;
  const missing = missingLocales(row);
  return missing.length > 0 ? missing : null;
}

const sameLocales = (a: Locale[], b: Locale[]) => a.length === b.length && a.every((l) => b.includes(l));

/** The subscribers in Resend, by language, of the languages the send goes to (the others count 0). */
async function scopedCounts(db: Db, locales: Locale[]): Promise<Counts> {
  const all = await recipientCounts(db);
  return { et: locales.includes("et") ? all.et : 0, ru: locales.includes("ru") ? all.ru : 0 };
}

/**
 * „Saada kõigile“ (or „Saada puuduv keel“: `scope` "missing", ruling R12), before the confirmation: the full sync (D2; its lease: `busy` while
 * another runs), then the plan, counted for the languages the send would go to. `sent` for a campaign that is sent or being sent (with
 * "missing": one that has no language missing), `unsynced` when the sync leaves a subscriber out for any reason but the plan's limit
 * (syncBlocks), `empty` when Resend has no subscriber of ours in those languages. Sends nothing.
 */
export async function prepareSend(
  deps: MarketingDeps,
  id: number,
  scope: SendScope = "all",
): Promise<{ ok: true; plan: SendPlan } | { ok: false; error: "notFound" | "sent" | "unsynced" | "empty" | ResendRefusal }> {
  if (!marketingConfigured(deps.env)) return { ok: false, error: "notConfigured" };
  const row = await getCampaign(deps.db, id);
  if (!row) return { ok: false, error: "notFound" };
  const locales = scopeLocales(row, scope);
  if (!locales) return { ok: false, error: "sent" };
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
  const counts = await scopedCounts(deps.db, locales);
  if (counts.et + counts.ru === 0) return { ok: false, error: "empty" };
  return { ok: true, plan: planOf(row, counts, report) };
}

export type SendResult =
  | { ok: true; recipients: Counts; missing: Locale[]; left: number }
  | { ok: false; error: "changed"; plan: SendPlan }
  | { ok: false; error: "notFound" | "sent" | "unsynced" | "empty" | "interrupted" | ResendRefusal };

/**
 * „Saada“ after the confirmation (spec D6, §1, §5; Review Focus 2, 3, 5; rulings R5, R9, R11, R12, R14), under one lease from the sync to the last
 * broadcast. `confirmed`: the counts Maria confirmed and the campaign's last change as her confirmation read it (the plan of prepareSend).
 * `scope`: "all" for a draft, "missing" for „Saada puuduv keel“.
 * 1. the full sync again; refused (`unsynced`) as prepareSend refuses, `empty` without a subscriber in Resend in the send's languages;
 * 2. the counts after this sync against the confirmed ones (R14: the spec promises the exact count), and the campaign against the one confirmed (its
 *    `updatedAt`, the review's M3: another tab saved it meanwhile): when either moved nothing is sent, and the answer is `changed` with the new plan,
 *    for Maria to confirm again;
 * 3. one short transaction: the row locked (FOR UPDATE) and its state checked again (`draft`, or for "missing" `sent` with the same languages still
 *    missing; else `sent`: a second press, another tab, a lease that ran out; and still the version confirmed, else `changed`: a save that landed
 *    during the sync), and `sending` written with the counts (the broadcast that went before stays recorded), so that from here on nothing can
 *    send it again by itself;
 * 4. one broadcast per segment of the send that has subscribers, Estonian first: from MAIL_FROM, Maria as the reply-to, its language's subject,
 *    the html and text of campaignMail with Resend's placeholder for her unsubscribe link and the segment's language as the footer's; each recorded
 *    at once;
 * 5. `sent` with the time (a „Saada puuduv keel“ keeps the first send's), the counts and the broadcasts.
 * When a broadcast fails: Resend refused it (resend-marketing.ts broadcastRefused), so it was not made: when nothing of this send went, the
 * campaign is as it was before it (a draft again, or sent with its language missing, its last change too: a later press may send), else it is
 * `sent` with the one that went (the other in `missing`, for „Saada puuduv keel“). One that got any other answer or none (a timeout, a 5xx, a
 * gateway's 4xx) may have gone: the campaign stays `sending` with what is recorded (`interrupted`, ruling R13), and Maria looks in Resend; once she
 * has seen that a language is not there, „Märgi saatmata“ (markNotSent, ruling R16) records it so. Nothing is ever sent twice by the site.
 */
export async function sendCampaign(deps: MarketingDeps, id: number, confirmed: Confirmed, scope: SendScope = "all"): Promise<SendResult> {
  if (!marketingConfigured(deps.env)) return { ok: false, error: "notConfigured" };
  const before = await getCampaign(deps.db, id);
  if (!before) return { ok: false, error: "notFound" };
  const locales = scopeLocales(before, scope);
  if (!locales) return { ok: false, error: "sent" };
  try {
    return await fullSyncThen(deps, async (report, broadcast): Promise<SendResult> => {
      if (syncBlocks(report)) {
        console.info(`[newsletter] campaign ${id}: not sent, ${report.unsynced} subscribers not synced, ${report.failed} failed`);
        return { ok: false, error: "unsynced" };
      }
      const counts = await scopedCounts(deps.db, locales);
      if (counts.et + counts.ru === 0) return { ok: false, error: "empty" };
      if (counts.et !== confirmed.et || counts.ru !== confirmed.ru) {
        console.info(`[newsletter] campaign ${id}: not sent, the subscribers changed since the confirmation (${confirmed.et}+${confirmed.ru} → ${counts.et}+${counts.ru})`);
        return { ok: false, error: "changed", plan: planOf(before, counts, report) };
      }
      if (!sameVersion(before, confirmed.updatedAt)) {
        console.info(`[newsletter] campaign ${id}: not sent, the campaign changed since the confirmation`);
        return { ok: false, error: "changed", plan: planOf(before, counts, report) };
      }
      const school = await schoolOf(deps.db, deps.now);

      const marked = await deps.db.transaction(async (tx) => {
        const [row] = await tx.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, id)).for("update");
        if (!row) return "notFound" as const;
        const now = scopeLocales(row, scope);
        if (!now || !sameLocales(now, locales)) return "sent" as const;
        if (!sameVersion(row, confirmed.updatedAt)) return { kind: "changed" as const, row };
        // the counts of the send's languages; a language that went before keeps its own
        const recipients = scope === "all" ? counts : { et: locales.includes("et") ? counts.et : (row.recipients?.et ?? 0), ru: locales.includes("ru") ? counts.ru : (row.recipients?.ru ?? 0) };
        const [sending] = await tx
          .update(newsletterCampaigns)
          .set({ status: "sending", recipients, broadcasts: scope === "all" ? {} : { ...row.broadcasts }, updatedAt: deps.now })
          .where(eq(newsletterCampaigns.id, id))
          .returning();
        return { kind: "sending" as const, previous: row, sending };
      });
      if (typeof marked === "string") return { ok: false, error: marked };
      if (marked.kind === "changed") {
        // saved (another tab) while this send's sync ran: nothing is sent, Maria confirms the campaign as it is now
        console.info(`[newsletter] campaign ${id}: not sent, the campaign changed since the confirmation`);
        return { ok: false, error: "changed", plan: planOf(marked.row, counts, report) };
      }

      const { previous, sending } = marked;
      const draft = draftOf(sending);
      const went: { et?: string; ru?: string } = { ...sending.broadcasts };
      const sentNow: Locale[] = [];
      const missing: Locale[] = [];
      let refused: MarketingUnavailable | null = null;
      let unknown = false;
      for (const locale of locales) {
        if (counts[locale] === 0) continue;
        if (refused || unknown) {
          missing.push(locale);
          continue;
        }
        const mail = mailOf(draft, locale, { siteUrl: deps.siteUrl, school, unsubscribeHref: UNSUBSCRIBE_PLACEHOLDER, test: false });
        const result = await broadcast(locale, { name: broadcastName(draft, locale, false), ...mail } satisfies BroadcastMail);
        if (result.ok) {
          went[locale] = result.id;
          sentNow.push(locale);
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
      if (sentNow.length === 0) {
        // nothing of this send went: the campaign as it was before it (its last change too: what Maria confirmed still holds)
        await deps.db
          .update(newsletterCampaigns)
          .set({ status: previous.status, recipients: previous.recipients, broadcasts: previous.broadcasts, updatedAt: previous.updatedAt })
          .where(and(eq(newsletterCampaigns.id, id), eq(newsletterCampaigns.status, "sending")));
        console.info(`[newsletter] campaign ${id}: nothing sent, back to ${previous.status}`);
        return { ok: false, error: keyRefused(refused) ? "permission" : "unavailable" };
      }
      await deps.db
        .update(newsletterCampaigns)
        .set({ status: "sent", sentAt: previous.sentAt ?? deps.now, broadcasts: went, updatedAt: deps.now })
        .where(eq(newsletterCampaigns.id, id));
      console.info(`[newsletter] campaign ${id}: sent${missing.length ? `, the ${missing.join(" and ")} broadcast not` : ""}`);
      return { ok: true, recipients: { et: sentNow.includes("et") ? counts.et : 0, ru: sentNow.includes("ru") ? counts.ru : 0 }, missing, left: leftOut(report) };
    });
  } catch (e) {
    return { ok: false, error: refusalOf(e, `[newsletter] campaign ${id}: the send's sync failed`) };
  }
}

/**
 * „Märgi saatmata“ (ruling R16): Maria has looked in Resend and the `locale` broadcast of a campaign left `sending` is not there. Under the row's
 * lock (FOR UPDATE, the same lock a send takes), and only for the language unsentCandidate names (the first of the send without a recorded
 * broadcast: a send goes Estonian first and stops at the first broadcast without an answer, so every language after it was never tried and is not
 * sent either):
 * - with a broadcast recorded (the other language went): `sent`, its time the send's (`sentAt`, or the `sending` marker's time for a first send),
 *   the not-sent languages missing, so that „Saada puuduv keel“ (ruling R12) sends them alone, under its own lease, sync, counts and lock;
 * - with none recorded (nothing of the send went): a draft again, as a refused first broadcast leaves it, for „Saada kõigile“.
 * A language with a recorded broadcast is never marked (`sent`), nor is a campaign that is not `sending` (`sent`: sent, a draft, or marked
 * meanwhile in another tab); `earlier`: another language before it is still open (only the first one may be marked). Asks nothing of Resend.
 */
export async function markNotSent(db: Db, id: number, locale: Locale, now: Date): Promise<{ ok: true; status: "draft" | "sent" } | { ok: false; error: "notFound" | "sent" | "earlier" }> {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, id)).for("update");
    if (!row) return { ok: false as const, error: "notFound" as const };
    // (a language with a recorded broadcast, or none of the send's, is never one to mark)
    const languages = sendLanguages(row);
    if (row.status !== "sending" || languages.find((l) => l.locale === locale)?.state !== "unknown") return { ok: false as const, error: "sent" as const };
    if (unsentCandidate(row) !== locale) return { ok: false as const, error: "earlier" as const };
    const went = languages.filter((l) => l.state === "sent");
    if (went.length === 0) {
      await tx
        .update(newsletterCampaigns)
        .set({ status: "draft", sentAt: null, recipients: null, broadcasts: null, updatedAt: now })
        .where(and(eq(newsletterCampaigns.id, id), eq(newsletterCampaigns.status, "sending")));
      return { ok: true as const, status: "draft" as const };
    }
    await tx
      .update(newsletterCampaigns)
      .set({ status: "sent", sentAt: row.sentAt ?? row.updatedAt, updatedAt: now })
      .where(and(eq(newsletterCampaigns.id, id), eq(newsletterCampaigns.status, "sending")));
    return { ok: true as const, status: "sent" as const };
  });
  if (result.ok) console.info(`[newsletter] campaign ${id}: the ${locale} broadcast marked not sent (checked in Resend): ${result.status === "sent" ? "sent, the language missing" : "a draft again"}`);
  else console.info(`[newsletter] campaign ${id}: the ${locale} broadcast not marked not sent (${result.error})`);
  return result;
}

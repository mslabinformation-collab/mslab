import { and, desc, eq, sql } from "drizzle-orm";
import type { Db, Q } from "@/db/client";
import { newsletterCampaigns, type NewsletterCampaign } from "@/db/schema";
import { CAMPAIGN_LIMITS, campaignContentFor, checkCampaignDraft, isCampaignHref, ruFallsBack, type NewsletterCampaignDraft } from "@/domain/newsletter-campaign";
import { isWelcomeCode, normalizeWelcomeCode, WELCOME_CODE_MAX } from "@/domain/welcome-code";
import { adminEt } from "@/i18n/dict/admin";
import { isStorableImageKey, mediaUrl } from "@/lib/media";
import { toStorable } from "@/lib/to-storable";
import { campaignMail } from "./campaign-mail";
import { getInvoiceSettings } from "./invoices";

// Maria's newsletter campaigns (newsletter campaigns, Task 4; spec D4–D8, §5; rulings R2, R4, R5, R7, R9, R11): the drafts she writes on the
// „Kampaaniad“ tab, „Kopeeri“ and the live preview. The rules of a draft are domain/newsletter-campaign.ts and the mail is campaign-mail.ts
// campaignMail. Without Next.js: the actions (actions/admin-newsletter.ts) and the preview route call these. Logs carry ids and counts, never an
// address or a text of hers. The sending half (a mail to each subscriber under the day's room, „Saada proov“) is the 20.10 design's
// (docs/superpowers/specs/2026-10-20-newsletter-simple-design.md).

export type CampaignStatus = NewsletterCampaign["status"];
type Locale = "et" | "ru";

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

/** The unsubscribe link of a mail that is no real send: it opens the page that says it is a test and changes nothing (api/newsletter/loobu, `?proov`). */
const testUnsubscribeUrl = (siteUrl: string): string => `${siteUrl.replace(/\/+$/, "")}/api/newsletter/loobu?proov=1`;

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

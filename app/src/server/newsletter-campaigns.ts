import { and, asc, count, desc, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db, Q } from "@/db/client";
import { newsletterCampaigns, newsletterDeliveries, subscribers, type DeliveryStatus, type NewsletterCampaign, type NewsletterDelivery } from "@/db/schema";
import { isSampleAddress, normalizeEmail } from "@/domain/email";
import { CAMPAIGN_DAILY_ROOM, CAMPAIGN_LIMITS, campaignContentFor, checkCampaignDraft, isCampaignHref, ruFallsBack, type NewsletterCampaignDraft } from "@/domain/newsletter-campaign";
import { isWelcomeCode, normalizeWelcomeCode, WELCOME_CODE_MAX } from "@/domain/welcome-code";
import { adminEt } from "@/i18n/dict/admin";
import { isStorableImageKey, mediaUrl } from "@/lib/media";
import { toStorable } from "@/lib/to-storable";
import { campaignMail } from "./campaign-mail";
import { mailsSentToday } from "./client-auth";
import { getInvoiceSettings } from "./invoices";
import { logFailure } from "./log";
import { unsubscribeUrl } from "./newsletter";
import { sendMailResult, type Env, type MailOutcome } from "./notify";
import { forgetKey, releaseSlot, reserveSlot, windowKey, type TextKv } from "./ratelimit";

// Maria's newsletter campaigns (newsletter campaigns, Task 4; spec D4–D8, §5; rulings R2, R4, R5, R7, R9, R11): the drafts she writes on the
// „Kampaaniad“ tab, „Kopeeri“ and the live preview. The rules of a draft are domain/newsletter-campaign.ts and the mail is campaign-mail.ts
// campaignMail. Without Next.js: the actions (actions/admin-newsletter.ts), the preview route and the daily job (api/cron/uudiskiri) call these.
// Logs carry ids and counts, never an address, a token or a text of hers.
//
// The sending is the 20.10 design's (docs/superpowers/specs/2026-10-20-newsletter-simple-design.md §3, §5): one ordinary mail per subscriber.
// - The press („Saada kõigile“, startSend) writes one `newsletter_deliveries` row for each confirmed subscriber at that moment and sends the first
//   batch at once; the daily job (runDueCampaigns) sends the rest, a batch a day, until no row waits.
// - A batch (runBatch) sends while the day's count of every mail the site sent (client-auth.ts mailsSentToday) is below CAMPAIGN_DAILY_ROOM and
//   its time lasts. It claims one row at a time (FOR UPDATE SKIP LOCKED, committed before the send: two runners never take one row), sends it,
//   and writes its outcome to that row only while it is still `claimed`. Each outcome is one status (at most once, notify.ts MailOutcome): accepted
//   `sent`; the address refused `failed`; no answer `unknown`, never sent again; Resend's day or month limit, or any other refusal, back to
//   `waiting` and the batch stops. A claim older than STALE_CLAIM_MS belongs to a runner that died: `unknown`, never `waiting` again.
// - One campaign at a time: a press while another campaign is going out is `busy`.
// - „Peata saatmine“ (stopSend) skips what waits; „Saada proov“ (sendTest) is one counted mail to Maria or the signed-in admin.

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

/**
 * The headers of the mail program's own unsubscribe button (RFC 2369, RFC 8058 one-click): the same address as the mail's link. The route takes the
 * one-click POST (api/newsletter/loobu: the body `List-Unsubscribe=One-Click`, the token in the address).
 */
const unsubscribeHeaders = (href: string): Record<string, string> => ({ "List-Unsubscribe": `<${href}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });

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

// ---------- the sending (the 20.10 design) ----------

/**
 * How long a claimed delivery may wait for its outcome before it counts as `unknown` (Review Focus 1): longer than any runner can live (the daily
 * job's maxDuration, 300 s, api/cron/uudiskiri; the page's, 120 s, admin/uudiskiri) plus a margin. An older claim belongs to a runner that was
 * stopped after it claimed the row, perhaps after Resend accepted the mail: it is never sent again, and never put back to `waiting`.
 */
export const STALE_CLAIM_MS = 6 * 60_000;
/** The pause between two sends of a batch: Resend takes about 2 requests a second, shared with the site's other mails. */
export const SEND_GAP_MS = 600;
/**
 * The press's own time („Saada kõigile“ waits for its first batch): no new mail after it. A send begun at its end has 8 s, and once more after a 429
 * (notify.ts), so the page's maxDuration of 120 s holds (tests/db/newsletter-page.test.ts).
 */
export const PRESS_BUDGET_MS = 60_000;
/** The daily job's own time: its maxDuration (300 s) less a margin for a send begun at the end (17 s at most) and the queries. */
export const CRON_BUDGET_MS = 270_000;
/** This many answers in a row that say nothing (`unknown`) stop a batch: Resend is down, and the rest wait instead of all turning `unknown`. */
const UNKNOWN_IN_A_ROW = 3;
/** The rows the press writes in one statement. */
const INSERT_CHUNK = 500;

/**
 * What a send needs. `siteUrl` is SITE_URL: the links of the mails (the picture, the logo, her unsubscribe link), never a request's address, for a
 * mail is kept long after it. `now` is the clock (the room's UTC day, the claims' times). `deadline` (epoch ms): no new mail after it. `gapMs`: the
 * pause between two sends (SEND_GAP_MS unless told; the tests give 0). `send`: notify.ts sendMailResult unless a test fakes it; it is given the
 * database, and counts an accepted mail on the day's count as sendMailResult does.
 */
export type SendDeps = { db: Db; env: Env; siteUrl: string; now: () => Date; deadline: number; gapMs?: number; send?: typeof sendMailResult };

/** Where a campaign's deliveries stand. `waiting` includes the rows claimed now (their outcome not written yet); `total` is every row. */
export type Progress = { total: number; sent: number; waiting: number; failed: number; unknown: number; skipped: number };

/**
 * Why a batch stopped while rows still wait: `room` (the day's count reached CAMPAIGN_DAILY_ROOM, or Resend's own daily or monthly limit), `refused`
 * (Resend refused for a reason other than the address, or gave no answer that says three times in a row: „Saatmine peatus: Resend keeldus. Kirjuta
 * Dimile.“), `time` (the deadline). null: nothing waits any more, or the campaign is not going out.
 */
export type BatchStop = null | "room" | "refused" | "time";
export type BatchResult = { progress: Progress; stopped: BatchStop };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The deliveries of campaign `id` by status. */
export async function progressOf(q: Q, id: number): Promise<Progress> {
  const rows = await q
    .select({ status: newsletterDeliveries.status, n: count() })
    .from(newsletterDeliveries)
    .where(eq(newsletterDeliveries.campaignId, id))
    .groupBy(newsletterDeliveries.status);
  const n = (status: DeliveryStatus) => rows.find((r) => r.status === status)?.n ?? 0;
  const p = { sent: n("sent"), waiting: n("waiting") + n("claimed"), failed: n("failed"), unknown: n("unknown"), skipped: n("skipped") };
  return { total: p.sent + p.waiting + p.failed + p.unknown + p.skipped, ...p };
}

type Recipient = { email: string; locale: Locale; token: string };

/**
 * Who a press writes the list for (spec D7, §3; the plan's "Consent"): every confirmed `subscribers` row at this moment, oldest first, by its
 * address in lower case and once per address (a legacy pair of rows that differ only in case gets one mail: the older row's). Never a sample address
 * (`@example.test`, domain/email.ts isSampleAddress: the live checks and the demo data make such rows, and they are never mailed).
 */
async function recipientsNow(q: Q): Promise<Recipient[]> {
  const rows = await q
    .select({ email: subscribers.email, locale: subscribers.locale, token: subscribers.token })
    .from(subscribers)
    .where(isNotNull(subscribers.confirmedAt))
    .orderBy(asc(subscribers.id));
  const seen = new Set<string>();
  const list: Recipient[] = [];
  for (const r of rows) {
    const email = normalizeEmail(r.email);
    if (isSampleAddress(email) || seen.has(email)) continue;
    seen.add(email);
    list.push({ email, locale: r.locale === "ru" ? "ru" : "et", token: r.token });
  }
  return list;
}

const countsOf = (list: Recipient[]) => ({ et: list.filter((r) => r.locale === "et").length, ru: list.filter((r) => r.locale === "ru").length });

/** Every press takes this transaction lock first, so two presses (two tabs, two campaigns) are one after the other: one campaign at a time holds. */
const PRESS_LOCK = "newsletter-press";

type PressRefusal = "notFound" | "sent" | "busy" | "empty";

/**
 * What a press is decided on, inside its transaction: the press lock, then the campaign's row (FOR UPDATE), then the checks. The campaign is there
 * (`notFound`), still a draft (`sent`: sent, or going out already), no other campaign is going out (`busy`: spec §3 "One campaign at a time"), and
 * there is someone to send to (`empty`); with the recipients at this moment.
 */
async function pressState(t: Q, id: number): Promise<{ row: NewsletterCampaign; list: Recipient[] } | { error: PressRefusal }> {
  await t.execute(sql`select pg_advisory_xact_lock(hashtext(${PRESS_LOCK}))`);
  const [row] = await t.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, id)).for("update");
  if (!row) return { error: "notFound" };
  if (row.status !== "draft") return { error: "sent" };
  const [other] = await t
    .select({ id: newsletterCampaigns.id })
    .from(newsletterCampaigns)
    .where(and(eq(newsletterCampaigns.status, "sending"), ne(newsletterCampaigns.id, id)))
    .limit(1);
  if (other) return { error: "busy" };
  const list = await recipientsNow(t);
  if (list.length === 0) return { error: "empty" };
  return { row, list };
}

/**
 * „Saada kõigile“, before the confirmation: the confirmed subscribers by language as a press would write them now, whether the Russian ones get the
 * Estonian text (ruFallsBack), and `updatedAt`, the campaign's last change as this read it (ISO): the press goes only if both are still so. A
 * refusal in a code (pressState). Writes nothing.
 */
export async function prepareSend(
  db: Db,
  id: number,
): Promise<{ ok: true; et: number; ru: number; ruFallsBack: boolean; updatedAt: string } | { ok: false; error: PressRefusal }> {
  return db.transaction(async (t) => {
    const state = await pressState(t, id);
    if ("error" in state) return { ok: false as const, error: state.error };
    return { ok: true as const, ...countsOf(state.list), ruFallsBack: ruFallsBack(draftOf(state.row)), updatedAt: state.row.updatedAt.toISOString() };
  });
}

/**
 * „Saada kõigile“ after the confirmation: `confirmed` is what it showed (prepareSend's counts and `updatedAt`). In one transaction (pressState):
 * `changed` when the counts by language or the campaign moved since (nothing written, still a draft); else one delivery for each recipient, the
 * campaign `sending` with `recipients` the counts written. Then, after the commit, the first batch (runBatch) within `deps.deadline`.
 */
export async function startSend(
  deps: SendDeps,
  id: number,
  confirmed: { et: number; ru: number; updatedAt: string },
): Promise<({ ok: true } & BatchResult) | { ok: false; error: PressRefusal | "changed" }> {
  const written = await deps.db.transaction(async (t) => {
    const state = await pressState(t, id);
    if ("error" in state) return state.error;
    const counts = countsOf(state.list);
    if (counts.et !== confirmed.et || counts.ru !== confirmed.ru || state.row.updatedAt.getTime() !== Date.parse(confirmed.updatedAt)) return "changed" as const;
    for (let i = 0; i < state.list.length; i += INSERT_CHUNK) {
      await t.insert(newsletterDeliveries).values(state.list.slice(i, i + INSERT_CHUNK).map((r) => ({ campaignId: id, ...r })));
    }
    await t.update(newsletterCampaigns).set({ status: "sending", recipients: counts }).where(eq(newsletterCampaigns.id, id));
    return counts;
  });
  if (typeof written === "string") {
    console.info(`[newsletter] campaign ${id}: not pressed (${written})`);
    return { ok: false, error: written };
  }
  console.info(`[newsletter] campaign ${id}: pressed, ${written.et + written.ru} deliveries written (et ${written.et}, ru ${written.ru})`);
  return { ok: true, ...(await runBatch(deps, id)) };
}

/**
 * A claimed delivery older than STALE_CLAIM_MS becomes `unknown` (Review Focus 1): of campaign `id`, or of every campaign (the daily job, which
 * also reaches a campaign stopped while a dead runner held a claim). Never `waiting`: its mail may have gone.
 */
async function expireStaleClaims(db: Db, now: Date, id?: number): Promise<void> {
  const stale = await db
    .update(newsletterDeliveries)
    .set({ status: "unknown" })
    .where(
      and(
        eq(newsletterDeliveries.status, "claimed"),
        lt(newsletterDeliveries.claimedAt, new Date(now.getTime() - STALE_CLAIM_MS)),
        id === undefined ? undefined : eq(newsletterDeliveries.campaignId, id),
      ),
    )
    .returning();
  if (stale.length > 0) console.info(`[newsletter] ${stale.length} stale claims marked unknown (campaign ${[...new Set(stale.map((s) => s.campaignId))].join(", ")})`);
}

/**
 * The next waiting delivery of campaign `id`, claimed: in its own short transaction, the row locked FOR UPDATE SKIP LOCKED (a row another runner is
 * claiming is passed over, never waited for) and set `claimed` at `now`, committed before its send. null: none waits (or every waiting one is being
 * claimed by another runner right now).
 */
async function claimNext(db: Db, id: number, now: Date): Promise<NewsletterDelivery | null> {
  return db.transaction(async (t) => {
    const [next] = await t
      .select({ id: newsletterDeliveries.id })
      .from(newsletterDeliveries)
      .where(and(eq(newsletterDeliveries.campaignId, id), eq(newsletterDeliveries.status, "waiting")))
      .orderBy(asc(newsletterDeliveries.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!next) return null;
    const [claimed] = await t
      .update(newsletterDeliveries)
      .set({ status: "claimed", claimedAt: now })
      .where(and(eq(newsletterDeliveries.id, next.id), eq(newsletterDeliveries.status, "waiting")))
      .returning();
    return claimed ?? null;
  });
}

/**
 * Her consent right before her turn (spec §3 "On the way"): the token of her confirmed `subscribers` row, the one the press read (by its token) or one
 * of her address made since (she left and signed up again: the mail carries her new link); null when there is none (she unsubscribed: `skipped`).
 */
async function consentToken(q: Q, d: NewsletterDelivery): Promise<string | null> {
  const [row] = await q
    .select({ token: subscribers.token })
    .from(subscribers)
    .where(and(isNotNull(subscribers.confirmedAt), or(eq(subscribers.token, d.token), sql`lower(trim(${subscribers.email})) = ${d.email}`)))
    .orderBy(sql`${subscribers.token} = ${d.token} desc`, asc(subscribers.id))
    .limit(1);
  return row?.token ?? null;
}

/** The status an outcome gives its delivery (the plan's "At most once"): Resend's limits and its other refusals put it back to `waiting`. */
const statusOf = (o: MailOutcome): "sent" | "failed" | "unknown" | "waiting" =>
  o.ok ? "sent" : o.kind === "address" ? "failed" : o.kind === "unknown" ? "unknown" : "waiting";

/** Writes a claimed delivery's outcome, only while it is still `claimed` (by its id and that status): nothing else is ever overwritten. */
async function settle(db: Db, deliveryId: number, status: "sent" | "failed" | "unknown" | "waiting" | "skipped", now: Date): Promise<void> {
  const set = status === "waiting" ? { status, claimedAt: null } : status === "sent" ? { status, sentAt: now } : { status };
  const done = await db
    .update(newsletterDeliveries)
    .set(set)
    .where(and(eq(newsletterDeliveries.id, deliveryId), eq(newsletterDeliveries.status, "claimed")))
    .returning();
  if (done.length === 0) console.info(`[newsletter] delivery ${deliveryId}: no longer claimed, its outcome (${status}) not written`);
}

/** The deliveries of campaign `id` that went, by language. */
async function sentCounts(q: Q, id: number): Promise<{ et: number; ru: number }> {
  const rows = await q
    .select({ locale: newsletterDeliveries.locale, n: count() })
    .from(newsletterDeliveries)
    .where(and(eq(newsletterDeliveries.campaignId, id), eq(newsletterDeliveries.status, "sent")))
    .groupBy(newsletterDeliveries.locale);
  return { et: rows.find((r) => r.locale === "et")?.n ?? 0, ru: rows.find((r) => r.locale === "ru")?.n ?? 0 };
}

/**
 * When no delivery of campaign `id` waits or is claimed any more, the campaign is done: one going out becomes `sent`, at `now`, with `recipients` the
 * mails that went by language; one stopped meanwhile (`sent` already) gets its `recipients` again, now that its last claimed rows have their
 * outcome. true when done. (A row that is no longer waiting or claimed never changes again, so the counts stay right.)
 */
async function finishIfDone(db: Db, id: number, now: Date): Promise<boolean> {
  const [open] = await db
    .select({ id: newsletterDeliveries.id })
    .from(newsletterDeliveries)
    .where(and(eq(newsletterDeliveries.campaignId, id), inArray(newsletterDeliveries.status, ["waiting", "claimed"])))
    .limit(1);
  if (open) return false;
  const row = await getCampaign(db, id);
  if (!row || row.status === "draft") return false;
  const recipients = await sentCounts(db, id);
  if (row.status === "sent") {
    await db.update(newsletterCampaigns).set({ recipients }).where(and(eq(newsletterCampaigns.id, id), eq(newsletterCampaigns.status, "sent")));
    return true;
  }
  const done = await db
    .update(newsletterCampaigns)
    .set({ status: "sent", sentAt: now, recipients })
    .where(and(eq(newsletterCampaigns.id, id), eq(newsletterCampaigns.status, "sending")))
    .returning();
  if (done.length > 0) console.info(`[newsletter] campaign ${id}: sent, ${recipients.et + recipients.ru} mails went (et ${recipients.et}, ru ${recipients.ru})`);
  return true;
}

/**
 * The mark of a campaign whose last batch stopped because Resend refused (`refused`), so that the page can say so whoever ran the batch (the press or
 * the daily job); it goes with the campaign's next mail that Resend accepts. In the KV store, for a month at most. The page reads it only while the
 * campaign is going out (actions/admin-newsletter.ts progressAction).
 */
const refusedKey = (id: number) => `newsletter:refused:${id}`;
const REFUSED_MARK_SEC = 30 * 24 * 60 * 60;

/** Did the last batch of campaign `id` stop because Resend refused, with no mail of it accepted since? */
export async function sendRefused(kv: TextKv, id: number): Promise<boolean> {
  return (await kv.get(refusedKey(id))) !== null;
}

/**
 * One batch of campaign `id` (the press's first, or the daily job's). First, its stale claims become `unknown`. Then, while the day's count of every
 * mail is below CAMPAIGN_DAILY_ROOM and `deps.deadline` has not come: claim one waiting row (claimNext), skip it when her consent is gone
 * (consentToken: `skipped`), else send her the campaign in her language (the Estonian text under her own footer when the Russian one is missing)
 * with her own unsubscribe link and the List-Unsubscribe headers, and write the outcome (statusOf). SEND_GAP_MS between two sends. Resend's limits
 * stop the batch (`room`), and so does any other refusal (`refused`, and the mark: sendRefused) or three unknown answers in a row. When no row waits
 * or is claimed any more, the campaign is `sent` (finishIfDone). A campaign that is not going out is left as it is.
 */
export async function runBatch(deps: SendDeps, id: number): Promise<BatchResult> {
  const { db } = deps;
  await expireStaleClaims(db, deps.now(), id);
  const row = await getCampaign(db, id);
  if (!row || row.status !== "sending") return { progress: await progressOf(db, id), stopped: null };
  const draft = draftOf(row);
  const school = await schoolOf(db, deps.now());
  const send = deps.send ?? sendMailResult;
  const gapMs = deps.gapMs ?? SEND_GAP_MS;
  const kv = deps.env.KV;
  let marked = await sendRefused(kv, id).catch((e) => {
    logFailure(`[newsletter] campaign ${id}: the refusal mark unavailable`, e);
    return false;
  });
  const tally = { sent: 0, failed: 0, unknown: 0, skipped: 0 };
  let stopped: BatchStop = null;
  let mailed = false; // a mail went to Resend just before: the next one waits gapMs
  let unknownInARow = 0;
  for (;;) {
    if (mailed && gapMs > 0) await sleep(gapMs);
    mailed = false;
    if (deps.now().getTime() >= deps.deadline) {
      stopped = "time";
      break;
    }
    if ((await mailsSentToday(db, deps.now())) >= CAMPAIGN_DAILY_ROOM) {
      stopped = "room";
      break;
    }
    const delivery = await claimNext(db, id, deps.now());
    if (!delivery) break;
    const token = await consentToken(db, delivery);
    if (token === null) {
      await settle(db, delivery.id, "skipped", deps.now());
      tally.skipped++;
      continue;
    }
    const href = unsubscribeUrl(deps.siteUrl, token);
    const mail = mailOf(draft, delivery.locale, { siteUrl: deps.siteUrl, school, unsubscribeHref: href, test: false });
    let outcome: MailOutcome;
    try {
      outcome = await send(deps.env, { to: delivery.email, ...mail, headers: unsubscribeHeaders(href) }, { count: db });
    } catch (e) {
      logFailure(`[newsletter] campaign ${id}: delivery ${delivery.id}: the send failed`, e);
      outcome = { ok: false, kind: "unknown" };
    }
    mailed = true;
    await settle(db, delivery.id, statusOf(outcome), deps.now());
    if (outcome.ok) {
      tally.sent++;
      unknownInARow = 0;
      if (marked) {
        await forgetKey(kv, refusedKey(id)).catch((e) => logFailure(`[newsletter] campaign ${id}: the refusal mark not removed`, e));
        marked = false;
      }
      continue;
    }
    if (outcome.kind === "address") {
      tally.failed++;
      unknownInARow = 0;
      continue;
    }
    if (outcome.kind === "unknown") {
      tally.unknown++;
      if (++unknownInARow < UNKNOWN_IN_A_ROW) continue;
    }
    stopped = outcome.kind === "quota" ? "room" : "refused";
    break;
  }
  if (await finishIfDone(db, id, deps.now())) stopped = null;
  else if (stopped === "refused") {
    await kv.put(refusedKey(id), deps.now().toISOString(), { expirationTtl: REFUSED_MARK_SEC }).catch((e) => logFailure(`[newsletter] campaign ${id}: the refusal mark not written`, e));
  }
  const progress = await progressOf(db, id);
  console.info(
    `[newsletter] campaign ${id}: batch: ${tally.sent} sent, ${tally.failed} failed, ${tally.unknown} unknown, ${tally.skipped} skipped; ${progress.waiting} of ${progress.total} left${stopped ? `, stopped (${stopped})` : ""}`,
  );
  return { progress, stopped };
}

/**
 * „Peata saatmine“ (spec §3, Draft): every waiting delivery of campaign `id` becomes `skipped` and the campaign is `sent` at `now`, `recipients` the
 * mails that went. A row claimed by a batch that runs meanwhile is left to it (Review Focus 5): it finishes that one, sends nothing more (nothing
 * waits), and the campaign's counts follow (finishIfDone). `notFound`; `notSending` for a draft or a campaign sent already.
 */
export async function stopSend(db: Db, id: number, now: Date): Promise<{ ok: true; progress: Progress } | { ok: false; error: "notFound" | "notSending" }> {
  const result = await db.transaction(async (t) => {
    const [row] = await t.select({ status: newsletterCampaigns.status }).from(newsletterCampaigns).where(eq(newsletterCampaigns.id, id)).for("update");
    if (!row) return "notFound" as const;
    if (row.status !== "sending") return "notSending" as const;
    const skipped = await t
      .update(newsletterDeliveries)
      .set({ status: "skipped" })
      .where(and(eq(newsletterDeliveries.campaignId, id), eq(newsletterDeliveries.status, "waiting")))
      .returning();
    await t.update(newsletterCampaigns).set({ status: "sent", sentAt: now, recipients: await sentCounts(t, id) }).where(eq(newsletterCampaigns.id, id));
    return skipped.length;
  });
  if (typeof result === "string") return { ok: false, error: result };
  console.info(`[newsletter] campaign ${id}: stopped, ${result} waiting deliveries skipped`);
  return { ok: true, progress: await progressOf(db, id) };
}

/** „Saada proov“ at most this many an hour (spec D6). */
export const TEST_SEND_LIMIT = 10;
const TEST_WINDOW_SEC = 60 * 60;
/** The test sends' counter (a fixed clock hour: ratelimit.ts windowKey; the entry lives for two windows). */
const TEST_KEY = "newsletter:proov";

/**
 * „Saada proov“: the stored campaign `id` in `locale` as one ordinary mail to `to` (Maria's address or the signed-in admin's: the action decides),
 * the very mail of a send but for „[Proov] “ before the subject and the test page behind its link and its List-Unsubscribe headers
 * (api/newsletter/loobu?proov=1: it changes nothing). Counted like every mail. At most TEST_SEND_LIMIT an hour (`limited`, nothing sent); one that
 * did not go (`mail`) is not counted against the hour. Any campaign, sent or not: Maria can still write and test.
 */
export async function sendTest(deps: SendDeps, id: number, to: string, locale: Locale): Promise<{ ok: true } | { ok: false; error: "notFound" | "mail" | "limited" }> {
  const row = await getCampaign(deps.db, id);
  if (!row) return { ok: false, error: "notFound" };
  const now = deps.now();
  const kv = deps.env.KV;
  const key = windowKey(TEST_KEY, now, TEST_WINDOW_SEC);
  if (!(await reserveSlot(kv, key, TEST_SEND_LIMIT, 2 * TEST_WINDOW_SEC))) {
    console.info(`[newsletter] campaign ${id}: a test refused, ${TEST_SEND_LIMIT} this hour already`);
    return { ok: false, error: "limited" };
  }
  let went = false;
  try {
    const href = testUnsubscribeUrl(deps.siteUrl);
    const mail = mailOf(draftOf(row), locale, { siteUrl: deps.siteUrl, school: await schoolOf(deps.db, now), unsubscribeHref: href, test: true });
    const outcome = await (deps.send ?? sendMailResult)(deps.env, { to, ...mail, headers: unsubscribeHeaders(href) }, { count: deps.db });
    went = outcome.ok;
    if (!outcome.ok) console.info(`[newsletter] campaign ${id}: the test did not go (${outcome.kind})`);
  } finally {
    if (!went) await releaseSlot(kv, key, 2 * TEST_WINDOW_SEC).catch((e) => logFailure(`[newsletter] campaign ${id}: the test's place not given back`, e));
  }
  if (!went) return { ok: false, error: "mail" };
  console.info(`[newsletter] campaign ${id}: a test sent (${locale})`);
  return { ok: true };
}

/**
 * The daily job (api/cron/uudiskiri): every stale claim becomes `unknown`, then the one campaign going out, if any, gets its batch. `campaignId` null:
 * nothing is going out.
 */
export async function runDueCampaigns(deps: SendDeps): Promise<{ campaignId: number | null; progress: Progress | null; stopped: BatchStop }> {
  await expireStaleClaims(deps.db, deps.now());
  const [due] = await deps.db
    .select({ id: newsletterCampaigns.id })
    .from(newsletterCampaigns)
    .where(eq(newsletterCampaigns.status, "sending"))
    .orderBy(asc(newsletterCampaigns.id))
    .limit(1);
  if (!due) return { campaignId: null, progress: null, stopped: null };
  return { campaignId: due.id, ...(await runBatch(deps, due.id)) };
}

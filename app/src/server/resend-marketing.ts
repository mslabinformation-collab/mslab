import { and, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from "drizzle-orm";
import { Resend, type WebhookEventPayload } from "resend";
import type { Db, Q } from "@/db/client";
import { readSetting } from "@/db/queries/public";
import { mailSuppressions, settings, subscribers } from "@/db/schema";
import { isEmail, isSampleAddress, normalizeEmail } from "@/domain/email";
import { RESEND_FREE_CONTACTS } from "@/domain/newsletter-campaign";
import { errorSummary, logNote } from "./log";
import { unsubscribeUrl } from "./newsletter";
import { NOTIFY_TIMEOUT_MS, RATE_LIMIT_RETRY_MS, rateLimited, withTimeout, type Env } from "./notify";

// The newsletter's side in Resend (newsletter campaigns, spec D1–D3, D7, D8, D10). The site's `subscribers` stay the record of consent, and
// Resend's marketing contacts follow them: every confirmed row has one contact, subscribed, in the segment of its language („MS LAB uudiskiri
// (ET)" or „(RU)", made on first use and kept under the setting `resend_segments`), with the contact property `unsubscribe_url` holding her own
// unsubscribe link (the site's page, D3); an address without a confirmed row, or a sample address (`@example.test`, never mailed), is in
// neither segment. Only those two segments are the site's (ruling R6): a contact leaving them is deleted only when it is in no other segment
// of Maria's account, and a contact in neither of them is never touched. Each change to a row syncs that address after its
// commit (syncAddress, best effort: a failure leaves `synced_at` null and never fails her action), and the full sync (fullSync: before a
// send, the admin's button, the daily cron) puts everything right. What happens on Resend's side comes back: an unsubscribe there deletes the
// row (the full sync's read of the contacts, and the webhook's contact.updated), and a suppression (bounce, spam mark) is recorded in
// mail_suppressions. A consent given on the site after a Resend-side unsubscribe wins (ruling R1). Every Resend call has a timeout, a 429 is
// tried once more, and calls in a row keep MARKETING_GAP_MS apart. The logs carry counts and ids, never an address. Tests inject `resend`.

/** The contact property that carries her own unsubscribe link: `${SITE_URL}/api/newsletter/loobu?t=<her token>`. */
export const UNSUBSCRIBE_PROPERTY = "unsubscribe_url";
/**
 * Where a broadcast's HTML and text take her unsubscribe link (Task 4: the footer's link). Resend fills contact data into a broadcast with
 * `{{{contact.<key>}}}` (resend.com/docs/dashboard/broadcasts/editor, "{{{contact.first_name|fallback}}}"); the triple braces leave the URL
 * unescaped. A custom property needs its definition first (resend.com/docs/dashboard/contacts/properties): ensureSegments makes it.
 */
export const UNSUBSCRIBE_PLACEHOLDER = "{{{contact.unsubscribe_url}}}";
/** The two segments, one per language (spec D2). */
export const SEGMENT_NAMES = { et: "MS LAB uudiskiri (ET)", ru: "MS LAB uudiskiri (RU)" } as const;
/** The setting that keeps the ids of the segments and of the property: `{ et, ru, property }`. */
export const SEGMENTS_SETTING = "resend_segments";
/** The pause between two Resend calls in a row (at most 2 a second, as protocols.ts MAIL_GAP_MS). */
export const MARKETING_GAP_MS = 600;
/** Pages read of one list at most (100 entries each): far beyond the plan's contacts. */
const MAX_PAGES = 200;
/** Consecutive contacts that fail before the full sync leaves the rest for the next run. */
const FAILURES_IN_A_ROW = 3;

type Locale = "et" | "ru";
export type Segments = { et: string; ru: string };

/** A Resend answer as the SDK gives it: data, or an error with the API's name and HTTP status (its message is never logged). */
type ApiError = { name?: string | null; statusCode?: number | null; message?: string | null; summary?: string };
type Answer<T> = { data: T | null; error: ApiError | null };
type Page<T> = { data: T[]; has_more: boolean };
type ContactView = { id: string; email: string; unsubscribed: boolean };
/** A contact by its id or by its address (an address goes into the URL's path: pathEmail). */
type ContactKey = { id: string } | { email: string };

/**
 * The part of the resend package (6.31) the newsletter uses; `new Resend(key)` is one, and the tests pass an in-memory fake. Contacts are the
 * team's, segments replace the old audiences.
 */
export type ResendLike = {
  contacts: {
    list(o: { segmentId?: string; limit: number; after?: string }): Promise<Answer<Page<ContactView>>>;
    get(o: ContactKey): Promise<Answer<ContactView>>;
    create(o: { email: string; unsubscribed: boolean; properties: Record<string, string>; segments: { id: string }[] }): Promise<Answer<{ id: string }>>;
    update(o: ContactKey & { unsubscribed?: boolean; properties: Record<string, string> }): Promise<Answer<{ id: string }>>;
    remove(o: ContactKey): Promise<Answer<unknown>>;
    segments: {
      list(o: { contactId: string; limit: number; after?: string }): Promise<Answer<Page<{ id: string }>>>;
      add(o: { contactId: string; segmentId: string }): Promise<Answer<unknown>>;
      remove(o: { contactId: string; segmentId: string }): Promise<Answer<unknown>>;
    };
  };
  segments: {
    list(o: { limit: number; after?: string }): Promise<Answer<Page<{ id: string; name: string }>>>;
    create(o: { name: string }): Promise<Answer<{ id: string }>>;
  };
  contactProperties: {
    list(o: { limit: number; after?: string }): Promise<Answer<Page<{ id: string; key: string }>>>;
    create(o: { key: string; type: "string" }): Promise<Answer<{ id: string }>>;
  };
  suppressions: { list(o: { limit: number; after?: string }): Promise<Answer<Page<{ id: string; email: string; origin: string; created_at: string }>>> };
  usage: { get(): Promise<Answer<{ contacts: { used: number; limit: number } }>> };
  webhooks: { verify(o: { payload: string; headers: { id: string; timestamp: string; signature: string }; webhookSecret: string }): WebhookEventPayload };
};

/**
 * What the newsletter's Resend work needs. `siteUrl`: the base of the unsubscribe link in the contact property (SITE_URL: one stable address).
 * `now`: the sync's time (synced_at; the start the R1 check compares with). `resend`: the client (the tests' fake; absent: the resend package
 * with the marketing key). `gapMs`: the pause between calls (MARKETING_GAP_MS when absent; the tests pass 0, which also skips the second
 * before a 429's retry). `budgetMs`: the full sync's time budget, after which it starts no call (absent: none).
 */
export type MarketingDeps = { db: Db; env: Env; siteUrl: string; now: Date; resend?: ResendLike; gapMs?: number; budgetMs?: number };

/**
 * Resend could not be reached, or refused the sync (spec §5: „Resendiga ei saanud ühendust — proovi hiljem uuesti."). `code` is the API's error
 * name ("restricted_api_key", "not_configured", …), `statusCode` its HTTP status: errorSummary logs both, never a message.
 */
export class MarketingUnavailable extends Error {
  readonly code?: string;
  readonly statusCode?: number;
  /** Which call failed ("contacts.list"), for the log. */
  readonly step?: string;
  constructor(error?: ApiError | null, step?: string) {
    super("Resend unavailable");
    this.name = "MarketingUnavailable";
    if (error?.name) this.code = error.name;
    if (typeof error?.statusCode === "number") this.statusCode = error.statusCode;
    this.step = step;
  }
}

/** The full sync's time budget is spent: no new call (caught by fullSync). */
class OutOfTime extends Error {
  constructor() {
    super("out of time");
    this.name = "OutOfTime";
  }
}

/** The key of the newsletter's calls: RESEND_MARKETING_KEY, else RESEND_API_KEY (spec §4); undefined without either. */
export const marketingKey = (env: Pick<Env, "RESEND_MARKETING_KEY" | "RESEND_API_KEY">): string | undefined => env.RESEND_MARKETING_KEY || env.RESEND_API_KEY || undefined;

/** Is the newsletter's Resend side set up? Without a key nothing is synced or sent, and nothing fails ("not set up"). Logs nothing. */
export const marketingConfigured = (env: Pick<Env, "RESEND_MARKETING_KEY" | "RESEND_API_KEY">): boolean => Boolean(marketingKey(env));

const client = (deps: MarketingDeps): ResendLike => deps.resend ?? new Resend(marketingKey(deps.env));

/** The resend package's webhook check (svix signatures). verify() never uses the key, so without one a placeholder makes the client. */
export function webhookVerifier(env: Env): Pick<ResendLike, "webhooks"> {
  return new Resend(marketingKey(env) ?? "re_webhook_verify_only");
}

/** The address as a path segment (the SDK puts it into the URL as it is): what a path cannot hold is percent-encoded; an ordinary address stays. */
const pathEmail = (address: string): string => address.replace(/[^A-Za-z0-9._~!$&'()*+,;=:@-]/g, (c) => encodeURIComponent(c));

const isNotFound = (e: ApiError | null): boolean => e?.name === "not_found" || e?.statusCode === 404;
/** Did Resend refuse a new contact because the plan's contacts are used up? (Read from the message, which is never logged.) */
const contactLimit = (e: ApiError | null): boolean => /contacts?\s+(quota|limit)|(quota|limit)\b.*\bcontacts?\b/i.test(e?.message ?? "");
const summaryOf = (e: unknown): string => {
  const summary = (e as ApiError | null)?.summary ?? errorSummary(e);
  return e instanceof MarketingUnavailable && e.step ? `${summary} at ${e.step}` : summary;
};

/** Logs a failure by its summary; a key that may only send gets the note that the newsletter needs a full-access key. */
function noteFailure(where: string, e: unknown): void {
  console.error(`${where}: ${summaryOf(e)}`);
  const name = e instanceof MarketingUnavailable ? e.code : (e as ApiError | null)?.name;
  if (name === "restricted_api_key")
    logNote("[newsletter-sync] the Resend key may only send e-mails: contacts, segments and broadcasts need a full-access key (RESEND_MARKETING_KEY)");
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** One Resend call: its answer, or (when it throws or times out) an error with the summary of what was thrown. */
type Call = <T>(run: () => Promise<Answer<T>>) => Promise<Answer<T>>;

/**
 * The calls of one piece of work: each waits until `gapMs` after the one before, has NOTIFY_TIMEOUT_MS, and is tried once more after a 429 (as
 * notify.ts sendMail). After `deadline` (epoch ms) no call starts: OutOfTime.
 */
function pacer(deps: MarketingDeps, deadline = Number.POSITIVE_INFINITY): Call {
  const gap = deps.gapMs ?? MARKETING_GAP_MS;
  const retryWait = deps.gapMs === 0 ? 0 : RATE_LIMIT_RETRY_MS;
  let last = Number.NEGATIVE_INFINITY;
  const once = async <T>(run: () => Promise<Answer<T>>): Promise<Answer<T>> => {
    await sleep(last + gap - Date.now());
    try {
      return await withTimeout(run(), NOTIFY_TIMEOUT_MS);
    } catch (e) {
      return { data: null, error: { name: "request_failed", statusCode: null, summary: errorSummary(e) } };
    } finally {
      last = Date.now();
    }
  };
  return async <T>(run: () => Promise<Answer<T>>): Promise<Answer<T>> => {
    if (Date.now() >= deadline) throw new OutOfTime();
    let answer = await once(run);
    if (answer.error && rateLimited(answer.error)) {
      console.info("[newsletter-sync] Resend asks for fewer requests: the call is tried once more");
      await sleep(retryWait);
      answer = await once(run);
    }
    return answer;
  };
}

/** Every entry of a paged list (100 a page); MarketingUnavailable when a page is not answered. */
async function listAll<T extends { id: string }>(call: Call, step: string, page: (after?: string) => Promise<Answer<Page<T>>>): Promise<T[]> {
  const all: T[] = [];
  let after: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const answer = await call(() => page(after));
    if (!answer.data) throw new MarketingUnavailable(answer.error, step);
    all.push(...answer.data.data);
    if (!answer.data.has_more || answer.data.data.length === 0) return all;
    after = answer.data.data[answer.data.data.length - 1].id;
  }
  throw new MarketingUnavailable({ name: "too_many_pages" }, step);
}

// ---------- the segments and the property ----------

function storedSegments(value: unknown): Segments | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const id = (x: unknown) => typeof x === "string" && x.length > 0;
  return id(v.et) && id(v.ru) && id(v.property) ? { et: v.et as string, ru: v.ru as string } : null;
}

/**
 * The two segments' ids. The first time: under a transaction lock (two first syncs at once make them once), the segments that Resend already has
 * by these names are taken (a run that failed before storing them), the others are made, and so is the string property unsubscribe_url when
 * Resend has no definition of it; the ids are stored under SEGMENTS_SETTING. Afterwards only the setting is read. MarketingUnavailable when it
 * is not set up (code not_configured) or Resend fails; nothing is stored then.
 */
export async function ensureSegments(deps: MarketingDeps): Promise<Segments> {
  if (!marketingConfigured(deps.env)) throw new MarketingUnavailable({ name: "not_configured" });
  return segmentsWith(deps, pacer(deps));
}

async function segmentsWith(deps: MarketingDeps, call: Call): Promise<Segments> {
  const stored = storedSegments(await readSetting(deps.db, SEGMENTS_SETTING));
  if (stored) return stored;
  const r = client(deps);
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${SEGMENTS_SETTING}))`);
    const again = storedSegments(await readSetting(tx, SEGMENTS_SETTING));
    if (again) return again;
    const listed = await call(() => r.segments.list({ limit: 100 }));
    if (!listed.data) throw new MarketingUnavailable(listed.error, "segments.list");
    const ids: Partial<Segments> = {};
    for (const locale of ["et", "ru"] as const) {
      const found = listed.data.data.find((s) => s.name === SEGMENT_NAMES[locale]);
      if (found) {
        ids[locale] = found.id;
        continue;
      }
      const made = await call(() => r.segments.create({ name: SEGMENT_NAMES[locale] }));
      if (!made.data) throw new MarketingUnavailable(made.error, "segments.create");
      ids[locale] = made.data.id;
    }
    const properties = await call(() => r.contactProperties.list({ limit: 100 }));
    if (!properties.data) throw new MarketingUnavailable(properties.error, "contactProperties.list");
    let property = properties.data.data.find((p) => p.key === UNSUBSCRIBE_PROPERTY)?.id;
    if (!property) {
      const made = await call(() => r.contactProperties.create({ key: UNSUBSCRIBE_PROPERTY, type: "string" }));
      if (!made.data) throw new MarketingUnavailable(made.error, "contactProperties.create");
      property = made.data.id;
    }
    const value = { et: ids.et!, ru: ids.ru!, property };
    await tx.insert(settings).values({ key: SEGMENTS_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    console.info(`[newsletter-sync] Resend set up: segment ${value.et} (et), segment ${value.ru} (ru), contact property ${property}`);
    return { et: value.et, ru: value.ru };
  });
}

// ---------- one row ----------

/** A subscriber row as the sync reads it; `address` is its e-mail in lower case. */
type Row = {
  id: number;
  email: string;
  address: string;
  locale: string;
  token: string;
  consentAt: Date;
  confirmedAt: Date | null;
  syncedAt: Date | null;
  resendContactId: string | null;
};

const rowLocale = (locale: string): Locale => (locale === "ru" ? "ru" : "et");
const otherLocale = (locale: Locale): Locale => (locale === "ru" ? "et" : "ru");
const COLUMNS = {
  id: subscribers.id,
  email: subscribers.email,
  locale: subscribers.locale,
  token: subscribers.token,
  consentAt: subscribers.consentAt,
  confirmedAt: subscribers.confirmedAt,
  syncedAt: subscribers.syncedAt,
  resendContactId: subscribers.resendContactId,
};
const asRow = (r: Omit<Row, "address">): Row => ({ ...r, address: normalizeEmail(r.email) });
const sameAddress = (address: string) => sql`lower(${subscribers.email}) = ${address}`;

/**
 * A row the newsletter goes to: confirmed (D7), and not a sample address (`@example.test`, domain/email.ts isSampleAddress: the live checks and
 * `npm run db:demo` make such rows, and they are never mailed; ruling R6). Only these have a contact in our segments.
 */
const isRecipient = (row: Row): boolean => row.confirmedAt !== null && !isSampleAddress(row.address);

async function rowOf(db: Db, address: string): Promise<Row | null> {
  const [row] = await db.select(COLUMNS).from(subscribers).where(sameAddress(address)).orderBy(subscribers.id).limit(1);
  return row ? asRow(row) : null;
}

/**
 * Ruling R1: an unsubscribe made in Resend deletes a row only when the row was synced before this sync started (nothing changed on the site
 * since the site last told Resend about her, and no sync of hers ran while this one read Resend's contacts) and its consent is older than the
 * sync too. An unsynced row is a new consent whose sync has not run yet: it is pushed.
 */
const pullsUnsubscribe = (row: Row, start: Date): boolean => row.syncedAt !== null && row.syncedAt < start && row.consentAt < start;

/** Deletes a row for a Resend-side unsubscribe, unless it changed meanwhile (R1 checked again in the statement); true when it went. */
async function pullRow(deps: MarketingDeps, row: Row): Promise<boolean> {
  const gone = await deps.db
    .delete(subscribers)
    .where(and(eq(subscribers.id, row.id), lt(subscribers.syncedAt, deps.now), lt(subscribers.consentAt, deps.now)))
    .returning();
  return gone.length > 0;
}

/** Contacts the site has made (rows with a contact id): the address sync's count against the plan's limit. */
async function contactRows(db: Db): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(subscribers).where(isNotNull(subscribers.resendContactId));
  return n;
}

/** Her contact as Resend has it: its id, whether it unsubscribed, and its segments. */
type ContactState = { id: string; unsubscribed: boolean; segments: Set<string> };

/** The segments of a contact (a few at most, so one page). MarketingUnavailable (code not_found for a contact that is gone) when not answered. */
async function segmentsOf(call: Call, r: ResendLike, contactId: string): Promise<Set<string>> {
  const listed = await listAll(call, "contacts.segments.list", (after) => r.contacts.segments.list({ contactId, limit: 100, after }));
  return new Set(listed.map((s) => s.id));
}

/** What became of a contact taken out of the newsletter. */
type Release = "deleted" | "unlinked" | "untouched" | "failed";

/**
 * Takes a contact out of the newsletter (ruling R6): out of our two segments, and deleted only when it is in no other segment (Maria's own
 * segments, the „(proov)" test segment of Task 4), so that nothing of hers outside the newsletter is lost. A contact in neither of ours is not
 * touched ("untouched"), nor is one already gone.
 */
async function releaseContact(call: Call, r: ResendLike, segments: Segments, contactId: string): Promise<Release> {
  let theirs: Set<string>;
  try {
    theirs = await segmentsOf(call, r, contactId);
  } catch (e) {
    if (e instanceof OutOfTime) throw e;
    if (e instanceof MarketingUnavailable && e.code === "not_found") return "untouched";
    noteFailure(`[newsletter-sync] contact ${contactId}: its segments not read`, e);
    return "failed";
  }
  const ours = [segments.et, segments.ru].filter((id) => theirs.has(id));
  if (ours.length === 0) return "untouched";
  if (ours.length === theirs.size) {
    const removed = await call(() => r.contacts.remove({ id: contactId }));
    if (removed.error && !isNotFound(removed.error)) {
      noteFailure(`[newsletter-sync] contact ${contactId} not deleted`, removed.error);
      return "failed";
    }
    return "deleted";
  }
  for (const segmentId of ours) {
    const out = await call(() => r.contacts.segments.remove({ contactId, segmentId }));
    if (out.error && !isNotFound(out.error)) {
      noteFailure(`[newsletter-sync] contact ${contactId} not removed from segment ${segmentId}`, out.error);
      return "failed";
    }
  }
  return "unlinked";
}

type PushContext = { deps: MarketingDeps; r: ResendLike; call: Call; segments: Segments; room: () => Promise<boolean> | boolean };
/** What a push did. "vanished": the row went while it was pushed (she unsubscribed meanwhile), and her contact was taken out again (`release`). */
type PushOutcome = { kind: "added" } | { kind: "updated" } | { kind: "limit" } | { kind: "failed" } | { kind: "vanished"; created: boolean; release: Release };

/**
 * Tells Resend about one recipient row: a new contact (when `room()` allows one more), subscribed, or her contact updated. Either way with the
 * property unsubscribe_url, in her language's segment and not the other. An update sets her back to subscribed only for a fresh consent (R1: the
 * row is unsynced and her contact unsubscribed in Resend); any other push (the property put right, a segment move) leaves Resend's
 * `unsubscribed` as it is, so a view read earlier never undoes an unsubscribe made since. Then the row is marked synced, with the contact's id,
 * unless it changed meanwhile (its language, its token, its confirmation): then it stays unsynced for the next sync. When the row went
 * meanwhile and the address has no recipient row left, the contact is taken out of the newsletter again at once.
 */
async function pushRow(ctx: PushContext, row: Row, contact: ContactState | null): Promise<PushOutcome> {
  const { r, call } = ctx;
  const locale = rowLocale(row.locale);
  const want = ctx.segments[locale];
  const other = ctx.segments[otherLocale(locale)];
  const properties = { [UNSUBSCRIBE_PROPERTY]: unsubscribeUrl(ctx.deps.siteUrl, row.token) };
  let id: string;
  if (!contact) {
    if (!(await ctx.room())) return { kind: "limit" };
    const made = await call(() => r.contacts.create({ email: row.address, unsubscribed: false, properties, segments: [{ id: want }] }));
    if (!made.data) {
      if (contactLimit(made.error)) return { kind: "limit" };
      noteFailure(`[newsletter-sync] subscriber ${row.id}: contact not created`, made.error);
      return { kind: "failed" };
    }
    id = made.data.id;
  } else {
    id = contact.id;
    const resubscribe = contact.unsubscribed && row.syncedAt === null;
    const updated = await call(() => r.contacts.update({ id, properties, ...(resubscribe ? { unsubscribed: false } : {}) }));
    if (updated.error) {
      noteFailure(`[newsletter-sync] subscriber ${row.id}: contact ${id} not updated`, updated.error);
      return { kind: "failed" };
    }
    if (!contact.segments.has(want)) {
      const added = await call(() => r.contacts.segments.add({ contactId: id, segmentId: want }));
      if (added.error) {
        noteFailure(`[newsletter-sync] subscriber ${row.id}: contact ${id} not added to segment ${want}`, added.error);
        return { kind: "failed" };
      }
    }
    if (contact.segments.has(other)) {
      const removed = await call(() => r.contacts.segments.remove({ contactId: id, segmentId: other }));
      if (removed.error && !isNotFound(removed.error)) {
        noteFailure(`[newsletter-sync] subscriber ${row.id}: contact ${id} not removed from segment ${other}`, removed.error);
        return { kind: "failed" };
      }
    }
  }
  const marked = await ctx.deps.db
    .update(subscribers)
    .set({ syncedAt: ctx.deps.now, resendContactId: id })
    .where(and(eq(subscribers.id, row.id), eq(subscribers.locale, row.locale), eq(subscribers.token, row.token), isNotNull(subscribers.confirmedAt)))
    .returning();
  if (marked.length > 0) return { kind: contact ? "updated" : "added" };
  const current = await rowOf(ctx.deps.db, row.address);
  if (current && isRecipient(current)) return { kind: contact ? "updated" : "added" }; // changed meanwhile: unsynced, for the next sync
  const release = await releaseContact(call, r, ctx.segments, id);
  console.info(`[newsletter-sync] subscriber ${row.id} went while it was synced: contact ${id} ${release}`);
  return { kind: "vanished", created: !contact, release };
}

export type SyncOutcome = "synced" | "removed" | "skipped" | "failed";

/**
 * Syncs one address after a change to its row has committed. A confirmed row: her contact made or updated (pushRow). No row, or one of the old
 * double opt-in never confirmed: her contact leaves our segments, and is deleted when it is in no other one (R6; none is fine). A contact
 * unsubscribed in Resend whose row was synced before and is older (R1): the row is deleted, then the contact taken out. "skipped": not set
 * up, a sample address (never synced, R6), or the plan's contacts are used up (the row stays unsynced; the full sync reports it). Never
 * throws: a failure is logged without the address and leaves the row unsynced ("failed").
 */
export async function syncAddress(deps: MarketingDeps, email: string): Promise<SyncOutcome> {
  if (!marketingConfigured(deps.env)) return "skipped";
  const address = normalizeEmail(email);
  if (isSampleAddress(address)) {
    console.info("[newsletter-sync] a sample address (@example.test) is never synced");
    return "skipped";
  }
  try {
    const call = pacer(deps);
    const r = client(deps);
    const row = await rowOf(deps.db, address);
    if (!row?.confirmedAt) {
      const stored = storedSegments(await readSetting(deps.db, SEGMENTS_SETTING));
      if (!stored) {
        console.info("[newsletter-sync] address synced: no confirmed subscriber, and no segment of ours yet");
        return "removed";
      }
      const found = await call(() => r.contacts.get({ email: pathEmail(address) }));
      if (found.error && !isNotFound(found.error)) {
        noteFailure(`[newsletter-sync] address sync: contact not read${row ? ` (subscriber ${row.id})` : ""}`, found.error);
        return "failed";
      }
      const release = found.data ? await releaseContact(call, r, stored, found.data.id) : "untouched";
      if (release === "failed") return "failed";
      console.info(`[newsletter-sync] address synced: no confirmed subscriber${row ? ` (subscriber ${row.id} unconfirmed)` : ""}, contact ${release}`);
      return "removed";
    }
    const segments = await segmentsWith(deps, call);
    let found = await call(() => r.contacts.get(row.resendContactId ? { id: row.resendContactId } : { email: pathEmail(address) }));
    if (row.resendContactId && isNotFound(found.error)) found = await call(() => r.contacts.get({ email: pathEmail(address) }));
    let contact: ContactState | null = null;
    if (found.data) {
      contact = { id: found.data.id, unsubscribed: found.data.unsubscribed, segments: await segmentsOf(call, r, found.data.id) };
      if (contact.unsubscribed && pullsUnsubscribe(row, deps.now) && (await pullRow(deps, row))) {
        const release = await releaseContact(call, r, segments, contact.id);
        console.info(`[newsletter-sync] subscriber ${row.id} unsubscribed in Resend (contact ${contact.id} ${release}): removed`);
        return release === "failed" ? "failed" : "removed";
      }
    } else if (!isNotFound(found.error)) {
      noteFailure(`[newsletter-sync] subscriber ${row.id}: contact not read`, found.error);
      return "failed";
    }
    const outcome = await pushRow({ deps, r, call, segments, room: async () => (await contactRows(deps.db)) < RESEND_FREE_CONTACTS }, row, contact);
    switch (outcome.kind) {
      case "limit":
        logNote(`[newsletter-sync] subscriber ${row.id} not added: the plan's ${RESEND_FREE_CONTACTS} contacts are used up`);
        return "skipped";
      case "failed":
        return "failed";
      case "vanished":
        return outcome.release === "failed" ? "failed" : "removed";
      default:
        console.info(`[newsletter-sync] subscriber ${row.id} synced (${outcome.kind})`);
        return "synced";
    }
  } catch (e) {
    noteFailure("[newsletter-sync] address sync failed", e);
    return "failed";
  }
}

/**
 * What a change to `subscribers` hands its deps (submit.ts, account-api.ts, newsletter.ts …): syncs that address, never throwing. The caller
 * runs it after the commit and after its response (next/server after()).
 */
export type SubscriberSync = (email: string) => Promise<unknown>;

/** The production hook: syncAddress on the server's database and settings, with SITE_URL as the link base. undefined without a marketing key. */
export function subscriberSync(db: Db, env: Env): SubscriberSync | undefined {
  if (!marketingConfigured(env)) return undefined;
  return (email) => syncAddress({ db, env, siteUrl: env.SITE_URL, now: new Date() }, email);
}

/** Is the address a confirmed subscriber (the comparison lowers both sides)? Task 4's test send keeps her real unsubscribe link then (ruling R7). */
export async function isSubscriberAddress(q: Q, email: string): Promise<boolean> {
  const [row] = await q
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(and(sameAddress(normalizeEmail(email)), isNotNull(subscribers.confirmedAt)))
    .limit(1);
  return row !== undefined;
}

// ---------- the full sync ----------

/**
 * `contacts`: Resend's contacts after the sync, all of the account's (the plan's limit counts them all). `added` / `updated`: contacts made,
 * put right. `removed`: contacts taken out of our segments (deleted, or only unlinked when they are in another segment too). `unsubscribedPulled`:
 * rows deleted for an unsubscribe made in Resend. `suppressed`: confirmed subscribers whose address Resend suppresses. `unsynced`: recipient
 * rows still not synced (the limit, a failure, the time budget; sample addresses are never counted). `failed`: pushes and removals that
 * failed in this run, each logged with its row or contact id (a synced row whose push failed is counted here, not in `unsynced`).
 * `limitReached`: the plan's contacts are used up and some were not added. `finished`: every step ran to its end and every contact that had to
 * leave our segments has left.
 */
export type FullSyncReport = {
  contacts: number;
  added: number;
  updated: number;
  removed: number;
  unsubscribedPulled: number;
  suppressed: number;
  unsynced: number;
  failed: number;
  limitReached: boolean;
  finished: boolean;
};

/**
 * Compares every subscriber with Resend and puts the differences right, in this order:
 * 1. reads Resend's contacts and the two segments' members; an unsubscribed contact deletes its row (D3, R1) before any contact is written;
 * 2. reads Resend's suppression list into mail_suppressions (D10; a failure here is logged and the sync goes on);
 * 3. takes out of our segments the contacts there without a recipient row (an unsubscribe on the site whose own sync failed, a sample
 *    address): before any is added, so that a send never reaches them and the limit counts only what is needed. Ruling R6: a contact is
 *    deleted only when it is in no other segment, and a contact in neither of our segments is never touched;
 * 4. pushes every recipient row that is unsynced, has no contact, or is not in exactly its segment; a new contact only while Resend has fewer
 *    than RESEND_FREE_CONTACTS (Resend itself would take more and then refuse every broadcast), and none after Resend refused one for the limit.
 * A synced row in its segment is left alone: every push writes the property, and synced_at is set only after a push succeeded (Review Focus 2).
 * After `budgetMs` no call starts: the report says `finished: false`, and what is left waits for the next run. MarketingUnavailable when it
 * is not set up or Resend does not answer the lists (step 1 has to be whole, or nothing could be trusted).
 */
export async function fullSync(deps: MarketingDeps): Promise<FullSyncReport> {
  if (!marketingConfigured(deps.env)) throw new MarketingUnavailable({ name: "not_configured" });
  const deadline = deps.budgetMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + deps.budgetMs;
  const call = pacer(deps, deadline);
  const r = client(deps);
  const report: FullSyncReport = {
    contacts: 0,
    added: 0,
    updated: 0,
    removed: 0,
    unsubscribedPulled: 0,
    suppressed: 0,
    unsynced: 0,
    failed: 0,
    limitReached: false,
    finished: false,
  };
  let complete = true;
  try {
    const segments = await segmentsWith(deps, call);
    // 1. what Resend has, and the unsubscribes made there
    const contacts = await listAll(call, "contacts.list", (after) => r.contacts.list({ limit: 100, after }));
    const members = {
      et: new Set((await listAll(call, "contacts.list(et)", (after) => r.contacts.list({ segmentId: segments.et, limit: 100, after }))).map((c) => c.id)),
      ru: new Set((await listAll(call, "contacts.list(ru)", (after) => r.contacts.list({ segmentId: segments.ru, limit: 100, after }))).map((c) => c.id)),
    };
    report.contacts = contacts.length;
    let rows = await allRows(deps.db);
    const byAddress = new Map(rows.map((row) => [row.address, row]));
    let pulled = false;
    for (const contact of contacts) {
      const row = contact.unsubscribed ? byAddress.get(normalizeEmail(contact.email)) : undefined;
      if (!row || !pullsUnsubscribe(row, deps.now) || !(await pullRow(deps, row))) continue;
      report.unsubscribedPulled++;
      pulled = true;
      console.info(`[newsletter-sync] subscriber ${row.id} unsubscribed in Resend (contact ${contact.id}): removed`);
    }
    if (pulled) rows = await allRows(deps.db);
    // 2. the suppression list
    try {
      await readSuppressions(deps, call, r);
    } catch (e) {
      if (e instanceof OutOfTime) throw e;
      noteFailure("[newsletter-sync] suppression list not read", e);
    }
    // 3. contacts in our segments without a recipient row (R6: only ours)
    const recipients = new Map(rows.filter(isRecipient).map((row) => [row.address, row]));
    const contactOf = new Map<string, ContactView>();
    for (const contact of contacts) {
      const address = normalizeEmail(contact.email);
      if (recipients.has(address)) {
        contactOf.set(address, contact);
        continue;
      }
      if (!members.et.has(contact.id) && !members.ru.has(contact.id)) continue; // not the newsletter's: never touched
      const release = await releaseContact(call, r, segments, contact.id);
      if (release === "failed") {
        complete = false;
        report.failed++;
      } else if (release !== "untouched") {
        report.removed++;
        if (release === "deleted") report.contacts--;
      }
    }
    // 4. every recipient row
    const segmentsOfContact = (id: string) => new Set((["et", "ru"] as const).filter((l) => members[l].has(id)).map((l) => segments[l]));
    let failures = 0;
    for (const row of [...recipients.values()].sort((a, b) => a.id - b.id)) {
      const view = contactOf.get(row.address);
      const contact: ContactState | null = view ? { id: view.id, unsubscribed: view.unsubscribed, segments: segmentsOfContact(view.id) } : null;
      // a synced row whose contact unsubscribed and was kept by step 1: synced or consented while this sync ran; the next one sees it
      if (contact?.unsubscribed && row.syncedAt) continue;
      const locale = rowLocale(row.locale);
      if (contact && row.syncedAt && contact.segments.has(segments[locale]) && !contact.segments.has(segments[otherLocale(locale)])) {
        if (row.resendContactId !== contact.id) await deps.db.update(subscribers).set({ resendContactId: contact.id }).where(eq(subscribers.id, row.id));
        continue;
      }
      if (!contact && report.limitReached) continue;
      const outcome = await pushRow({ deps, r, call, segments, room: () => report.contacts < RESEND_FREE_CONTACTS }, row, contact);
      if (outcome.kind === "limit") {
        report.limitReached = true;
        continue;
      }
      if (outcome.kind === "failed") {
        report.failed++;
        if (++failures < FAILURES_IN_A_ROW) continue;
        complete = false;
        logNote(`[newsletter-sync] ${FAILURES_IN_A_ROW} contacts failed in a row: the rest waits for the next sync`);
        break;
      }
      failures = 0;
      if (outcome.kind === "added") {
        report.added++;
        report.contacts++;
      } else if (outcome.kind === "updated") report.updated++;
      else {
        // the row went while it was pushed, and its contact was taken out again
        const kept = outcome.release !== "deleted";
        if (outcome.created && kept) report.contacts++;
        if (!outcome.created && !kept) report.contacts--;
        if (outcome.release === "failed") {
          complete = false;
          report.failed++;
        } else if (!outcome.created && outcome.release !== "untouched") report.removed++;
      }
    }
    report.finished = complete;
  } catch (e) {
    if (!(e instanceof OutOfTime)) throw e;
    logNote("[newsletter-sync] full sync stopped at its time budget: the rest waits for the next run");
    report.finished = false;
  }
  report.unsynced = (await allRows(deps.db)).filter((row) => isRecipient(row) && row.syncedAt === null).length;
  report.suppressed = await suppressedSubscribers(deps.db);
  if (report.limitReached) logNote(`[newsletter-sync] the plan's ${RESEND_FREE_CONTACTS} contacts are used up: ${report.unsynced} subscribers are not in Resend`);
  console.info(
    `[newsletter-sync] full sync: ${report.contacts} contacts, ${report.added} added, ${report.updated} updated, ${report.removed} removed, ${report.unsubscribedPulled} unsubscribed in Resend, ${report.suppressed} suppressed, ${report.unsynced} not synced, ${report.failed} failed${report.finished ? "" : ", not finished"}`,
  );
  return report;
}

async function allRows(db: Db): Promise<Row[]> {
  return (await db.select(COLUMNS).from(subscribers).orderBy(subscribers.id)).map(asRow);
}

/** Confirmed subscribers whose address has an active suppression (the addresses compared in lower case on both sides). */
async function suppressedSubscribers(db: Db): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(subscribers)
    .where(
      and(
        isNotNull(subscribers.confirmedAt),
        sql`exists (select 1 from ${mailSuppressions} where ${mailSuppressions.clearedAt} is null and lower(${mailSuppressions.email}) = lower(${subscribers.email}))`,
      ),
    );
  return n;
}

// ---------- suppressions ----------

const reasonOf = (origin: unknown): "bounce" | "complaint" | "other" => (origin === "bounce" ? "bounce" : origin === "complaint" ? "complaint" : "other");

/** A time Resend sent ("2026-10-11T23:47:56.678Z", or "2026-10-06 23:47:56.678+00" as some lists write it), else `fallback`. */
function timeOf(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") return fallback;
  for (const text of [value, value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")]) {
    const t = new Date(text);
    if (!Number.isNaN(t.getTime())) return t;
  }
  return fallback;
}

/** Records (or re-opens) an address's suppression, in lower case. */
async function recordSuppression(q: Q, address: string, reason: "bounce" | "complaint" | "other", since: Date): Promise<void> {
  await q
    .insert(mailSuppressions)
    .values({ email: address, reason, since, clearedAt: null })
    .onConflictDoUpdate({ target: mailSuppressions.email, set: { reason, since, clearedAt: null } });
}

/**
 * Resend's suppression list into mail_suppressions: every address on it active, with its reason and time; an address that is no longer on it
 * cleared now (a suppression.removed the webhook missed). The site never removes a suppression in Resend (D10).
 */
async function readSuppressions(deps: MarketingDeps, call: Call, r: ResendLike): Promise<void> {
  const listed = await listAll(call, "suppressions.list", (after) => r.suppressions.list({ limit: 100, after }));
  const active = new Map<string, { reason: "bounce" | "complaint" | "other"; since: Date }>();
  for (const s of listed) {
    if (typeof s.email !== "string" || !isEmail(normalizeEmail(s.email))) continue;
    active.set(normalizeEmail(s.email), { reason: reasonOf(s.origin), since: timeOf(s.created_at, deps.now) });
  }
  const values = [...active].map(([email, s]) => ({ email, reason: s.reason, since: s.since, clearedAt: null }));
  for (let i = 0; i < values.length; i += 500)
    await deps.db
      .insert(mailSuppressions)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({ target: mailSuppressions.email, set: { reason: sql`excluded.reason`, since: sql`excluded.since`, clearedAt: null } });
  const addresses = [...active.keys()];
  await deps.db
    .update(mailSuppressions)
    .set({ clearedAt: deps.now })
    .where(addresses.length ? and(isNull(mailSuppressions.clearedAt), notInArray(sql`lower(${mailSuppressions.email})`, addresses)) : isNull(mailSuppressions.clearedAt));
}

/** The addresses among `emails` that Resend suppresses now (the admin's marks, D10), in lower case; the comparison lowers both sides. */
export async function suppressedAddresses(q: Q, emails: string[]): Promise<Set<string>> {
  const wanted = [...new Set(emails.map(normalizeEmail))];
  if (wanted.length === 0) return new Set();
  const rows = await q
    .select({ email: mailSuppressions.email })
    .from(mailSuppressions)
    .where(and(isNull(mailSuppressions.clearedAt), inArray(sql`lower(${mailSuppressions.email})`, wanted)));
  return new Set(rows.map((row) => normalizeEmail(row.email)));
}

/** Resend's contacts (its own count, else counted from the list), for the admin's count against the free 1,000 (D8); null when not set up or not answered. */
export async function contactCount(deps: MarketingDeps): Promise<number | null> {
  if (!marketingConfigured(deps.env)) return null;
  try {
    const call = pacer(deps);
    const r = client(deps);
    const usage = await call(() => r.usage.get());
    const used = usage.data?.contacts?.used;
    if (typeof used === "number" && Number.isInteger(used) && used >= 0) return used;
    return (await listAll(call, "contacts.list", (after) => r.contacts.list({ limit: 100, after }))).length;
  } catch (e) {
    noteFailure("[newsletter-sync] contact count unavailable", e);
    return null;
  }
}

// ---------- the webhook ----------

/**
 * A verified Resend event (app/api/resend/webhook): contact.updated with `unsubscribed` deletes the row of that address, but only when its consent
 * is older than the event (R1: a sign-up since is a new consent), and then her contact (syncAddress: no row, no contact). suppression.added
 * records the address (lower case, its reason, the suppression's time), suppression.removed clears it. Every other event, and one without an
 * address, is ignored. A database failure throws (the route answers 500, and Resend sends the event again); a Resend failure does not.
 */
export async function handleWebhook(deps: MarketingDeps, event: WebhookEventPayload): Promise<void> {
  const data = (event as { data?: unknown }).data;
  const fields = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const address = typeof fields.email === "string" ? normalizeEmail(fields.email) : "";
  if (!isEmail(address)) return;
  const when = timeOf((event as { created_at?: unknown }).created_at, deps.now);
  switch (event.type) {
    case "contact.updated": {
      if (fields.unsubscribed !== true) return;
      const gone = await deps.db.delete(subscribers).where(and(sameAddress(address), lt(subscribers.consentAt, when))).returning();
      if (gone.length === 0) {
        console.info("[newsletter-sync] webhook: a contact unsubscribed in Resend: no subscriber with an older consent");
        return;
      }
      console.info(`[newsletter-sync] webhook: a contact unsubscribed in Resend: subscriber ${gone.map((row) => row.id).join(", ")} removed`);
      await syncAddress(deps, address);
      return;
    }
    case "suppression.added": {
      const reason = reasonOf(fields.origin);
      await recordSuppression(deps.db, address, reason, timeOf(fields.created_at, when));
      console.info(`[newsletter-sync] webhook: a suppression recorded (${reason})`);
      return;
    }
    case "suppression.removed": {
      await deps.db.update(mailSuppressions).set({ clearedAt: when }).where(and(isNull(mailSuppressions.clearedAt), sql`lower(${mailSuppressions.email}) = ${address}`));
      console.info("[newsletter-sync] webhook: a suppression cleared");
      return;
    }
    default:
      return;
  }
}

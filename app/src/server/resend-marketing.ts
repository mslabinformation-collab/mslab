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
// The campaign's broadcasts (Task 4, at the end): the send to our two segments right after a full sync under the same lease (fullSyncThen), and
// „Saada proov“ as a broadcast to a one-contact test segment (sendTestBroadcast, rulings R4, R7).

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
  /**
   * A broadcast made and sent in one call (`send: true`) to one segment (Task 4). No tracking option is set: open and click tracking stay off (spec
   * D1). The SDK sends `segment_id`, `reply_to`; `name` is what Resend's dashboard lists it by.
   */
  broadcasts: {
    create(o: { segmentId: string; from: string; replyTo?: string; subject: string; html: string; text: string; name: string; send: true }): Promise<Answer<{ id: string }>>;
  };
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

/**
 * Another full sync is running (see fullSync's lease; a campaign's send or test holds it too): this one did nothing. Not a failure of Resend: the
 * cron logs it and waits for the next day, the admin's buttons tell Maria to try again in a moment.
 */
export class FullSyncBusy extends Error {
  constructor() {
    super("a full sync is already running");
    this.name = "FullSyncBusy";
  }
}

/** The setting that holds the full sync's lease: `{ holder, until }`, `until` in epoch milliseconds. Absent when no sync runs. */
export const SYNC_LEASE_SETTING = "newsletter_sync_lease";
/**
 * The lease outlasts the sync's budget by this much: a call begun at the budget's end has NOTIFY_TIMEOUT_MS (8 s), and once more after a 429 (a
 * second and 8 s more), and the counts' queries follow. A sync that dies without releasing it holds the others off for this long at most.
 */
const LEASE_SLACK_MS = 30_000;
/** A sync with no time budget (a test, a script) holds its lease for this long at most. */
const UNBOUNDED_LEASE_MS = 5 * 60_000;

/**
 * Takes the full sync's lease with one statement: the row is made, or taken over when its `until` has passed (a missing or odd `until` counts as
 * passed). Its holder is a random id and its `until` is now plus the sync's budget plus LEASE_SLACK_MS. null when another sync holds it. A lease
 * row, not a session advisory lock: the pool (postgres.js, up to 5 connections) could release a session lock on another connection than the one
 * that took it, and a transaction lock would keep a connection for the whole sync.
 */
async function takeLease(deps: MarketingDeps, extraMs = 0): Promise<string | null> {
  const holder = crypto.randomUUID();
  const now = Date.now();
  const value = { holder, until: now + (deps.budgetMs ?? UNBOUNDED_LEASE_MS) + LEASE_SLACK_MS + extraMs };
  const taken = await deps.db
    .insert(settings)
    .values({ key: SYNC_LEASE_SETTING, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value },
      setWhere: sql`case when jsonb_typeof(${settings.value} -> 'until') = 'number' then (${settings.value} ->> 'until')::numeric else 0 end < ${now}::numeric`,
    })
    .returning();
  return taken.length > 0 ? holder : null;
}

/** Gives the lease back, but only if this holder still has it (it may have run out and been taken over). */
async function releaseLease(db: Db, holder: string): Promise<void> {
  await db.delete(settings).where(and(eq(settings.key, SYNC_LEASE_SETTING), sql`${settings.value} ->> 'holder' = ${holder}`));
}

/**
 * Runs `work` holding the lease (the full sync, the campaign's send after its sync, the test send of Task 4: one at a time), held `extraMs` longer
 * than a sync's; FullSyncBusy, with nothing done, when another holds it. Released at the end, also after a throw.
 */
async function underLease<T>(deps: MarketingDeps, extraMs: number, what: string, work: () => Promise<T>): Promise<T> {
  const holder = await takeLease(deps, extraMs);
  if (holder === null) {
    console.info(`[newsletter-sync] a full sync is already running: ${what} is not started`);
    throw new FullSyncBusy();
  }
  try {
    return await work();
  } finally {
    // (a lease that cannot be released ends by itself at its `until`)
    await releaseLease(deps.db, holder).catch((e: unknown) => noteFailure("[newsletter-sync] the sync lease not released", e));
  }
}

/**
 * The key of the newsletter's calls: RESEND_MARKETING_KEY alone (spec §4 as amended, ruling R15: the switch Dim sets after his check, and blanks to
 * switch the newsletter off again); undefined when it is unset or blank. RESEND_API_KEY is the site's own mails' key and never stands in for it,
 * whatever its permission.
 */
export const marketingKey = (env: Pick<Env, "RESEND_MARKETING_KEY">): string | undefined => env.RESEND_MARKETING_KEY || undefined;

/** Is the newsletter's Resend side set up (RESEND_MARKETING_KEY)? Without it nothing is synced or sent, and nothing fails ("not set up"). Logs nothing. */
export const marketingConfigured = (env: Pick<Env, "RESEND_MARKETING_KEY">): boolean => Boolean(marketingKey(env));

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
/** The names of a refusal of a request's fields (Resend's 400 and 422). */
const FIELD_ERRORS: ReadonlySet<string> = new Set(["validation_error", "invalid_parameter", "missing_required_field"]);
/**
 * Did Resend refuse the contact itself, for its address (ruling R17)? A 400 or 422 validation error whose message names the e-mail, but not
 * "already exists" (a contact made meanwhile: the next sync finds it) nor the plan's limit. Read from the message, which is never logged. Anything
 * else, a refused property among them (a definition deleted in Resend's dashboard), stays a failure: it blocks a send until it is put right.
 */
const contactRejected = (e: ApiError | null): boolean => {
  if (!e || (e.statusCode !== 400 && e.statusCode !== 422) || !FIELD_ERRORS.has(e.name ?? "")) return false;
  const message = e.message ?? "";
  return /e-?mail/i.test(message) && !/already exist/i.test(message) && !contactLimit(e);
};
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

/**
 * The row of an address (lower case on both sides): its confirmed row when it has one, else its oldest. A legacy pair of rows that differ only in
 * case can hold an unconfirmed one beside the confirmed one; the confirmed one decides, here and in isSubscriberAddress (one match for both).
 */
async function rowOf(q: Q, address: string): Promise<Row | null> {
  const [row] = await q
    .select(COLUMNS)
    .from(subscribers)
    .where(sameAddress(address))
    .orderBy(sql`${subscribers.confirmedAt} is null`, subscribers.id)
    .limit(1);
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

/**
 * The setting that keeps the subscribers whose address Resend refused as a contact (ruling R17): `{ "<subscriber id>": "<ISO time of the refusal>" }`.
 * Written by the sync that was refused, an id taken out by the push that succeeds; „Uudiskiri“ marks those rows (rejectedSubscribers). An id whose
 * row is gone stays harmlessly (ids are never reused).
 */
export const REJECTED_SETTING = "newsletter_rejected";

/** Marks the row as refused by Resend (one statement: two syncs at once each add their own). */
async function markRejected(db: Db, id: number, now: Date): Promise<void> {
  const value = { [String(id)]: now.toISOString() };
  await db
    .insert(settings)
    .values({ key: REJECTED_SETTING, value })
    .onConflictDoUpdate({ target: settings.key, set: { value: sql`${settings.value} || excluded.value` } });
}

/** Takes the row's mark away, when it has one (no write otherwise). */
async function clearRejected(db: Db, id: number): Promise<void> {
  await db
    .update(settings)
    .set({ value: sql`${settings.value} - ${String(id)}::text` })
    .where(and(eq(settings.key, REJECTED_SETTING), sql`(${settings.value} -> ${String(id)}::text) is not null`));
}

/** The ids among `ids` whose address Resend refused as a contact (ruling R17): „Uudiskiri“ marks those rows. */
export async function rejectedSubscribers(q: Q, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const stored = await readSetting(q, REJECTED_SETTING);
  const marked = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  return new Set(ids.filter((id) => typeof marked[String(id)] === "string"));
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
/**
 * What a push did. "rejected": Resend refused the contact for its address (contactRejected, ruling R17): the row stays unsynced and is marked, and
 * it is no failure. "vanished": the row went while it was pushed (she unsubscribed meanwhile), and her contact was taken out again (`release`).
 */
type PushOutcome =
  | { kind: "added" }
  | { kind: "updated" }
  | { kind: "limit" }
  | { kind: "failed" }
  | { kind: "rejected" }
  | { kind: "vanished"; created: boolean; release: Release };

/** Logs and marks a row whose contact Resend refused (ruling R17). */
async function rejectRow(ctx: PushContext, row: Row, error: ApiError | null): Promise<PushOutcome> {
  console.error(`[newsletter-sync] subscriber ${row.id}: Resend refused the contact (${summaryOf(error)}): left out, and marked on „Uudiskiri“`);
  await markRejected(ctx.deps.db, row.id, ctx.deps.now);
  return { kind: "rejected" };
}

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
      if (contactRejected(made.error)) return rejectRow(ctx, row, made.error);
      noteFailure(`[newsletter-sync] subscriber ${row.id}: contact not created`, made.error);
      return { kind: "failed" };
    }
    id = made.data.id;
  } else {
    id = contact.id;
    const resubscribe = contact.unsubscribed && row.syncedAt === null;
    const updated = await call(() => r.contacts.update({ id, properties, ...(resubscribe ? { unsubscribed: false } : {}) }));
    if (updated.error) {
      if (contactRejected(updated.error)) return rejectRow(ctx, row, updated.error);
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
  if (marked.length > 0) {
    await clearRejected(ctx.deps.db, row.id); // (Resend took her after all: R17's mark goes)
    return { kind: contact ? "updated" : "added" };
  }
  const current = await rowOf(ctx.deps.db, row.address);
  if (current && isRecipient(current)) return { kind: contact ? "updated" : "added" }; // changed meanwhile: unsynced, for the next sync
  const release = await releaseContact(call, r, ctx.segments, id);
  console.info(`[newsletter-sync] subscriber ${row.id} went while it was synced: contact ${id} ${release}`);
  return { kind: "vanished", created: !contact, release };
}

export type SyncOutcome = "synced" | "removed" | "skipped" | "failed" | "rejected";

/**
 * Syncs one address after a change to its row has committed. A confirmed row: her contact made or updated (pushRow). No row, or one of the old
 * double opt-in never confirmed: her contact leaves our segments, and is deleted when it is in no other one (R6; none is fine). A contact
 * unsubscribed in Resend whose row was synced before and is older (R1): the row is deleted, then the contact taken out. "skipped": not set
 * up, a sample address (never synced, R6), or the plan's contacts are used up (the row stays unsynced; the full sync reports it). "rejected":
 * Resend refused her address as a contact (ruling R17): the row stays unsynced and is marked on „Uudiskiri“. Never throws: a failure is logged
 * without the address and leaves the row unsynced ("failed").
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
      case "rejected":
        return "rejected";
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

/**
 * The pause between two Resend calls of a background sync (the review's M5): the daily cron's full sync and a sign-up's own sync. Slower than a
 * press (MARKETING_GAP_MS), so that a login code or a confirmation sent meanwhile finds room within Resend's 2 requests a second.
 */
export const BACKGROUND_GAP_MS = 1000;

/** The deps of a background sync on the server: SITE_URL as the link base, BACKGROUND_GAP_MS between calls, and `budgetMs` (the cron's deadline). */
export function backgroundMarketingDeps(db: Db, env: Env, now: Date, budgetMs?: number): MarketingDeps {
  return { db, env, siteUrl: env.SITE_URL, now, gapMs: BACKGROUND_GAP_MS, ...(budgetMs === undefined ? {} : { budgetMs }) };
}

/**
 * The production hook: syncAddress on the server's database and settings (backgroundMarketingDeps: SITE_URL, a background sync's pace).
 * undefined without the marketing key.
 */
export function subscriberSync(db: Db, env: Env): SubscriberSync | undefined {
  if (!marketingConfigured(env)) return undefined;
  return (email) => syncAddress(backgroundMarketingDeps(db, env, new Date()), email);
}

/** Is the address a confirmed subscriber (the comparison lowers both sides)? Task 4's test send keeps her real unsubscribe link then (ruling R7). */
export async function isSubscriberAddress(q: Q, email: string): Promise<boolean> {
  return Boolean((await rowOf(q, normalizeEmail(email)))?.confirmedAt);
}

// ---------- the full sync ----------

/**
 * `contacts`: Resend's contacts after the sync, all of the account's (the plan's limit counts them all). `added` / `updated`: contacts made,
 * put right. `removed`: contacts taken out of our segments (deleted, or only unlinked when they are in another segment too). `unsubscribedPulled`:
 * rows deleted for an unsubscribe made in Resend. `suppressed`: confirmed subscribers whose address Resend suppresses. `unsynced`: recipient
 * rows still not synced (the limit, a failure, the time budget; sample addresses and the rows `rejected` in this run are never counted).
 * `failed`: pushes and removals that failed in this run, each logged with its row or contact id (a synced row whose push failed is counted here,
 * not in `unsynced`). `rejected`: rows whose address Resend refused as a contact in this run (ruling R17): no failure, never in a run of
 * failures, and never a reason to refuse a send; each is marked on „Uudiskiri“ (REJECTED_SETTING). `limitReached`: the plan's contacts are used
 * up and some were not added. `finished`: every step ran to its end and every contact that had to leave our segments has left.
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
  rejected: number;
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
 * Only one full sync runs at a time (rulings R9, R11): it holds a lease (the setting `newsletter_sync_lease`, see takeLease) from before its first Resend
 * call to its end, and a second caller (the cron, the admin's button, another tab) gets FullSyncBusy and does nothing. `ensureSegments` runs inside it.
 */
export async function fullSync(deps: MarketingDeps): Promise<FullSyncReport> {
  if (!marketingConfigured(deps.env)) throw new MarketingUnavailable({ name: "not_configured" });
  return underLease(deps, 0, "this one", () => syncUnderLease(deps));
}

async function syncUnderLease(deps: MarketingDeps): Promise<FullSyncReport> {
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
    rejected: 0,
    limitReached: false,
    finished: false,
  };
  let complete = true;
  /** The rows Resend refused in this run (R17): not counted `unsynced`. */
  const rejected = new Set<number>();
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
      if (outcome.kind === "rejected") {
        // Resend answered, and refused her address (R17): no failure, and no part of a run of them
        report.rejected++;
        rejected.add(row.id);
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
  report.unsynced = (await allRows(deps.db)).filter((row) => isRecipient(row) && row.syncedAt === null && !rejected.has(row.id)).length;
  report.suppressed = await suppressedSubscribers(deps.db);
  if (report.limitReached) logNote(`[newsletter-sync] the plan's ${RESEND_FREE_CONTACTS} contacts are used up: ${report.unsynced} subscribers are not in Resend`);
  console.info(
    `[newsletter-sync] full sync: ${report.contacts} contacts, ${report.added} added, ${report.updated} updated, ${report.removed} removed, ${report.unsubscribedPulled} unsubscribed in Resend, ${report.suppressed} suppressed, ${report.unsynced} not synced, ${report.failed} failed, ${report.rejected} rejected${report.finished ? "" : ", not finished"}`,
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

/** The names a Resend error has when the key itself is refused (the SDK passes the API's `name` and `statusCode` on as they come). */
const KEY_ERRORS: ReadonlySet<string> = new Set(["restricted_api_key", "invalid_api_key", "missing_api_key"]);

/**
 * Did Resend refuse the key, rather than fail? A key that can only send (the site's RESEND_API_KEY of the welcome mails) answers every contact,
 * segment and broadcast call with 401 `restricted_api_key` ("This API key is restricted to only send emails"); a key it does not know is 403
 * `invalid_api_key`. Any other 401 or 403 counts too, except a 403 `validation_error`, which is how Resend words refusals that are not about the key.
 * Takes a Resend error (`name`, `statusCode`) or a MarketingUnavailable (`code`, `statusCode`).
 */
export function keyRefused(error: unknown): boolean {
  const e = (typeof error === "object" && error !== null ? error : {}) as { name?: unknown; code?: unknown; statusCode?: unknown };
  const names = [e.name, e.code].filter((v): v is string => typeof v === "string");
  if (names.some((v) => KEY_ERRORS.has(v))) return true;
  return (e.statusCode === 401 || e.statusCode === 403) && !names.includes("validation_error");
}

/** Resend's count of the contacts, with whether Resend refused the key for it (the admin page says so at once, M6). */
export type ContactCountRead = { count: number | null; refused: boolean };

/**
 * Resend's contacts: its own count (`usage`), counted from the list only when `usage` answered without a number, never when it answered an error
 * (a second call that would fail the same way costs a pause and a second log line on every view of the admin page). `count` is null when not set
 * up or not answered, and `refused` is true when the answer was the key's refusal (keyRefused). Never throws; logs the call and the status.
 */
export async function readContactCount(deps: MarketingDeps): Promise<ContactCountRead> {
  if (!marketingConfigured(deps.env)) return { count: null, refused: false };
  try {
    const call = pacer(deps);
    const r = client(deps);
    const usage = await call(() => r.usage.get());
    if (usage.error) {
      noteFailure("[newsletter-sync] contact count unavailable", usage.error);
      return { count: null, refused: keyRefused(usage.error) };
    }
    const used = usage.data?.contacts?.used;
    if (typeof used === "number" && Number.isInteger(used) && used >= 0) return { count: used, refused: false };
    return { count: (await listAll(call, "contacts.list", (after) => r.contacts.list({ limit: 100, after }))).length, refused: false };
  } catch (e) {
    noteFailure("[newsletter-sync] contact count unavailable", e);
    return { count: null, refused: keyRefused(e) };
  }
}

/** Resend's contacts (its own count, else counted from the list), for the admin's count against the free 1,000 (D8); null when not set up or not answered. */
export async function contactCount(deps: MarketingDeps): Promise<number | null> {
  return (await readContactCount(deps)).count;
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

// ---------- the campaign's broadcasts (Task 4) ----------

/** The recipients Resend has now, by language: confirmed rows (no sample address) synced into their segment, with a contact (a send's counts). */
export async function recipientCounts(db: Db): Promise<{ et: number; ru: number }> {
  const [r] = await db
    .select({
      et: sql<number>`(count(*) filter (where ${subscribers.locale} <> 'ru'))::int`,
      ru: sql<number>`(count(*) filter (where ${subscribers.locale} = 'ru'))::int`,
    })
    .from(subscribers)
    .where(
      and(
        isNotNull(subscribers.confirmedAt),
        isNotNull(subscribers.syncedAt),
        isNotNull(subscribers.resendContactId),
        sql`lower(${subscribers.email}) not like '%@example.test'`,
      ),
    );
  return { et: r?.et ?? 0, ru: r?.ru ?? 0 };
}

/** A broadcast as the site makes it: its name in Resend's dashboard, its subject, its HTML and its text (server/campaign-mail.ts campaignMail). */
export type BroadcastMail = { name: string; subject: string; html: string; text: string };

/**
 * What one broadcast came to: its id, or why not. `refused`: Resend stated that it refused it (broadcastRefused), so nothing was made (a broadcast
 * is made and sent in one call); false: anything else (no answer, a timeout, a 5xx, a gateway's error), so it may have been made and sent all
 * the same.
 */
export type BroadcastResult = { ok: true; id: string } | { ok: false; refused: boolean; error: MarketingUnavailable };

/** The statuses with which Resend refuses a request it did not carry out (resend.com/docs/api-reference/errors). */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422, 429]);
/** The names Resend gives a request it refused for its content or for its key (the SDK passes them on as they come). */
const REFUSED_NAMES: ReadonlySet<string> = new Set([
  "validation_error",
  "missing_required_field",
  "invalid_parameter",
  "invalid_from_address",
  "invalid_attachment",
  "invalid_access",
  "invalid_region",
  "invalid_idempotency_key",
  ...KEY_ERRORS,
]);

/**
 * Did Resend refuse a broadcast, so that it was certainly not made (the review's M2)? Only a 400, 401, 403, 404, 422 or 429 (a 429 after its second
 * try), or an error named as a validation or key error (REFUSED_NAMES). Anything else is no refusal: no answer, a timeout, any 5xx whatever its
 * name (the server may have made it), and the other 4xx unless so named (a 405, 408, 409, 413, 451 or a gateway's 499 can come after Resend took
 * the request).
 */
export function broadcastRefused(error: { name?: string | null; statusCode?: number | null } | null | undefined): boolean {
  const status = error?.statusCode;
  if (typeof status === "number" && REFUSED_STATUSES.has(status)) return true;
  if (typeof status === "number" && status >= 500) return false;
  return REFUSED_NAMES.has(error?.name ?? "");
}

/** Sends one broadcast at once to the segment of `locale`. */
export type SendBroadcast = (locale: Locale, mail: BroadcastMail) => Promise<BroadcastResult>;

/** What a send adds to the lease: two broadcasts, each with the gap before it, its timeout, and a 429's second try. */
export const SEND_LEASE_MS = 2 * (MARKETING_GAP_MS + NOTIFY_TIMEOUT_MS + RATE_LIMIT_RETRY_MS + NOTIFY_TIMEOUT_MS);

/** One broadcast to `segmentId`, made and sent at once: from MAIL_FROM, Maria as the reply-to (none when MARIA_EMAIL is empty), no tracking (D1). */
async function broadcastTo(deps: MarketingDeps, call: Call, r: ResendLike, segmentId: string, mail: BroadcastMail): Promise<BroadcastResult> {
  const answer = await call(() =>
    r.broadcasts.create({
      segmentId,
      from: deps.env.MAIL_FROM,
      ...(deps.env.MARIA_EMAIL ? { replyTo: deps.env.MARIA_EMAIL } : {}),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      name: mail.name,
      send: true,
    }),
  );
  if (answer.data) return { ok: true, id: answer.data.id };
  return { ok: false, refused: broadcastRefused(answer.error), error: new MarketingUnavailable(answer.error, "broadcasts.create") };
}

/**
 * The full sync, then `then` with its report and a way to send a broadcast to one of our two segments, both under one lease (rulings R9, R11): no
 * other sync, send or test runs between the sync and the send, nor during the send. The lease is held SEND_LEASE_MS longer than a sync's. FullSyncBusy
 * when another holds it, MarketingUnavailable when not set up or when the sync's lists are not answered (`then` does not run then).
 */
export async function fullSyncThen<T>(deps: MarketingDeps, then: (report: FullSyncReport, send: SendBroadcast) => Promise<T>): Promise<T> {
  if (!marketingConfigured(deps.env)) throw new MarketingUnavailable({ name: "not_configured" });
  return underLease(deps, SEND_LEASE_MS, "the send", async () => {
    const report = await syncUnderLease(deps);
    const call = pacer(deps);
    const r = client(deps);
    const segments = await segmentsWith(deps, call); // (stored by the sync: a read)
    await sleep(deps.gapMs ?? MARKETING_GAP_MS); // (the sync's last call was just now)
    return then(report, (locale, mail) => broadcastTo(deps, call, r, segments[locale], mail));
  });
}

/** The one-contact segment of „Saada proov“ (rulings R4, R7): it holds the address the test goes to, and nothing else. */
export const TEST_SEGMENT_NAME = "MS LAB uudiskiri (proov)";
/** The setting that keeps the test segment's id: `{ id }` (its own key: clearing `resend_segments` leaves it, and the other way round). */
export const TEST_SEGMENT_SETTING = "resend_test_segment";

/** The unsubscribe link of a test contact that is no subscriber (ruling R4): the site's page says it is a test, and changes nothing. */
export const testUnsubscribeUrl = (siteUrl: string): string => `${siteUrl.replace(/\/+$/, "")}/api/newsletter/loobu?proov=1`;

/** The test segment's id: the stored one, else Resend's segment of that name (a run that failed before storing it), else a new one; stored. */
async function testSegmentWith(deps: MarketingDeps, call: Call, r: ResendLike): Promise<string> {
  const stored = await readSetting(deps.db, TEST_SEGMENT_SETTING);
  const id = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>).id : null;
  if (typeof id === "string" && id.length > 0) return id;
  const listed = await call(() => r.segments.list({ limit: 100 }));
  if (!listed.data) throw new MarketingUnavailable(listed.error, "segments.list");
  let segment = listed.data.data.find((s) => s.name === TEST_SEGMENT_NAME)?.id;
  if (!segment) {
    const made = await call(() => r.segments.create({ name: TEST_SEGMENT_NAME }));
    if (!made.data) throw new MarketingUnavailable(made.error, "segments.create");
    segment = made.data.id;
  }
  const value = { id: segment };
  await deps.db.insert(settings).values({ key: TEST_SEGMENT_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  console.info(`[newsletter] test segment ${segment} set up`);
  return segment;
}

/**
 * „Saada proov“ as a real broadcast (rulings R4, R7): exactly what subscribers get, Resend's filling of the contact's unsubscribe_url and all,
 * to the test segment holding `address` alone. Under the lease (one sync, send or test at a time; FullSyncBusy otherwise):
 * 1. our segments and the property exist (ensureSegments' work), and the test segment (made on first use, kept under TEST_SEGMENT_SETTING; one
 *    deleted in Resend's dashboard is made again);
 * 2. every other contact leaves the test segment, before this one joins it;
 * 3. her contact: when the address is no subscriber (isSubscriberAddress), its unsubscribe_url is the test link (testUnsubscribeUrl) and it is set
 *    to subscribed (an admin's own address, for the test she asked for; a contact outside our segments, which the sync never touches); a
 *    subscriber's contact keeps her real link (`realLink: true`, ruling R7), and is made with it if the sync has not made it yet;
 * 4. the broadcast, made and sent at once (broadcastTo).
 * A subscriber whose contact unsubscribed in Resend would never get it (Resend sends no broadcast to an unsubscribed contact, and R7 leaves her
 * `unsubscribed` as it is): then nothing of hers is touched and nothing is sent, `{ sent: false, reason: "unsubscribed" }` (the review's M7).
 * A subscriber is told by her confirmed row (rowOf, the match isSubscriberAddress uses), and read again after the test link is written: one who
 * signed up meanwhile gets her real link back. The calls keep within the test's lease: none starts later than a call's longest time (its timeout,
 * and once more after a 429) before the lease ends; past that the test stops, nothing sent. MarketingUnavailable when not set up, when a call
 * fails or the time is up (nothing is sent then). Logs ids only.
 */
/** What a test send came to: its broadcast, or none because the address is a subscriber's whose contact unsubscribed in Resend (M7). */
export type TestBroadcast = { sent: true; id: string; realLink: boolean } | { sent: false; reason: "unsubscribed" };

export async function sendTestBroadcast(deps: MarketingDeps, address: string, mail: BroadcastMail): Promise<TestBroadcast> {
  if (!marketingConfigured(deps.env)) throw new MarketingUnavailable({ name: "not_configured" });
  // (taken before the lease, so never later than the lease's own start)
  const deadline = Date.now() + (deps.budgetMs ?? UNBOUNDED_LEASE_MS) + LEASE_SLACK_MS - CALL_MAX_MS;
  return underLease(deps, 0, "the test send", async () => {
    try {
      return await testBroadcastWith(deps, pacer(deps, deadline), address, mail);
    } catch (e) {
      if (e instanceof OutOfTime) throw new MarketingUnavailable({ name: "out_of_time" }, "the test's lease");
      throw e;
    }
  });
}

/** The longest one call can take: its timeout, and once more after a 429 with the pause before it. */
const CALL_MAX_MS = NOTIFY_TIMEOUT_MS + RATE_LIMIT_RETRY_MS + NOTIFY_TIMEOUT_MS;

async function testBroadcastWith(deps: MarketingDeps, call: Call, address: string, mail: BroadcastMail): Promise<TestBroadcast> {
  const r = client(deps);
  await segmentsWith(deps, call);
  const email = normalizeEmail(address);
  const row = await rowOf(deps.db, email);
  let subscriber = row?.confirmedAt ? row : null;

  let segment = await testSegmentWith(deps, call, r);
  let members: ContactView[];
  try {
    members = await listAll(call, "contacts.list(proov)", (after) => r.contacts.list({ segmentId: segment, limit: 100, after }));
  } catch (e) {
    if (!(e instanceof MarketingUnavailable && e.code === "not_found")) throw e;
    await deps.db.delete(settings).where(eq(settings.key, TEST_SEGMENT_SETTING));
    segment = await testSegmentWith(deps, call, r);
    members = [];
  }
  const found = await call(() => r.contacts.get({ email: pathEmail(email) }));
  if (found.error && !isNotFound(found.error)) throw new MarketingUnavailable(found.error, "contacts.get");
  const existing = found.data?.id ?? null;
  if (subscriber && found.data?.unsubscribed) {
    // (R7: her `unsubscribed` is hers; a broadcast would reach no one)
    console.info(`[newsletter] no test broadcast: the contact ${existing} of subscriber ${subscriber.id} unsubscribed in Resend`);
    return { sent: false, reason: "unsubscribed" };
  }
  for (const member of members) {
    if (member.id === existing) continue;
    const out = await call(() => r.contacts.segments.remove({ contactId: member.id, segmentId: segment }));
    if (out.error && !isNotFound(out.error)) throw new MarketingUnavailable(out.error, "contacts.segments.remove");
  }

  const testLink = subscriber ? null : testUnsubscribeUrl(deps.siteUrl);
  let contactId: string;
  if (existing === null) {
    const properties = { [UNSUBSCRIBE_PROPERTY]: testLink ?? unsubscribeUrl(deps.siteUrl, subscriber!.token) };
    const made = await call(() => r.contacts.create({ email, unsubscribed: false, properties, segments: [{ id: segment }] }));
    if (!made.data) throw new MarketingUnavailable(made.error, "contacts.create");
    contactId = made.data.id;
  } else {
    contactId = existing;
    if (testLink !== null) {
      const updated = await call(() => r.contacts.update({ id: contactId, unsubscribed: false, properties: { [UNSUBSCRIBE_PROPERTY]: testLink } }));
      if (updated.error) throw new MarketingUnavailable(updated.error, "contacts.update");
    }
    if (!members.some((m) => m.id === contactId)) {
      const added = await call(() => r.contacts.segments.add({ contactId, segmentId: segment }));
      if (added.error) throw new MarketingUnavailable(added.error, "contacts.segments.add");
    }
  }
  // she signed up while the test link was written: her real link back (her own sync may have run before this write)
  if (testLink !== null) {
    const now = await rowOf(deps.db, email);
    if (now?.confirmedAt) {
      const back = await call(() => r.contacts.update({ id: contactId, properties: { [UNSUBSCRIBE_PROPERTY]: unsubscribeUrl(deps.siteUrl, now.token) } }));
      if (back.error) throw new MarketingUnavailable(back.error, "contacts.update");
      subscriber = now;
    }
  }

  const sent = await broadcastTo(deps, call, r, segment, mail);
  if (!sent.ok) throw sent.error;
  const whose = subscriber ? `subscriber ${subscriber.id}, her own unsubscribe link` : "the test link";
  console.info(`[newsletter] test broadcast ${sent.id} sent to the test segment ${segment} (contact ${contactId}, ${whose})`);
  return { sent: true, id: sent.id, realLink: subscriber !== null };
}

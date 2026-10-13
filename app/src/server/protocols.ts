import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { draftOf, protocolScreen, screenStudents, type ProtocolDraft } from "@/db/queries/protocols";
import { lockRegistration } from "@/db/queries/seats";
import { courses, courseSessions, protocols, registrations, type Protocol, type ProtocolStage } from "@/db/schema";
import { isSampleAddress, normalizeEmail } from "@/domain/email";
import { hasText, overLimit, PROTOCOL_LIMITS, readStages } from "@/domain/protocols";
import type { I18n } from "@/i18n/field";
import { parseRowId } from "@/lib/row-id";
import { storable } from "@/lib/storable";
import { protocolMail, type LoginCode, type SessionInfo } from "./account-mail";
import { addClient } from "./admin-clients";
import { issueClientLogin, lockAddress } from "./client-auth";
import { logFailure, logNote } from "./log";
import { mailConfigured, sendMail, type Env } from "./notify";

// Maria's protocols on the course day (phase protocols, spec §3, §4, §8), without Next.js: the autosave (saveProtocol, and handleSave behind
// app/api/admin/protokoll) and the sending (sendProtocol, Task 3). The admin session is checked by the callers (withAdmin, adminAction).
// Logs carry the registration's id only: never a note, a name or an address.
//
// A protocol is created by its first save, with the course's headings as they are then (spec §3); until then the screen shows those headings
// with empty boxes and the status is "none". Every save carries the version the screen has, the row it builds on, and the headings it shows: a
// save from another version, of another row (the protocol deleted with the account and made again: its versions start again from 1), or for
// other headings, is refused with what is stored, so newer text is never overwritten and a note never lands under another heading (spec §4, §9).
// A save that changes nothing raises nothing: a look at a protocol, or the repeat of a save whose answer was lost, is answered with the version
// that holds that text.

/**
 * What a save sends: the registration, the protocol's row the screen's text is of (`protocolId`; null: none yet; absent: a screen from before
 * the row was sent, checked by the version only), the version the screen has (0: none yet), the headings it shows and the notes under them,
 * one note for each heading (a body with another count is not a save, so a `SaveInput` always has as many notes as titles).
 */
export const saveBody = z
  .object({
    registrationId: z.number().int().positive().max(2_147_483_647),
    protocolId: z.number().int().positive().max(2_147_483_647).nullable().optional(),
    version: z.number().int().min(0).max(2_147_483_647),
    titles: z.array(z.string().max(PROTOCOL_LIMITS.title)).max(PROTOCOL_LIMITS.stages),
    notes: z.array(z.string()).max(PROTOCOL_LIMITS.stages),
    generalNote: z.string(),
  })
  .refine((body) => body.notes.length === body.titles.length, { message: "one note for each heading", path: ["notes"] });
export type SaveInput = z.infer<typeof saveBody>;

/** saved: `protocolId` is the protocol's row (the screen tells a protocol made again from the one it had by it). */
export type SaveResult = { kind: "saved"; protocolId: number; version: number; savedAt: Date } | { kind: "conflict"; protocol: ProtocolDraft } | { kind: "notFound" };

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const titlesOf = (stages: readonly ProtocolStage[]): string[] => stages.map((s) => s.title);
/** Does the stored protocol hold exactly this text, under these headings? */
const holds = (p: Protocol, input: SaveInput): boolean =>
  sameList(titlesOf(p.stages), input.titles) && sameList(p.stages.map((s) => s.note), input.notes) && p.generalNote === input.generalNote;

/** A registration's course headings and its protocol; null when there is no such registration of a contact course. */
async function current(db: Db, registrationId: number): Promise<{ headings: string[]; stored: Protocol | null } | null> {
  const [row] = await db
    .select({ type: courses.type, headings: courses.protocolStages, protocol: protocols })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(protocols, eq(protocols.registrationId, registrations.id))
    .where(eq(registrations.id, registrationId))
    .limit(1);
  return row && row.type === "contact" ? { headings: readStages(row.headings), stored: row.protocol } : null;
}

/**
 * One save of the screen. A registration that is cancelled meanwhile still saves (spec §9: hidden and never sent, but nothing typed is lost).
 * The insert and the update are each one conditional statement (the update only of the row read); one that meets another save at the same
 * moment, or a protocol deleted and made again meanwhile, reads again and decides on what is stored then (twice at most, then the answer is a
 * conflict with the protocol as it is).
 * The contract with the screen: a save from an older version whose text differs from what is stored is answered with a conflict and the
 * stored protocol, even when the stored text is the screen's own earlier save whose answer was lost. Recognising a lost answer of its own is
 * the client's job: the screen keeps every unacknowledged text it sent and treats a conflict whose stored text equals one of them as its own save.
 */
export async function saveProtocol(db: Db, input: SaveInput, now: Date): Promise<SaveResult> {
  for (let attempt = 0; ; attempt++) {
    const found = await current(db, input.registrationId);
    if (!found) return { kind: "notFound" };
    const { headings, stored } = found;
    // a save built on a row (protocolId) is refused by any other one, and by none: a protocol deleted with the account and made again starts
    // again from version 1, so the version alone would let a screen of the old row overwrite the new one once it reached the same version
    const otherRow = typeof input.protocolId === "number" && input.protocolId !== stored?.id;
    if (stored === null) {
      if (otherRow || input.version !== 0 || !sameList(headings, input.titles)) return { kind: "conflict", protocol: draftOf(null, headings) };
      const [created] = await db
        .insert(protocols)
        .values({
          registrationId: input.registrationId,
          stages: input.titles.map((title, i) => ({ title, note: input.notes[i] })),
          generalNote: input.generalNote,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: protocols.registrationId })
        .returning();
      if (created) return { kind: "saved", protocolId: created.id, version: created.version, savedAt: now };
    } else {
      if (otherRow) return { kind: "conflict", protocol: draftOf(stored, headings) };
      if (holds(stored, input)) return { kind: "saved", protocolId: stored.id, version: stored.version, savedAt: stored.updatedAt };
      if (input.version !== stored.version || !sameList(titlesOf(stored.stages), input.titles)) return { kind: "conflict", protocol: draftOf(stored, headings) };
      const [updated] = await db
        .update(protocols)
        .set({ stages: stored.stages.map((s, i) => ({ title: s.title, note: input.notes[i] })), generalNote: input.generalNote, version: sql`${protocols.version} + 1`, updatedAt: now })
        .where(and(eq(protocols.id, stored.id), eq(protocols.version, input.version))) // (the row read: one made again meanwhile is not it)
        .returning();
      if (updated) return { kind: "saved", protocolId: updated.id, version: updated.version, savedAt: now };
    }
    if (attempt >= 1) {
      const last = await current(db, input.registrationId);
      return last ? { kind: "conflict", protocol: draftOf(last.stored, last.headings) } : { kind: "notFound" };
    }
  }
}

/**
 * The longest body a save can be: every note and the general notes at their limit, JSON-escaped (twice the characters at most), the headings
 * likewise, and the rest. Far under Vercel's 4.5 MB for a body.
 */
export const MAX_SAVE_CHARS = (PROTOCOL_LIMITS.stages + 1) * PROTOCOL_LIMITS.note * 2 + PROTOCOL_LIMITS.stages * PROTOCOL_LIMITS.title * 2 + 4096;

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** A draft as JSON: its dates as ISO strings. */
export const draftJson = (d: ProtocolDraft) => ({
  id: d.id,
  version: d.version,
  stages: d.stages,
  generalNote: d.generalNote,
  sentVersion: d.sentVersion,
  sentAt: d.sentAt?.toISOString() ?? null,
  updatedAt: d.updatedAt?.toISOString() ?? null,
});

/**
 * POST /api/admin/protokoll — one autosave (the route wraps this in withAdmin). The body is a SaveInput as JSON. 200 `{ ok: true, version,
 * savedAt, protocolId }`; 409 `{ ok: false, error: "conflict", protocol }` (what is stored: the screen shows it); 404 `{ ok: false, error: "notFound" }`;
 * 400 `{ error: "body" }` (not a save), `{ error: "text" }` (text Postgres cannot store: the screen cleans pasted text first) or
 * `{ error: "tooLong", places }` (a box over 10 000 characters: nothing is cut, the screen says so first); 413 `{ error: "size" }`; 500
 * `{ error: "server" }`, logged by the registration's id. Never cached.
 * A save from an older version whose text differs, or one built on another row (`protocolId`), is answered 409 with the stored protocol.
 * Recognising a lost answer of its own is the client's job: the screen keeps every unacknowledged text it sent and treats a 409 whose stored
 * text equals one of them as its own save.
 */
export async function handleSave(db: Db, request: Request, now: Date): Promise<Response> {
  let value: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_SAVE_CHARS) return json({ ok: false, error: "size" }, 413);
    value = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "body" }, 400);
  }
  const parsed = saveBody.safeParse(value);
  if (!parsed.success) return json({ ok: false, error: "body" }, 400);
  const input = parsed.data;
  if (![...input.notes, input.generalNote].every(storable)) return json({ ok: false, error: "text" }, 400);
  const places = overLimit(input.notes, input.generalNote);
  if (places.length > 0) return json({ ok: false, error: "tooLong", places }, 400);
  try {
    const result = await saveProtocol(db, input, now);
    if (result.kind === "saved") return json({ ok: true, version: result.version, savedAt: result.savedAt.toISOString(), protocolId: result.protocolId });
    if (result.kind === "conflict") return json({ ok: false, error: "conflict", protocol: draftJson(result.protocol) }, 409);
    return json({ ok: false, error: "notFound" }, 404);
  } catch (e) {
    logFailure(`[protocols] registration ${input.registrationId}: the save failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
}

/**
 * GET /api/admin/protokoll?sessioon=<id> | ?registreering=<id> — the protocol screen's data again (the route wraps this in withAdmin): what the page
 * handed the screen when it was rendered, read now. A screen the browser restored from its cache (the Back button) shows the render of the visit,
 * older than what was saved since, so it asks for this and takes the server's text (protocol-autosave.ts reconcile). 200 `{ ok: true, students }`
 * (domain/protocols.ts ScreenStudentView, the page's own); 400 `{ error: "body" }` without a valid id; 404 `{ error: "notFound" }` for no such session
 * or registration of a contact course; 500 `{ error: "server" }`, logged by the id. Never cached. Reads only: nothing is created by looking.
 */
export async function handleRead(db: Db, request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const sessionId = parseRowId(query.get("sessioon") ?? "");
  const registrationId = sessionId === null ? parseRowId(query.get("registreering") ?? "") : null;
  if (sessionId === null && registrationId === null) return json({ ok: false, error: "body" }, 400);
  try {
    const screen = sessionId !== null ? await protocolScreen(db, { sessionId }) : await protocolScreen(db, { registrationId: registrationId! });
    if (!screen) return json({ ok: false, error: "notFound" }, 404);
    return json({ ok: true, students: screenStudents(screen) });
  } catch (e) {
    logFailure(`[protocols] ${sessionId !== null ? "session" : "registration"} ${sessionId ?? registrationId}: the screen could not be read`, e);
    return json({ ok: false, error: "server" }, 500);
  }
}

// ---------- sending (spec §4 "Saada", §6, §8) ----------

export type SendDeps = {
  db: Db;
  /** The mail's settings (Resend). */
  env: Env;
  /** The base of the mail's links: the address Maria works on (mslab.ee), or SITE_URL. */
  siteUrl: string;
  now: Date;
  /** Runs work after the answer: the mail (next/server after(); collected and awaited in the tests). */
  later: (task: () => Promise<unknown>) => void;
  /** The pause between the mails of one call, ms (MAIL_GAP_MS when absent; the tests pass 0 so they do not sleep). */
  mailGapMs?: number;
};

/** The pause between two protocol mails of a bulk send: Resend answers 429 above about 2 requests a second (500 ms), and a request takes time too. */
export const MAIL_GAP_MS = 600;

/**
 * What a send did. sent: frozen now (`again`: it had been sent before, so the mail says "uuendatud"); already: this version was sent before
 * (a second tap, another device), nothing done; empty: nothing written, never sent; stale: the stored version is not the one the screen
 * showed (`version`: the stored one); cancelled: the registration is cancelled, never sent; notFound: no registration of a contact course.
 */
export type SendResult =
  | { kind: "sent"; again: boolean; version: number; sentAt: string }
  | { kind: "already"; version: number; sentAt: string }
  | { kind: "empty" }
  | { kind: "stale"; version: number }
  | { kind: "cancelled" }
  | { kind: "notFound" };

/** A send as the screen's actions answer it: failed when it threw (logged by the registration's id). */
export type SendOutcome = SendResult | { kind: "failed" };

/** The mail of a sent protocol, made after the commit: to whom, in which language, about which course. */
type ProtocolMailJob = { registrationId: number; email: string; name: string; locale: "et" | "ru"; course: I18n; session: SessionInfo | null; again: boolean };

/**
 * "Saada" (spec §4, §8, D3): one student's protocol, at the `version` the screen showed, in one transaction:
 * 1. the locks, in the order every writer of these rows takes them: the address (client-auth.ts lockAddress — the logins and addClient take
 *    it and then write registrations, so taking the registration first would deadlock with a login at the same moment), then the
 *    registration (db/queries/seats.ts lockRegistration), then the protocol row (FOR UPDATE: a save that comes meanwhile waits for the freeze);
 * 2. the checks: a cancelled registration is never sent; nothing written is "empty"; another version than the screen's is "stale"; the
 *    version sent already is "already" (two sends at once: the first sends, the second finds it sent);
 * 3. the account: when the registration has none, the address's account is found or created as "Lisa õpilane" does it (admin-clients.ts
 *    addClient, in a savepoint of this transaction) and the registration is linked to it;
 * 4. the freeze: `sent` = the draft as it is, `sent_at`, `sent_version`.
 * The mail goes out after the commit (`later`): a live login in its button, the feedback line on the first send. A mail that fails never
 * undoes the send. A sample address is never mailed.
 */
export async function sendProtocol(deps: SendDeps, input: { registrationId: number; version: number }): Promise<SendResult> {
  const { result, mail } = await freezeProtocol(deps, input);
  if (mail) deps.later(() => mailProtocols(deps, [mail]));
  return result;
}

/** The transaction of sendProtocol; it answers with the mail still to go instead of queuing it, so a bulk send can queue all of its mails as one task. */
async function freezeProtocol(deps: SendDeps, input: { registrationId: number; version: number }): Promise<{ result: SendResult; mail: ProtocolMailJob | null }> {
  const [peek] = await deps.db.select({ email: registrations.email }).from(registrations).where(eq(registrations.id, input.registrationId)).limit(1);
  if (!peek) return { result: { kind: "notFound" }, mail: null };
  const done = await deps.db.transaction(async (tx): Promise<{ result: SendResult; mail: ProtocolMailJob | null }> => {
    const t = tx as unknown as Db;
    const none = (result: SendResult) => ({ result, mail: null });
    await lockAddress(t, normalizeEmail(peek.email));
    await lockRegistration(tx, input.registrationId);
    const [r] = await tx
      .select({ registration: registrations, course: { type: courses.type, title: courses.title }, session: courseSessions })
      .from(registrations)
      .innerJoin(courses, eq(registrations.courseId, courses.id))
      .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
      .where(eq(registrations.id, input.registrationId))
      .limit(1);
    if (!r || r.course.type !== "contact") return none({ kind: "notFound" });
    if (r.registration.status === "cancelled") return none({ kind: "cancelled" });
    const [p] = await tx.select().from(protocols).where(eq(protocols.registrationId, input.registrationId)).for("update");
    if (!p || !hasText(p)) return none({ kind: "empty" });
    if (p.version !== input.version) return none({ kind: "stale", version: p.version });
    if (p.sentAt !== null && p.sentVersion === p.version) return none({ kind: "already", version: p.version, sentAt: p.sentAt.toISOString() });
    if (r.registration.clientId === null) {
      const client = await addClient(t, r.registration.email);
      if (client.ok)
        await tx.update(registrations).set({ clientId: client.id }).where(and(eq(registrations.id, input.registrationId), isNull(registrations.clientId)));
    }
    await tx
      .update(protocols)
      .set({ sent: sql`jsonb_build_object('stages', ${protocols.stages}, 'generalNote', ${protocols.generalNote})`, sentAt: deps.now, sentVersion: p.version })
      .where(eq(protocols.registrationId, input.registrationId));
    const s = r.session;
    const again = p.sentAt !== null;
    return {
      result: { kind: "sent", again, version: p.version, sentAt: deps.now.toISOString() },
      mail: {
        registrationId: input.registrationId,
        email: r.registration.email,
        name: r.registration.name,
        locale: r.registration.locale === "ru" ? "ru" : "et",
        course: r.course.title,
        session: s ? { startsAt: s.startsAt, city: s.city, venue: s.venue } : null,
        again,
      },
    };
  });
  if (done.result.kind === "sent") console.info(`[protocols] registration ${input.registrationId}: sent${done.result.again ? " again" : ""}`);
  return done;
}

/**
 * The mails of the sends of one call, after the commit, as ONE task: one after another, `mailGapMs` apart. Resend answers 429 above about 2
 * requests a second, and Next runs every task of after() at once, so a task for each student would send them all in the same moment and lose
 * the ones refused. A lost mail cannot be re-sent for its version (a second send of it is "already"), so the mails wait for each other here.
 */
async function mailProtocols(deps: SendDeps, jobs: readonly ProtocolMailJob[]): Promise<void> {
  const gap = deps.mailGapMs ?? MAIL_GAP_MS;
  let requested = false; // the last job went to Resend: the next one waits
  for (const job of jobs) {
    if (requested && gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    requested = await mailProtocol(deps, job);
  }
}

/** The login of a protocol mail, or null when the address has its 3 already or the database failed: then the mail goes without the code (as submit.ts liveLogin does). */
async function protocolLogin(deps: SendDeps, job: ProtocolMailJob): Promise<LoginCode | null> {
  try {
    return await issueClientLogin(deps.db, job.email, deps.now);
  } catch (e) {
    logFailure(`[protocols] registration ${job.registrationId}: login code unavailable, the mail goes without it`, e);
    return null;
  }
}

/**
 * One protocol mail: never to a sample address, not counted in the daily caps (it follows Maria's own send, a handful a course day). The
 * login is a normal client login made only now (client-auth.ts issueClientLogin), so its 30 minutes start with the mail; an address that has
 * its 3 already, or a login that cannot be made, gets the mail without one, its button opening the page. A mail Resend does not take is logged
 * as a failure by the registration's id and never undoes the send. true = a request went to Resend (the next mail waits for it).
 */
async function mailProtocol(deps: SendDeps, job: ProtocolMailJob): Promise<boolean> {
  if (isSampleAddress(job.email) || !mailConfigured(deps.env)) return false;
  try {
    const login = await protocolLogin(deps, job);
    if (await sendMail(deps.env, protocolMail({ siteUrl: deps.siteUrl, ...job, login }))) console.info(`[protocols] registration ${job.registrationId}: the mail sent`);
    else logNote(`[protocols] registration ${job.registrationId}: the mail was not sent`);
  } catch (e) {
    logFailure(`[protocols] registration ${job.registrationId}: the mail failed`, e);
  }
  return true;
}

/** One student's outcome of "Lukusta ja saada kõik". */
export type BulkResult = { registrationId: number; result: SendOutcome };

/**
 * "Lukusta ja saada kõik" (spec §4, §8): the protocols the confirmation listed, one after another, each in its own transaction (like
 * sendProtocol), so one that fails does not stop the others; a throw is "failed", logged by the registration's id. The mails of the ones
 * sent go out as one task after the last transaction, one after another (mailProtocols).
 */
export async function sendProtocols(deps: SendDeps, items: readonly { registrationId: number; version: number }[]): Promise<BulkResult[]> {
  const out: BulkResult[] = [];
  const mails: ProtocolMailJob[] = [];
  for (const item of items) {
    try {
      const { result, mail } = await freezeProtocol(deps, item);
      out.push({ registrationId: item.registrationId, result });
      if (mail) mails.push(mail);
    } catch (e) {
      logFailure(`[protocols] registration ${item.registrationId}: the send failed`, e);
      out.push({ registrationId: item.registrationId, result: { kind: "failed" } });
    }
  }
  if (mails.length > 0) deps.later(() => mailProtocols(deps, mails));
  return out;
}

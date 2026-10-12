import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { draftOf, type ProtocolDraft } from "@/db/queries/protocols";
import { courses, protocols, registrations, type Protocol, type ProtocolStage } from "@/db/schema";
import { overLimit, PROTOCOL_LIMITS, readStages } from "@/domain/protocols";
import { storable } from "@/lib/storable";
import { logFailure } from "./log";

// Maria's protocols on the course day (phase protocols, spec §3, §4, §8), without Next.js: the autosave (saveProtocol, and handleSave behind
// app/api/admin/protokoll) and the sending (sendProtocol, Task 3). The admin session is checked by the callers (withAdmin, adminAction).
// Logs carry the registration's id only: never a note, a name or an address.
//
// A protocol is created by its first save, with the course's headings as they are then (spec §3); until then the screen shows those headings
// with empty boxes and the status is "none". Every save carries the version the screen has, and the headings it shows: a save from another
// version, or for other headings, is refused with what is stored, so newer text is never overwritten and a note never lands under another
// heading (spec §4, §9). A save that changes nothing raises nothing: a look at a protocol, or the repeat of a save whose answer was lost, is
// answered with the version that holds that text.

/** What a save sends: the registration, the version the screen has (0: none yet), the headings it shows and the notes under them. */
export const saveBody = z.object({
  registrationId: z.number().int().positive().max(2_147_483_647),
  version: z.number().int().min(0).max(2_147_483_647),
  titles: z.array(z.string().max(PROTOCOL_LIMITS.title)).max(PROTOCOL_LIMITS.stages),
  notes: z.array(z.string()).max(PROTOCOL_LIMITS.stages),
  generalNote: z.string(),
});
export type SaveInput = z.infer<typeof saveBody>;

export type SaveResult = { kind: "saved"; version: number; savedAt: Date } | { kind: "conflict"; protocol: ProtocolDraft } | { kind: "notFound" };

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
 * The insert and the update are each one conditional statement; one that meets another save at the same moment reads again and decides on
 * what is stored then (twice at most, then the answer is a conflict with the protocol as it is).
 */
export async function saveProtocol(db: Db, input: SaveInput, now: Date): Promise<SaveResult> {
  for (let attempt = 0; ; attempt++) {
    const found = await current(db, input.registrationId);
    if (!found) return { kind: "notFound" };
    const { headings, stored } = found;
    if (stored === null) {
      if (input.version !== 0 || !sameList(headings, input.titles)) return { kind: "conflict", protocol: draftOf(null, headings) };
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
      if (created) return { kind: "saved", version: created.version, savedAt: now };
    } else {
      if (holds(stored, input)) return { kind: "saved", version: stored.version, savedAt: stored.updatedAt };
      if (input.version !== stored.version || !sameList(titlesOf(stored.stages), input.titles)) return { kind: "conflict", protocol: draftOf(stored, headings) };
      const [updated] = await db
        .update(protocols)
        .set({ stages: stored.stages.map((s, i) => ({ title: s.title, note: input.notes[i] })), generalNote: input.generalNote, version: sql`${protocols.version} + 1`, updatedAt: now })
        .where(and(eq(protocols.registrationId, input.registrationId), eq(protocols.version, input.version)))
        .returning();
      if (updated) return { kind: "saved", version: updated.version, savedAt: now };
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
  version: d.version,
  stages: d.stages,
  generalNote: d.generalNote,
  sentVersion: d.sentVersion,
  sentAt: d.sentAt?.toISOString() ?? null,
  updatedAt: d.updatedAt?.toISOString() ?? null,
});

/**
 * POST /api/admin/protokoll — one autosave (the route wraps this in withAdmin). The body is a SaveInput as JSON. 200 `{ ok: true, version,
 * savedAt }`; 409 `{ ok: false, error: "conflict", protocol }` (what is stored: the screen shows it); 404 `{ ok: false, error: "notFound" }`;
 * 400 `{ error: "body" }` (not a save), `{ error: "text" }` (text Postgres cannot store: the screen cleans pasted text first) or
 * `{ error: "tooLong", places }` (a box over 10 000 characters: nothing is cut, the screen says so first); 413 `{ error: "size" }`; 500
 * `{ error: "server" }`, logged by the registration's id. Never cached.
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
  if (!parsed.success || parsed.data.notes.length !== parsed.data.titles.length) return json({ ok: false, error: "body" }, 400);
  const input = parsed.data;
  if (![...input.notes, input.generalNote].every(storable)) return json({ ok: false, error: "text" }, 400);
  const places = overLimit(input.notes, input.generalNote);
  if (places.length > 0) return json({ ok: false, error: "tooLong", places }, 400);
  try {
    const result = await saveProtocol(db, input, now);
    if (result.kind === "saved") return json({ ok: true, version: result.version, savedAt: result.savedAt.toISOString() });
    if (result.kind === "conflict") return json({ ok: false, error: "conflict", protocol: draftJson(result.protocol) }, 409);
    return json({ ok: false, error: "notFound" }, 404);
  } catch (e) {
    logFailure(`[protocols] registration ${input.registrationId}: the save failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
}

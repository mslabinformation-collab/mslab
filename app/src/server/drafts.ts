import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Db, Q, Tx } from "@/db/client";
import type * as schema from "@/db/schema";
import { contentDrafts } from "@/db/schema";
import type { SaveAnswer } from "@/domain/autosave";
import { logFailure } from "./log";

// The draft layer's store (admin UX pass, README §1.8, behaviours.md B2; the table `content_drafts`, migration 0017). For a published thing (a
// course, a home page part, the trainer page, a post, the popup, the practice page) the autosave writes its parts here and leaves the live rows alone;
// „Avalda muudatused“ copies them live in one transaction, „Loobu muudatustest“ deletes them. The public pages lay the drafts over live data only in
// Next's draft mode (spec C3: api/admin/eelvaade), so a visitor's page and its cache (server/public-cache.ts) never see one.
//
// Generic: an entity's own code (added with its screen) says what its parts are and how a part is read and written live — its `Publisher`. No Next.js
// import here, so the rules run on PGlite in the tests.
//
// The rules:
// - A part's draft has its own `version`, 1 at the creation and +1 at each save: a compare-and-set, so two tabs never save over each other unseen.
// - `baseVersion` is the live part's version the draft was made from. It is kept for the draft's whole life (later saves edit the draft, not live),
//   and a publish copies the part only while live still has it: a part changed live meanwhile (another way of saving it, another publish) is
//   blocked, never overwritten, and its draft stays.
// - The draft layer never changes live by itself: only publishDrafts writes there, through the entity's own writer.
// - One lock order for an entity row (ledger T11, 40P01): the entity's own row first (its `Publisher.lock`, e.g. a course's `FOR UPDATE`), then
//   its drafts. A save, a discard and a publish of the same row each take the row's lock before they touch `content_drafts`, so two of them never
//   wait for each other the other way round. An entity whose saves run in a transaction of their own takes the lock there and passes the
//   transaction in (every function here takes a Db or an open transaction).

/**
 * One part's draft as the editor and the preview read it. `id`: the draft row's own (a serial, never used again): a draft made after an earlier one of
 * the same part ended (published, discarded, dropped) starts its `version` at 1 again, so an entity that hands the version to its editor names the
 * row too (server/course-parts.ts "d:<id>.<version>"), and a tab still on the earlier draft is never taken for the new one's.
 */
export type DraftPart = { id: number; part: string; value: unknown; baseVersion: string; version: number; updatedAt: Date };

/** The answer of a draft save: the draft's version after it, or a conflict with what is stored (version 0, value null: there is no draft any more). */
export type DraftSaveResult = { ok: true; version: number } | { ok: false; error: "conflict"; version: number; value: unknown };

/**
 * How an entity's parts go live (one per entity kind, made by its screen's code). Its methods run inside the publish's transaction:
 * - `liveVersion`: the live part's version now, comparable with the `baseVersion` its drafts were saved with. It must read under the lock its
 *   writer takes (`lock` below, the `FOR UPDATE` of the live row), so that nothing changes live between the check and the write;
 * - `write`: stores the draft's value as the live part, through the entity's existing writer (with its checks). A throw rolls the whole publish back;
 * - `revalidate`: marks the public pages that show the entity stale (server/public-cache.ts revalidatePublic); called once, after the commit,
 *   and only when a part was published;
 * - `lock` (optional): takes the entity row's lock, first thing in the transaction, before the drafts are read (the lock order above). The live
 *   versions read after it cannot change before the writes: the entity's other writers take the same lock;
 * - `hold` (optional): the entity's own rules at publish, which a part's check at its save cannot make (a published course needs a price, and a
 *   price may wait in a draft). Asked once, after every live version and before any write, with the parts whose base still matches and their
 *   drafts' values; the parts it names are not written and keep their drafts (blocked, like a part changed meanwhile).
 */
export type Publisher = {
  liveVersion(tx: Tx, part: string): Promise<string>;
  write(tx: Tx, part: string, value: unknown): Promise<void>;
  revalidate(): void;
  lock?(tx: Tx): Promise<void>;
  hold?(tx: Tx, parts: { part: string; value: unknown }[]): Promise<string[]>;
};

/** The cast of db/queries/payments.ts releaseHold: on the Db union (and an open transaction of it), returning(fields) has no common overload. */
const pg = (db: Q) => db as unknown as PostgresJsDatabase<typeof schema>;

const ofRow = (entity: string, entityId: number) => and(eq(contentDrafts.entity, entity), eq(contentDrafts.entityId, entityId));
const ofPart = (entity: string, entityId: number, part: string) => and(ofRow(entity, entityId), eq(contentDrafts.part, part));

/**
 * The drafts of one entity row, in the order their parts were first saved (empty: nothing unpublished). Runs in a caller's transaction too.
 * `only` and `except`: the parts the query takes, or leaves out, so the values of the others are never loaded (the public preview does not load a course's
 * test draft, whose value is the answer key: server/course-parts.ts withCourseDrafts, server/course-outline.ts readLayout).
 */
export async function readDrafts(q: Q, entity: string, entityId: number, opts: { only?: readonly string[]; except?: readonly string[] } = {}): Promise<DraftPart[]> {
  const filters = [ofRow(entity, entityId)];
  if (opts.only) filters.push(inArray(contentDrafts.part, [...opts.only]));
  if (opts.except && opts.except.length > 0) filters.push(notInArray(contentDrafts.part, [...opts.except]));
  return q
    .select({ id: contentDrafts.id, part: contentDrafts.part, value: contentDrafts.value, baseVersion: contentDrafts.baseVersion, version: contentDrafts.version, updatedAt: contentDrafts.updatedAt })
    .from(contentDrafts)
    .where(and(...filters))
    .orderBy(asc(contentDrafts.id));
}

/** The stored draft of a part as a conflict answer; version 0 and value null when there is none. */
async function storedConflict(db: Q, entity: string, entityId: number, part: string): Promise<DraftSaveResult & { ok: false }> {
  const [row] = await db.select({ version: contentDrafts.version, value: contentDrafts.value }).from(contentDrafts).where(ofPart(entity, entityId, part));
  return row ? { ok: false, error: "conflict", version: row.version, value: row.value } : { ok: false, error: "conflict", version: 0, value: null };
}

/**
 * Saves a part's draft (`value`: the whole part; JSON, not null).
 * - `version` null: the first change of the part, made from live at `baseVersion`. Creates the draft at version 1. When a draft is there already
 *   (another tab made it first), a conflict with its version and value, and nothing is changed.
 * - `version` n: a save of the draft at version n. Stores the value at n + 1, keeping the draft's base (the `baseVersion` passed is not used: the
 *   draft was made from the live version it has). A draft at another version is a conflict with what is stored; a draft that is gone (published
 *   or discarded meanwhile) is a conflict with version 0 and value null: the screen then reads live again and starts a new draft from there.
 * The write is one statement either way: the unique index and the version's compare-and-set settle two saves at once (no lock is held across
 * calls); only a refused one reads the stored draft afterwards. Inside a caller's transaction (`db` an open one) it is one statement of it.
 */
export async function saveDraftPart(
  db: Q,
  d: { entity: string; entityId: number; part: string; value: unknown; baseVersion: string; version: number | null; by: string },
): Promise<DraftSaveResult> {
  if (d.version === null) {
    const [created] = await pg(db)
      .insert(contentDrafts)
      .values({ entity: d.entity, entityId: d.entityId, part: d.part, value: d.value, baseVersion: d.baseVersion, version: 1, updatedBy: d.by })
      .onConflictDoNothing({ target: [contentDrafts.entity, contentDrafts.entityId, contentDrafts.part] })
      .returning({ version: contentDrafts.version });
    return created ? { ok: true, version: created.version } : storedConflict(db, d.entity, d.entityId, d.part);
  }
  const [saved] = await pg(db)
    .update(contentDrafts)
    .set({ value: d.value, version: d.version + 1, updatedAt: sql`now()`, updatedBy: d.by })
    .where(and(ofPart(d.entity, d.entityId, d.part), eq(contentDrafts.version, d.version)))
    .returning({ version: contentDrafts.version });
  return saved ? { ok: true, version: saved.version } : storedConflict(db, d.entity, d.entityId, d.part);
}

/**
 * Deletes one part's draft: the entity's save found it typed back to the live value, so no change is left to publish (the part is live's again).
 * Inside the entity's transaction, after its lock; true when there was a draft.
 */
export async function dropDraftPart(db: Q, entity: string, entityId: number, part: string): Promise<boolean> {
  return (await pg(db).delete(contentDrafts).where(ofPart(entity, entityId, part)).returning({ id: contentDrafts.id })).length > 0;
}

/**
 * A draft's version as its editor holds it (piece 3a R-b, I-1): "d:<draft row id>.<n>", the row's own id and its counter, so a tab still on an earlier
 * draft of the part is never taken for a later one's. A part with no draft is "l:<hash>", the hash of its live value (each entity's own).
 */
export const draftVersion = (id: number, n: number): string => `d:${id}.${n}`;

/**
 * The end of an entity's draft save (server/autosave-route.ts' contract; course-parts.ts writeCoursePart, legal-drafts.ts writeLegalDraft,
 * site-drafts.ts writeSitePart), inside the entity's transaction, after its lock, its read at the version the screen sent, its checks and its
 * "the same value again" answer:
 * - typed back to what is live (`sameAsLive`, by the entity's own rule): no change is left to publish, so the draft goes (when there is one) and the
 *   answer is live's version "l:<liveHash>";
 * - else the draft is made (from live at `liveHash`, `draft` null) or saved (its compare-and-set, `draft` the one read), and the answer is its new
 *   version "d:<id>.<n>" (a draft just made: its row's id, read under the same lock);
 * - a save the store refuses (under the entity's lock nothing saves the draft between the read and the write: answered as any conflict) answers
 *   what is stored now (`reread`: the part's version and value as the editor reads them).
 */
export async function finishDraftSave(
  tx: Q,
  d: {
    entity: string;
    entityId: number;
    part: string;
    value: unknown;
    liveHash: string;
    draft: { id: number; version: number } | null;
    sameAsLive: boolean;
    by: string;
    savedAt: string;
    reread: () => Promise<{ version: string; value: unknown }>;
  },
): Promise<SaveAnswer> {
  if (d.sameAsLive) {
    if (d.draft) await dropDraftPart(tx, d.entity, d.entityId, d.part);
    return { ok: true, version: `l:${d.liveHash}`, savedAt: d.savedAt };
  }
  const saved = await saveDraftPart(tx, { entity: d.entity, entityId: d.entityId, part: d.part, value: d.value, baseVersion: d.liveHash, version: d.draft?.version ?? null, by: d.by });
  if (saved.ok) {
    const rowId = d.draft?.id ?? (await readDrafts(tx, d.entity, d.entityId, { only: [d.part] }))[0]?.id;
    if (rowId !== undefined) return { ok: true, version: draftVersion(rowId, saved.version), savedAt: d.savedAt };
  }
  const stored = await d.reread();
  return { ok: false, error: "conflict", version: stored.version, value: stored.value };
}

/**
 * „Loobu muudatustest“: deletes every draft of the entity row (live stays as it is). The number of parts deleted. An entity with a row lock calls it
 * inside its own transaction, after the lock (the lock order above).
 */
export async function discardDrafts(db: Q, entity: string, entityId: number): Promise<number> {
  return (await pg(db).delete(contentDrafts).where(ofRow(entity, entityId)).returning({ id: contentDrafts.id })).length;
}

/**
 * The work of „Avalda muudatused“ inside a caller's transaction `tx` (publishDrafts below is it in a transaction of its own, then revalidates):
 * 0. `p.lock` (if any): the entity row's lock, before its drafts;
 * 1. its drafts are locked (`FOR UPDATE`: a save or a second publish of the same row waits; a publish that waited finds the published drafts gone);
 * 2. each part's live version is compared with its draft's base, every part before the first write (so a write cannot change another part's check);
 *    then `p.hold` (if any) is asked about the parts whose base still matches;
 * 3. the parts whose base still matches and that are not held are written live through `p.write` and their drafts deleted; the others are left as
 *    they are (blocked).
 * It never revalidates: the caller does, after its commit (a caller that refuses afterwards throws, and its transaction takes everything back).
 */
export async function publishDraftsIn(tx: Tx, entity: string, entityId: number, p: Publisher): Promise<{ published: string[]; blocked: string[] }> {
  if (p.lock) await p.lock(tx);
  const drafts = await tx
    .select({ id: contentDrafts.id, part: contentDrafts.part, value: contentDrafts.value, baseVersion: contentDrafts.baseVersion })
    .from(contentDrafts)
    .where(ofRow(entity, entityId))
    .orderBy(asc(contentDrafts.id))
    .for("update");
  const current: boolean[] = [];
  for (const d of drafts) current.push((await p.liveVersion(tx, d.part)) === d.baseVersion);
  const candidates = drafts.filter((_, i) => current[i]);
  const held = new Set(p.hold && candidates.length > 0 ? await p.hold(tx, candidates.map((d) => ({ part: d.part, value: d.value }))) : []);
  const published: string[] = [];
  const blocked: string[] = [];
  for (const [i, d] of drafts.entries()) {
    if (!current[i] || held.has(d.part)) {
      blocked.push(d.part);
      continue;
    }
    await p.write(tx, d.part, d.value);
    await tx.delete(contentDrafts).where(eq(contentDrafts.id, d.id));
    published.push(d.part);
  }
  return { published, blocked };
}

/**
 * „Avalda muudatused“ for one entity row, in ONE transaction (publishDraftsIn: the row's lock, its drafts locked, every part's live version
 * compared, the entity's rules asked, then the writes). A throw anywhere rolls everything back: live is as it was and every draft stays. After the
 * commit, `p.revalidate()` once if a part was published (a failure there is logged: the publish stands, and the pages catch up with their own
 * `revalidate`). The answer lists the parts by name, in the order they were first saved.
 */
export async function publishDrafts(db: Db, entity: string, entityId: number, p: Publisher): Promise<{ published: string[]; blocked: string[] }> {
  const result = await db.transaction((tx) => publishDraftsIn(tx, entity, entityId, p));
  if (result.published.length > 0) {
    try {
      p.revalidate();
    } catch (e) {
      logFailure(`[drafts] ${entity} ${entityId}: revalidating after the publish failed`, e);
    }
  }
  return result;
}

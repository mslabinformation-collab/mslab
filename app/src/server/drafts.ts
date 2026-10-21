import { and, asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Db, Q, Tx } from "@/db/client";
import type * as schema from "@/db/schema";
import { contentDrafts } from "@/db/schema";
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

/** One part's draft as the editor and the preview read it. */
export type DraftPart = { part: string; value: unknown; baseVersion: string; version: number; updatedAt: Date };

/** The answer of a draft save: the draft's version after it, or a conflict with what is stored (version 0, value null: there is no draft any more). */
export type DraftSaveResult = { ok: true; version: number } | { ok: false; error: "conflict"; version: number; value: unknown };

/**
 * How an entity's parts go live (one per entity kind, made by its screen's code). Both methods run inside the publish's transaction:
 * - `liveVersion`: the live part's version now, comparable with the `baseVersion` its drafts were saved with. It should read under the lock its
 *   writer takes (`FOR UPDATE` of the live row), so that nothing changes live between the check and the write;
 * - `write`: stores the draft's value as the live part, through the entity's existing writer (with its checks). A throw rolls the whole publish back;
 * - `revalidate`: marks the public pages that show the entity stale (server/public-cache.ts revalidatePublic); called once, after the commit,
 *   and only when a part was published.
 */
export type Publisher = {
  liveVersion(tx: Tx, part: string): Promise<string>;
  write(tx: Tx, part: string, value: unknown): Promise<void>;
  revalidate(): void;
};

/** The cast of db/queries/payments.ts releaseHold: on the Db union, returning(fields) has no common overload. */
const pg = (db: Db) => db as unknown as PostgresJsDatabase<typeof schema>;

const ofRow = (entity: string, entityId: number) => and(eq(contentDrafts.entity, entity), eq(contentDrafts.entityId, entityId));
const ofPart = (entity: string, entityId: number, part: string) => and(ofRow(entity, entityId), eq(contentDrafts.part, part));

/** The drafts of one entity row, in the order their parts were first saved (empty: nothing unpublished). Runs in a caller's transaction too. */
export async function readDrafts(q: Q, entity: string, entityId: number): Promise<DraftPart[]> {
  return q
    .select({ part: contentDrafts.part, value: contentDrafts.value, baseVersion: contentDrafts.baseVersion, version: contentDrafts.version, updatedAt: contentDrafts.updatedAt })
    .from(contentDrafts)
    .where(ofRow(entity, entityId))
    .orderBy(asc(contentDrafts.id));
}

/** The stored draft of a part as a conflict answer; version 0 and value null when there is none. */
async function storedConflict(db: Db, entity: string, entityId: number, part: string): Promise<DraftSaveResult & { ok: false }> {
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
 * calls); only a refused one reads the stored draft afterwards.
 */
export async function saveDraftPart(
  db: Db,
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

/** „Loobu muudatustest“: deletes every draft of the entity row (live stays as it is). The number of parts deleted. */
export async function discardDrafts(db: Db, entity: string, entityId: number): Promise<number> {
  return (await pg(db).delete(contentDrafts).where(ofRow(entity, entityId)).returning({ id: contentDrafts.id })).length;
}

/**
 * „Avalda muudatused“ for one entity row, in ONE transaction:
 * 1. its drafts are locked (`FOR UPDATE`: a save or a second publish of the same row waits; a publish that waited finds the published drafts gone);
 * 2. each part's live version is compared with its draft's base, every part before the first write (so a write cannot change another part's check);
 * 3. the parts whose base still matches are written live through `p.write` and their drafts deleted; the others are left as they are (blocked).
 * A throw anywhere rolls everything back: live is as it was and every draft stays. After the commit, `p.revalidate()` once if a part was published (a
 * failure there is logged: the publish stands, and the pages catch up with their own `revalidate`). The answer lists the parts by name, in the order
 * they were first saved.
 */
export async function publishDrafts(db: Db, entity: string, entityId: number, p: Publisher): Promise<{ published: string[]; blocked: string[] }> {
  const result = await db.transaction(async (tx) => {
    const drafts = await tx
      .select({ id: contentDrafts.id, part: contentDrafts.part, value: contentDrafts.value, baseVersion: contentDrafts.baseVersion })
      .from(contentDrafts)
      .where(ofRow(entity, entityId))
      .orderBy(asc(contentDrafts.id))
      .for("update");
    const current: boolean[] = [];
    for (const d of drafts) current.push((await p.liveVersion(tx, d.part)) === d.baseVersion);
    const published: string[] = [];
    const blocked: string[] = [];
    for (const [i, d] of drafts.entries()) {
      if (!current[i]) {
        blocked.push(d.part);
        continue;
      }
      await p.write(tx, d.part, d.value);
      await tx.delete(contentDrafts).where(eq(contentDrafts.id, d.id));
      published.push(d.part);
    }
    return { published, blocked };
  });
  if (result.published.length > 0) {
    try {
      p.revalidate();
    } catch (e) {
      logFailure(`[drafts] ${entity} ${entityId}: revalidating after the publish failed`, e);
    }
  }
  return result;
}

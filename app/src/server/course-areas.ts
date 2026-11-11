import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db, Q, Tx } from "@/db/client";
import { contentDrafts, courseAreas, courses } from "@/db/schema";
import type { SaveAnswer } from "@/domain/autosave";
import { areaNameProblems, areaSlug, cleanAreaName } from "@/domain/course-areas";
import { contentVersion } from "@/lib/version";
import { revalidatePublic } from "./public-cache";

// Seaded → „Valdkonnad“ (course areas, spec 2026-11-11-course-areas-filter-design.md §4.1): Maria's list of training areas, which a course's
// „Põhiinfo“ picks one of („Valdkond“, server/admin-content.ts checkCourseBasics) and the public calendar and catalogue filter by. Callers have checked
// the admin session (the routes api/admin/valdkond/…, inside withAdmin); these take a Db and run without Next.js (tests/db/course-areas.test.ts).
//
// - A row's names autosave on their own route from the row's version (the hash of its two names, as the settings parts' versions are hashes of what is
//   stored): the autosave card pattern's stale-save check, per row, so a row added or moved in another tab never makes this tab's rows conflict.
// - „Lisa valdkond“, the moves (a drag, ↑ / ↓) and „Kustuta“ are explicit presses; each answers the list as it is after it (with each row's version
//   and how many courses use it), which the card takes as it comes.
// - Both names are required, at most 60 characters, on one line and trimmed (domain/course-areas.ts, the browser's check too); the Estonian names are
//   unique by the slug the address uses (areaSlug: case and accents aside), refused as `taken`.
// - An area a course uses is never deleted (`inUse`, with how many): live (courses.area_id, whose foreign key restricts the delete as well) or in a
//   draft of a published course's „Põhiinfo“ (content_drafts, entity "course", part "basics", its value's `areaId`). The delete locks the area's row
//   FOR UPDATE before it counts; a basics save reads the row FOR KEY SHARE inside its own transaction, so one of them waits for the other and a draft
//   never keeps an area that is gone.
// - Every write takes one transaction lock of the list (pg_advisory_xact_lock), so two tabs' adds, renames and moves each see what the other left
//   (no two areas of one slug, no sort lost or doubled).
// - A change revalidates the calendar and the catalogue (server/cache-targets.ts "areas": their chips). Nothing is written when nothing changes.

/** An area as the Seaded card shows it: both names, its version (the stale-save check of its names) and how many courses use it (live or in a draft). */
export type AdminArea = { id: number; name: { et: string; ru: string }; version: string; used: number };

/** A press's answer: the list after it (an add: with the new area's id); or why it was refused. */
export type AreaListAnswer =
  | { ok: true; areas: AdminArea[]; id?: number }
  | { ok: false; error: "notFound" }
  | { ok: false; error: "invalid"; fields: Record<string, string> }
  | { ok: false; error: "inUse"; used: number; areas: AdminArea[] };

const LIST_LOCK = "course-areas";
const lockList = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LIST_LOCK}))`);

/** A stored name as both texts (jsonb read defensively: a missing Russian name is ""). */
const namesOf = (name: { et?: unknown; ru?: unknown } | null): { et: string; ru: string } => ({
  et: typeof name?.et === "string" ? name.et : "",
  ru: typeof name?.ru === "string" ? name.ru : "",
});

/** A row's version: the hash of its two names as stored. */
export const areaVersion = (name: { et: string; ru: string }): Promise<string> => contentVersion({ et: name.et, ru: name.ru });

/** How many courses use each area: a course once per area, whether live (area_id) or in its „Põhiinfo“ draft (value.areaId) or both. */
async function usage(q: Q): Promise<Map<number, number>> {
  const live = await q.select({ course: courses.id, area: courses.areaId }).from(courses).where(isNotNull(courses.areaId));
  const drafted = await q
    .select({ course: contentDrafts.entityId, area: sql<string | null>`${contentDrafts.value}->>'areaId'` })
    .from(contentDrafts)
    .innerJoin(courses, eq(courses.id, contentDrafts.entityId))
    .where(and(eq(contentDrafts.entity, "course"), eq(contentDrafts.part, "basics")));
  const pairs = new Set<string>();
  for (const r of live) if (r.area !== null) pairs.add(`${r.area}:${r.course}`);
  for (const r of drafted) if (r.area !== null && /^\d{1,10}$/.test(r.area)) pairs.add(`${Number(r.area)}:${r.course}`);
  const out = new Map<number, number>();
  for (const p of pairs) {
    const area = Number(p.slice(0, p.indexOf(":")));
    out.set(area, (out.get(area) ?? 0) + 1);
  }
  return out;
}

/** The list in Maria's order (sort, then id), each row with its version and its use. */
export async function readAdminAreas(q: Q): Promise<AdminArea[]> {
  const rows = await q.select().from(courseAreas).orderBy(asc(courseAreas.sort), asc(courseAreas.id));
  const used = await usage(q);
  return Promise.all(
    rows.map(async (r) => {
      const name = namesOf(r.name);
      return { id: r.id, name, version: await areaVersion(name), used: used.get(r.id) ?? 0 };
    }),
  );
}

/** Is there an area of this id (the name route's 404)? */
export async function areaThere(q: Q, id: number): Promise<boolean> {
  const [row] = await q.select({ id: courseAreas.id }).from(courseAreas).where(eq(courseAreas.id, id));
  return row !== undefined;
}

/** The names refused (domain/course-areas.ts areaNameProblems), and the Estonian name `taken` when another area's slug is its slug. */
async function nameErrors(tx: Tx, name: { et: string; ru: string }, self: number | null): Promise<Record<string, string>> {
  const errors: Record<string, string> = { ...areaNameProblems(name) };
  if (!errors.et) {
    const slug = areaSlug(name);
    const others = await tx.select({ id: courseAreas.id, name: courseAreas.name }).from(courseAreas);
    if (others.some((o) => o.id !== self && areaSlug(namesOf(o.name)) === slug)) errors.et = "taken";
  }
  return errors;
}

/**
 * A row's names (the route's patch: `et`, `ru` or both, as typed) over the stored ones at `version`: trimmed, on one line, both required, the
 * Estonian one unique. Another version is a conflict with the names as stored; the same names again answer the version and write nothing. The route
 * has said the row is there; one deleted meanwhile is a conflict with no value (the engine shows it gone).
 */
export async function writeAreaName(db: Db, id: number, patch: { et?: string; ru?: string }, version: string, now: Date): Promise<SaveAnswer> {
  const savedAt = now.toISOString();
  const answer = await db.transaction(async (tx): Promise<SaveAnswer & { changed?: boolean }> => {
    await lockList(tx);
    const [row] = await tx.select().from(courseAreas).where(eq(courseAreas.id, id));
    if (!row) return { ok: false, error: "conflict", version: "", value: null };
    const current = namesOf(row.name);
    const currentVersion = await areaVersion(current);
    if (version !== currentVersion) return { ok: false, error: "conflict", version: currentVersion, value: current };
    const next = {
      et: patch.et === undefined ? current.et : cleanAreaName(patch.et),
      ru: patch.ru === undefined ? current.ru : cleanAreaName(patch.ru),
    };
    const errors = await nameErrors(tx, next, id);
    // (only the fields the patch sent are its refusals: a stored name the rule no longer takes is said once it is typed in)
    const refused = Object.fromEntries(Object.entries(errors).filter(([f]) => f in patch));
    if (Object.keys(refused).length > 0) return { ok: false, error: "invalid", fields: refused };
    if (next.et === current.et && next.ru === current.ru) return { ok: true, version: currentVersion, savedAt };
    await tx.update(courseAreas).set({ name: next }).where(eq(courseAreas.id, id));
    return { ok: true, version: await areaVersion(next), savedAt, changed: true };
  });
  if (answer.ok && answer.changed) revalidatePublic({ kind: "areas" });
  return answer.ok ? { ok: true, version: answer.version, savedAt: answer.savedAt } : answer;
}

/**
 * „Lisa valdkond“: `{ et, ru }` (read defensively: a name that is no text is none, any other key is not read), both names required, the Estonian one
 * unique; the new area goes last. The answer is the list with the new area's id; refused, the fields.
 */
export async function addArea(db: Db, input: unknown): Promise<AreaListAnswer> {
  const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const name = { et: cleanAreaName(typeof raw.et === "string" ? raw.et : ""), ru: cleanAreaName(typeof raw.ru === "string" ? raw.ru : "") };
  const answer = await db.transaction(async (tx): Promise<AreaListAnswer> => {
    await lockList(tx);
    const errors = await nameErrors(tx, name, null);
    if (Object.keys(errors).length > 0) return { ok: false, error: "invalid", fields: errors };
    const [{ last }] = await tx.select({ last: sql<number>`coalesce(max(${courseAreas.sort}), 0)::int` }).from(courseAreas);
    const [made] = await tx.insert(courseAreas).values({ name, sort: last + 1 }).returning();
    return { ok: true, id: made.id, areas: await readAdminAreas(tx) };
  });
  if (answer.ok) revalidatePublic({ kind: "areas" });
  return answer;
}

/**
 * Puts an area at place `index` of the list (0 is the first; past the end: last, below 0: first) and renumbers every sort 1…n, as the course list's
 * move (db/queries/admin.ts moveCourseTo). A move to where it is changes nothing. "notFound": no such area.
 */
export async function moveAreaTo(db: Db, id: number, index: number): Promise<AreaListAnswer> {
  const answer = await db.transaction(async (tx): Promise<AreaListAnswer & { changed?: boolean }> => {
    await lockList(tx);
    const list = await tx.select({ id: courseAreas.id, sort: courseAreas.sort }).from(courseAreas).orderBy(asc(courseAreas.sort), asc(courseAreas.id));
    const from = list.findIndex((a) => a.id === id);
    if (from < 0) return { ok: false, error: "notFound" };
    const [moved] = list.splice(from, 1);
    list.splice(Math.min(Math.max(index, 0), list.length), 0, moved);
    let changed = false;
    for (const [n, a] of list.entries()) {
      if (a.sort === n + 1) continue;
      await tx.update(courseAreas).set({ sort: n + 1 }).where(eq(courseAreas.id, a.id));
      changed = true;
    }
    return { ok: true, areas: await readAdminAreas(tx), changed };
  });
  if (answer.ok && answer.changed) revalidatePublic({ kind: "areas" });
  return answer.ok ? { ok: true, areas: answer.areas } : answer;
}

/**
 * „Kustuta“: an area no course uses goes (the answer: the list without it). One a course uses, live or in a draft, stays: `inUse` with how many (and
 * the list, which says so on its row). The row is locked FOR UPDATE before the count (see the top of the file). "notFound": no such area.
 */
export async function deleteArea(db: Db, id: number): Promise<AreaListAnswer> {
  const answer = await db.transaction(async (tx): Promise<AreaListAnswer> => {
    await lockList(tx);
    const [row] = await tx.select({ id: courseAreas.id }).from(courseAreas).where(eq(courseAreas.id, id)).for("update");
    if (!row) return { ok: false, error: "notFound" };
    const used = (await usage(tx)).get(id) ?? 0;
    if (used > 0) return { ok: false, error: "inUse", used, areas: await readAdminAreas(tx) };
    await tx.delete(courseAreas).where(eq(courseAreas.id, id));
    return { ok: true, areas: await readAdminAreas(tx) };
  });
  if (answer.ok) revalidatePublic({ kind: "areas" });
  return answer;
}

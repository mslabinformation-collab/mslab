import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Q, Tx } from "@/db/client";
import { courseModules, lessons, type Course } from "@/db/schema";
import type { OutlineValue } from "@/domain/course-parts";
import { adminEt } from "@/i18n/dict/admin";
import type { I18n } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { ROW_ID_MAX } from "@/lib/row-id";
import { toStorable } from "@/lib/to-storable";
import { contentVersion, stableJson } from "@/lib/version";
import { dropDraftPart, readDrafts, saveDraftPart, type DraftPart } from "./drafts";
import type { Check } from "./edit-check";

// B18 (admin UX pass piece 3a, Task 5; ruling R-e; README B2): a course's modules and lessons in the course's draft. No Next.js here (tests/db/
// course-outline-draft.test.ts runs it on PGlite); its users are server/course-parts.ts (the `outline` part, its publish and its labels), server/
// admin-lessons.ts (the card's changes) and server/lesson-outline.ts (the admin's preview).
//
// On a PUBLISHED course:
// - the order and the texts of the rows students see (not flagged `unpublished`) are the `outline` part (domain/course-parts.ts OutlineValue): a
//   rename, a lesson's name or short text and a move of such a row go to its draft (`content_drafts`, entity "course", part "outline") and wait for
//   „Avalda muudatused“; the rows stay as they are;
// - a new module or lesson is a real row flagged `unpublished` (its video and files need the row): nobody sees it, so it is renamed and moved on the
//   row itself, and the publish clears the flag;
// - a live lesson moved into a flagged module is a draft move like any other (Task 2 review): the module is listed in the outline holding it, and
//   the row keeps its live module until the publish (students never lose the lesson before);
// - deletes stay instant (R-e): the row goes at once, and a waiting draft goes on from the new live (made again on it), so it can still be published.
// On an UNPUBLISHED course every change is written to the rows at once (spec §10: an unpublished e-course with students too; they see it).
//
// The working order (what the admin's card shows and what the publish makes live), `Layout`: the outline's modules and lessons in its order (the
// draft's, else live's), with the flagged rows placed among them by their own `position`, which is their place in the working order (1…n): a
// flagged module's among the modules, a flagged lesson's in its module. Every change takes the working order, changes it and stores it back: the
// flagged rows' places on their rows, the rest as the outline (a draft, or the rows of an unpublished course), so the two always agree.
// Callers hold the course's lock (db/queries/admin.ts lockCourse) before they read or store it: the lock order of server/drafts.ts.

const ENTITY = "course";
export const OUTLINE_PART = "outline";

/** A module's and a lesson's name and a lesson's short text at most (characters per language). */
export const LESSON_LIMITS = { title: 120, body: 5000 } as const;

// ---------- the value ----------

/** Text as typed, without what Postgres cannot store (as server/course-parts.ts's parts); the real limits are the outline's check. */
const text = z.string().max(20_000, "tooLong").transform(toStorable);
const i18n = z.object({ et: text, ru: text.optional() });
const rowId = z.number().int().positive().max(ROW_ID_MAX);

/** The outline's shape (the part's schema): the modules with their lessons, ids and texts; whether they are the course's rows is checkOutline's. */
export const OUTLINE_SCHEMA = z
  .object({
    modules: z
      .array(z.object({ id: rowId, title: i18n, lessons: z.array(z.object({ id: rowId, title: i18n, body: i18n }).strict()).max(2_000, "tooMany") }).strict())
      .max(500, "tooMany"),
  })
  .strict();

/**
 * A row's text autosave's patches (review I-1; server/admin-lessons.ts writeOutlineText): a module's name, a lesson's name and short text, as typed
 * (some of the fields, no other); their limits are the forms' (LESSON_LIMITS, checked by the write).
 */
export const OUTLINE_TEXT_PATCHES = {
  module: z.object({ title: i18n }).partial().strict(),
  lesson: z.object({ title: i18n, body: i18n }).partial().strict(),
};

// ---------- the rows ----------

type ModuleRow = { id: number; position: number; title: I18n; unpublished: boolean };
type LessonRow = { id: number; moduleId: number; position: number; title: I18n; body: I18n | null; unpublished: boolean; hidden: boolean };
/** A course's module and lesson rows, each list by position, then id. */
export type OutlineRows = { modules: ModuleRow[]; lessons: LessonRow[] };

/** The course's module and lesson rows (two small queries; in the caller's transaction under its lock, or on their own for a read). */
export async function outlineRows(q: Q, courseId: number): Promise<OutlineRows> {
  const modules = await q
    .select({ id: courseModules.id, position: courseModules.position, title: courseModules.title, unpublished: courseModules.unpublished })
    .from(courseModules)
    .where(eq(courseModules.courseId, courseId))
    .orderBy(asc(courseModules.position), asc(courseModules.id));
  const rows = modules.length
    ? await q
        .select({ id: lessons.id, moduleId: lessons.moduleId, position: lessons.position, title: lessons.title, body: lessons.body, unpublished: lessons.unpublished, hidden: lessons.hidden })
        .from(lessons)
        .where(inArray(lessons.moduleId, modules.map((m) => m.id)))
        .orderBy(asc(lessons.position), asc(lessons.id))
    : [];
  return { modules, lessons: rows };
}

/** Is any module or lesson of the course flagged (made on the published course, not published yet)? */
export const hasFlagged = (rows: OutlineRows): boolean => rows.modules.some((m) => m.unpublished) || rows.lessons.some((l) => l.unpublished);

// ---------- the working order ----------

export type LayoutLesson = { id: number; title: I18n; body: I18n; flagged: boolean };
export type LayoutModule = { id: number; title: I18n; flagged: boolean; lessons: LayoutLesson[] };
/** The working order: every module and lesson of the course, flagged ones too, in order, with the texts the admin works on. */
export type Layout = LayoutModule[];

/** A lesson's short text in the outline: `{ et: "" }` for none (the row's null). */
const bodyOf = (body: I18n | null): I18n => body ?? { et: "" };
/** A short text as a row stores it (and the admin's card shows it): a blank one is none. */
export const storedBody = (body: I18n): I18n | null => (body.et.trim() || (body.ru ?? "").trim() ? body : null);
const same = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b);

/** The rows' order as the students have it: every module by its place with its live lessons (a flagged module only when it holds one). */
function liveArrangement(rows: OutlineRows): OutlineValue {
  const modules: OutlineValue["modules"] = [];
  for (const m of rows.modules) {
    const own = rows.lessons.filter((l) => l.moduleId === m.id && !l.unpublished).map((l) => ({ id: l.id, title: l.title, body: bodyOf(l.body) }));
    if (!m.unpublished || own.length > 0) modules.push({ id: m.id, title: m.title, lessons: own });
  }
  return { modules };
}

/**
 * An outline (a stored draft's, a save's) held against the rows: rows that are gone are left out, every module and every live lesson once (the
 * first time); a live module or lesson it lacks (one added since, by another way) is put last (a lesson in its live module); a flagged module keeps
 * its own row's name. Flagged lessons are never in it.
 */
function heldToRows(rows: OutlineRows, value: OutlineValue): OutlineValue {
  const moduleRow = new Map(rows.modules.map((m) => [m.id, m]));
  const liveLesson = new Set(rows.lessons.filter((l) => !l.unpublished).map((l) => l.id));
  const seen = new Set<number>();
  const placed = new Set<number>();
  const modules: OutlineValue["modules"] = [];
  for (const entry of value.modules) {
    const row = moduleRow.get(entry.id);
    if (!row || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const own: OutlineValue["modules"][number]["lessons"] = [];
    for (const l of entry.lessons) {
      if (!liveLesson.has(l.id) || placed.has(l.id)) continue;
      placed.add(l.id);
      own.push({ id: l.id, title: l.title, body: l.body });
    }
    modules.push({ id: entry.id, title: row.unpublished ? row.title : entry.title, lessons: own });
  }
  for (const m of rows.modules) if (!m.unpublished && !seen.has(m.id)) modules.push({ id: m.id, title: m.title, lessons: [] });
  for (const l of rows.lessons) {
    if (l.unpublished || placed.has(l.id)) continue;
    let home = modules.find((m) => m.id === l.moduleId);
    if (!home) {
      const row = moduleRow.get(l.moduleId)!;
      home = { id: row.id, title: row.title, lessons: [] };
      modules.push(home);
    }
    home.lessons.push({ id: l.id, title: l.title, body: bodyOf(l.body) });
  }
  return { modules };
}

/** `list` with each item put at its place (`position`: 1…n, in the order given): a place taken or past the end goes after the one before it. */
function placed<T>(list: T[], items: { position: number; item: T }[]): T[] {
  const out = [...list];
  let last = -1;
  for (const { position, item } of items) {
    const at = Math.min(Math.max(position - 1, last + 1), out.length);
    out.splice(at, 0, item);
    last = at;
  }
  return out;
}

/** The working order of an outline held to the rows (heldToRows): its modules and lessons in its order, the flagged rows at their places. */
function layoutOf(rows: OutlineRows, value: OutlineValue): Layout {
  const flaggedModule = new Set(rows.modules.filter((m) => m.unpublished).map((m) => m.id));
  const entries = new Map(value.modules.map((e) => [e.id, e]));
  const live = value.modules.filter((e) => !flaggedModule.has(e.id)).map((e): LayoutModule => ({ id: e.id, title: e.title, flagged: false, lessons: [] }));
  const modules = placed(
    live,
    rows.modules.filter((m) => m.unpublished).map((m) => ({ position: m.position, item: { id: m.id, title: m.title, flagged: true, lessons: [] } as LayoutModule })),
  );
  return modules.map((m) => ({
    ...m,
    lessons: placed(
      (entries.get(m.id)?.lessons ?? []).map((l): LayoutLesson => ({ id: l.id, title: l.title, body: l.body, flagged: false })),
      rows.lessons
        .filter((l) => l.unpublished && l.moduleId === m.id)
        .map((l) => ({ position: l.position, item: { id: l.id, title: l.title, body: bodyOf(l.body), flagged: true } })),
    ),
  }));
}

/** The outline of a working order: its live rows in order, with a flagged module where a live lesson is placed in it. */
function outlineOf(layout: Layout): OutlineValue {
  return {
    modules: layout
      .filter((m) => !m.flagged || m.lessons.some((l) => !l.flagged))
      .map((m) => ({ id: m.id, title: m.title, lessons: m.lessons.filter((l) => !l.flagged).map((l) => ({ id: l.id, title: l.title, body: l.body })) })),
  };
}

/** The outline part's live value: the rows as the students have them (flagged rows left out). */
export const liveOutline = (rows: OutlineRows): OutlineValue => outlineOf(layoutOf(rows, liveArrangement(rows)));

/** An outline (a stored draft's, read defensively: jsonb holds anything) as the editor reads it, held to the rows; null when it is no outline. */
export function outlineFromDraft(rows: OutlineRows, raw: unknown): OutlineValue | null {
  const parsed = OUTLINE_SCHEMA.safeParse(raw);
  return parsed.success ? outlineOf(layoutOf(rows, heldToRows(rows, parsed.data))) : null;
}

/** The working order: the outline's (the draft's of a published course, held to the rows; else live's) with the flagged rows at their places. */
export function layoutFor(course: Pick<Course, "id" | "published">, rows: OutlineRows, drafts: DraftPart[]): Layout {
  const draft = course.published ? drafts.find((d) => d.part === OUTLINE_PART) : undefined;
  const parsed = draft ? OUTLINE_SCHEMA.safeParse(draft.value) : null;
  return layoutOf(rows, parsed?.success ? heldToRows(rows, parsed.data) : liveArrangement(rows));
}

/** The course's working order now (the rows, then its draft when it is published): under the caller's lock, or on its own for a read. */
export async function readLayout(q: Q, course: Pick<Course, "id" | "published">): Promise<{ rows: OutlineRows; layout: Layout }> {
  const rows = await outlineRows(q, course.id);
  // (only the outline's draft is read: the public preview reads the working order too, and a course's other drafts, the test's answer key among them, are not its business)
  const drafts = course.published ? await readDrafts(q, ENTITY, course.id, { only: [OUTLINE_PART] }) : [];
  return { rows, layout: layoutFor(course, rows, drafts) };
}

// ---------- storing a change ----------

/** Writes the working order to every row whose place, name, text or flag differs: an unpublished course's change, and the publish (`publish`: no flag left). */
async function writeRows(tx: Tx, rows: OutlineRows, layout: Layout, publish: boolean): Promise<void> {
  const moduleRow = new Map(rows.modules.map((m) => [m.id, m]));
  const lessonRow = new Map(rows.lessons.map((l) => [l.id, l]));
  for (const [i, m] of layout.entries()) {
    const row = moduleRow.get(m.id);
    if (!row) continue;
    const want = { position: i + 1, title: m.title, unpublished: publish ? false : row.unpublished };
    if (row.position !== want.position || !same(row.title, want.title) || row.unpublished !== want.unpublished) await tx.update(courseModules).set(want).where(eq(courseModules.id, m.id));
  }
  for (const m of layout)
    for (const [j, l] of m.lessons.entries()) {
      const row = lessonRow.get(l.id);
      if (!row) continue;
      const want = { moduleId: m.id, position: j + 1, title: l.title, body: storedBody(l.body), unpublished: publish ? false : row.unpublished };
      if (row.moduleId !== want.moduleId || row.position !== want.position || !same(row.title, want.title) || !same(row.body, want.body) || row.unpublished !== want.unpublished)
        await tx.update(lessons).set(want).where(eq(lessons.id, l.id));
    }
}

/** The flagged rows' places in the working order, on their rows (nobody sees them: a published course moves them directly). */
async function writeFlaggedPlaces(tx: Tx, rows: OutlineRows, layout: Layout): Promise<void> {
  const moduleRow = new Map(rows.modules.map((m) => [m.id, m]));
  const lessonRow = new Map(rows.lessons.map((l) => [l.id, l]));
  for (const [i, m] of layout.entries()) {
    if (m.flagged && moduleRow.get(m.id)?.position !== i + 1) await tx.update(courseModules).set({ position: i + 1 }).where(eq(courseModules.id, m.id));
  }
  for (const m of layout)
    for (const [j, l] of m.lessons.entries()) {
      const row = lessonRow.get(l.id);
      if (l.flagged && row && (row.moduleId !== m.id || row.position !== j + 1)) await tx.update(lessons).set({ moduleId: m.id, position: j + 1 }).where(eq(lessons.id, l.id));
    }
}

/**
 * Stores a changed working order, under the course's lock (`rows`: the rows as they are now, after a delete too). An unpublished course: written
 * to the rows. A published one: the flagged rows' places on their rows, the rest as the outline draft: made from live (its base: live's version)
 * when there is none, saved over when there is; dropped when the outline is live's again (nothing is left to publish). `deletedFrom`: live itself
 * changed in this transaction (a row deleted at once, R-e; the rows before the delete), so a draft made on live as it was is made again on the new
 * live, with what it held, and stays publishable; a draft whose base was stale already (live changed by another way) keeps its base and stays
 * blocked at the publish, never absorbed (review M-3).
 */
export async function storeLayout(tx: Tx, course: Course, rows: OutlineRows, layout: Layout, by: string, o: { deletedFrom?: OutlineRows } = {}): Promise<void> {
  if (!course.published) return writeRows(tx, rows, layout, false);
  await writeFlaggedPlaces(tx, rows, layout);
  const live = liveOutline(rows);
  const next = outlineOf(layout);
  let draft = (await readDrafts(tx, ENTITY, course.id)).find((d) => d.part === OUTLINE_PART) ?? null;
  if (same(next, live)) {
    if (draft) await dropDraftPart(tx, ENTITY, course.id, OUTLINE_PART);
    return;
  }
  const liveHash = await contentVersion(live);
  if (draft && o.deletedFrom && draft.baseVersion !== liveHash && draft.baseVersion === (await contentVersion(liveOutline(o.deletedFrom)))) {
    await dropDraftPart(tx, ENTITY, course.id, OUTLINE_PART);
    draft = null;
  }
  // a flagged row's own move or delete leaves the outline as it was: its draft (and the version its editor holds) stays as it is
  if (draft && same(outlineFromDraft(rows, draft.value), next)) return;
  const saved = await saveDraftPart(tx, { entity: ENTITY, entityId: course.id, part: OUTLINE_PART, value: next, baseVersion: liveHash, version: draft?.version ?? null, by });
  // (under the course's lock nothing saves the draft between the read and the write)
  if (!saved.ok) throw new Error(`[course-outline] course ${course.id}: the outline draft changed under the course's lock`);
}

/**
 * „Avalda muudatused“ of the modules and lessons, under the course's lock: `value` (the outline's checked draft; null: live's own order) with the
 * flagged rows at their places, written to every row, and no row is flagged any more. True when anything was flagged or `value` was given.
 */
export async function publishOutline(tx: Tx, courseId: number, value: OutlineValue | null): Promise<boolean> {
  const rows = await outlineRows(tx, courseId);
  if (value === null && !hasFlagged(rows)) return false;
  await writeRows(tx, rows, layoutOf(rows, value ? heldToRows(rows, value) : liveArrangement(rows)), true);
  return true;
}

// ---------- the outline part's check ----------

/**
 * A save's (or a publish's) outline against the rows, under the course's lock: every live module and every live lesson of the course exactly once,
 * no flagged lesson, a flagged module only holding a live lesson; a module's and a lesson's name needed, at most 120 characters, a short text at
 * most 5000 (as the card's own forms; the field is `modules`). The checked outline (texts trimmed, a flagged module under its row's name), or null:
 * with the text's error in `c`, or with none when the rows are not the course's (no field text says that: the save's refusal names the field it
 * sent, "invalid", server/course-parts.ts refusedFields).
 */
export async function checkOutline(q: Q, courseId: number, c: Check, value: OutlineValue): Promise<OutlineValue | null> {
  const rows = await outlineRows(q, courseId);
  const moduleRow = new Map(rows.modules.map((m) => [m.id, m]));
  const liveLessons = new Set(rows.lessons.filter((l) => !l.unpublished).map((l) => l.id));
  const modules = value.modules.map((m) => m.id);
  const lessonIds = value.modules.flatMap((m) => m.lessons.map((l) => l.id));
  const fits =
    new Set(modules).size === modules.length &&
    modules.every((id) => moduleRow.has(id)) &&
    rows.modules.every((m) => m.unpublished || modules.includes(m.id)) &&
    value.modules.every((m) => !moduleRow.get(m.id)?.unpublished || m.lessons.length > 0) &&
    new Set(lessonIds).size === lessonIds.length &&
    lessonIds.length === liveLessons.size &&
    lessonIds.every((id) => liveLessons.has(id));
  if (!fits) return null;
  const checked: OutlineValue = {
    modules: value.modules.map((m) => {
      const row = moduleRow.get(m.id)!;
      return {
        id: m.id,
        title: row.unpublished ? row.title : (c.text("modules", m.title, LESSON_LIMITS.title, { required: true }) ?? m.title),
        lessons: m.lessons.map((l) => ({
          id: l.id,
          title: c.text("modules", l.title, LESSON_LIMITS.title, { required: true }) ?? l.title,
          body: c.text("modules", l.body, LESSON_LIMITS.body) ?? { et: "" },
        })),
      };
    }),
  };
  return c.ok ? checked : null;
}

// ---------- the PublishBar's names (piece 3 texts P-3) ----------

const changesText = adminEt.courseEditor.outlineChanges;
const twoDigits = (n: number): string => String(n).padStart(2, "0");

/**
 * The modules' and lessons' changes as the PublishBar names them (P-3): a contact course's programme once, `Programm`; an e-course's `Moodulite
 * järjekord` when the live modules' order differs, then `Moodul {nn}` for each module (by its place in the working order) that is new, holds a new
 * lesson, or whose name, lessons, their order or texts differ from live's. `draft`: the outline's draft held to the rows (null: none). None when
 * nothing waits.
 */
export function outlineLabels(rows: OutlineRows, draft: OutlineValue | null, contact: boolean): string[] {
  const live = liveOutline(rows);
  const layout = layoutOf(rows, draft ?? liveArrangement(rows));
  if (!hasFlagged(rows) && same(outlineOf(layout), live)) return [];
  if (contact) return [adminEt.courseEditor.sections.modulesC];
  const labels: string[] = [];
  const liveOrder = live.modules.filter((m) => !rows.modules.find((r) => r.id === m.id)?.unpublished).map((m) => m.id);
  if (!same(layout.filter((m) => !m.flagged).map((m) => m.id), liveOrder)) labels.push(changesText.moduleOrder);
  const changed = changedRows(rows, layout).modules;
  for (const [i, m] of layout.entries()) if (changed.has(m.id)) labels.push(fill(changesText.module, { nn: twoDigits(i + 1) }));
  return labels;
}

/**
 * The rows of a working order that wait for „Avalda muudatused“ (P-3, README §1.8; the card's „avaldamata“ in a row, Task 9): a module that is new
 * (flagged), holds a new lesson, or whose name, lessons, their order or texts differ from live's — the modules the PublishBar names „Moodul {nn}“ —
 * and a lesson that is new or whose name or short text differs from live's. The modules' order alone changes no row (the bar's „Moodulite järjekord“).
 */
export function changedRows(rows: OutlineRows, layout: Layout): { modules: Set<number>; lessons: Set<number> } {
  const live = liveOutline(rows);
  const liveModule = new Map(live.modules.map((m) => [m.id, m]));
  const liveLesson = new Map(live.modules.flatMap((m) => m.lessons).map((l) => [l.id, l]));
  const out = { modules: new Set<number>(), lessons: new Set<number>() };
  for (const m of layout) {
    const was = liveModule.get(m.id);
    const now = m.lessons.filter((l) => !l.flagged).map((l) => ({ id: l.id, title: l.title, body: l.body }));
    if (m.flagged || m.lessons.some((l) => l.flagged) || !was || !same(was.title, m.title) || !same(was.lessons, now)) out.modules.add(m.id);
    for (const l of m.lessons) {
      const before = liveLesson.get(l.id);
      if (l.flagged || !before || !same(before.title, l.title) || !same(before.body, l.body)) out.lessons.add(l.id);
    }
  }
  return out;
}

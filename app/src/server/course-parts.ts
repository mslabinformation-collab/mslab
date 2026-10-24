import { and, asc, eq, inArray, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Q, Tx } from "@/db/client";
import { clearOtherCourseType, lockCourse, updateCourseColumns, writeCourseImages, writeCourseTest } from "@/db/queries/admin";
import { courseImages, courseModules, courses, courseTests, lessonFiles, lessons, type Course, type CourseImage, type CourseTest } from "@/db/schema";
import type { SaveAnswer } from "@/domain/autosave";
import { COURSE_LANGUAGES, draftFromCourse, type CourseType } from "@/domain/course-editor";
import { changedFields, COURSE_PARTS, isCoursePart, PART_FIELDS, partLabels, partTitle, partValue, PRICE_MISSING, TYPE_PRICE_FIELDS, type CoursePart, type PartValues } from "@/domain/course-parts";
import { adminEt } from "@/i18n/dict/admin";
import { ROW_ID_MAX } from "@/lib/row-id";
import { toStorable } from "@/lib/to-storable";
import { contentVersion, stableJson } from "@/lib/version";
import {
  checkCourseBadge, checkCourseBasics, checkCourseCertificate, checkCourseGallery, checkCourseIncludes, checkCoursePrice, checkCoursePriceRequired,
  checkCourseRecommendations, checkCourseStages, checkCourseTest, type PriceFields,
} from "./admin-content";
import type { LessonCleanup } from "./admin-lessons";
import { fieldCodes } from "./autosave-route";
import { checkOutline, liveOutline, OUTLINE_SCHEMA, outlineFromDraft, outlineLabels, outlineRows, publishOutline, type OutlineRows } from "./course-outline";
import { discardDrafts, dropDraftPart, publishDraftsIn, readDrafts, saveDraftPart, type DraftPart, type Publisher } from "./drafts";
import { Check, type FieldError } from "./edit-check";
import { logFailure } from "./log";
import { revalidatePublic } from "./public-cache";

// A course's parts on the draft layer (admin UX pass piece 3a, Task 4; rulings R-a…R-e; README B2, §1.8; spec §10, §12): the course editor's
// cards save one part at a time (POST /api/admin/koolitus/<id>/osa/<part>, server/autosave-route.ts' contract).
// - A PUBLISHED course: a part's save goes to its draft (`content_drafts`, entity "course", the course's id, the part's name), the live row is left
//   alone; „Avalda muudatused“ (publishCourse) writes every part whose live value is still the one its draft began from, through the same checks as
//   the old editor's save (server/admin-content.ts, one check per part); „Loobu muudatustest“ (discardCourse) deletes the drafts.
// - An UNPUBLISHED course: a part's save is written to the record at once (spec §10: an unpublished e-course with students too; they see it).
// - The versions the editor's autosave holds (R-b, as ruled after the Task 4 review, I-1): "l:<hash>" while the part has no draft, the hash being
//   lib/version.ts contentVersion of the part's live value (R-a); "d:<id>.<n>" once it has one, id the draft row's own (`content_drafts.id`, a serial
//   never used again) and n its counter (the draft layer's numbers, as text for the engine). A draft's counter starts at 1, so after a publish, a
//   discard or a draft dropped back to live the next draft of the part counts 1, 2, … again: the row's id keeps its version apart from every earlier
//   draft's, and a tab (or a copy this browser kept, engine.ts resume) still on an earlier draft is a conflict, never a write. On a published course a
//   save on "l:" whose hash is live's creates the draft (its base: that hash), a save on the draft's "d:<id>.<n>" is its compare-and-set, anything
//   else is a conflict with what is stored; on an unpublished course a save must come from live's "l:" (the hash compare). A draft saved back to the
//   live value is dropped (the part is at its "l:" again), so a draft is always a change.
// - One lock order (ledger T11, 40P01): every save, the publish, the discard and the „Avaldatud“ switch take the course row's lock (lockCourse) first,
//   before they touch the course's drafts; the live values read after it stay as they are until the writes.
// - The type decides which cards there are: the price part has both types' fields, and only the course's type's are checked and stored. On a published
//   course the type is the drafted one while the basics have a draft (the cards follow it; R-a), and the publish writes every part with the type it
//   ends with; a type change empties the other type's fields (db/queries/admin.ts clearOtherCourseType), as the old editor's save does.
// - The test's answer key lives in course_tests and in its draft only; neither rides on a public course object (db/queries/public.ts).
// - The modules and lessons (B18, R-e, Task 5) are the part `outline`: the order and the texts of the rows students see (server/course-outline.ts).
//   A published course's new rows are real rows flagged `unpublished`; the publish writes the outline and clears every flag of the course, also
//   when the outline has no draft (review M-5); the discard deletes the flagged rows and returns their media.
// No Next.js here but the public pages' revalidation (server/public-cache.ts, mocked in the tests): tests/db/course-parts.test.ts runs it on PGlite.

export { COURSE_PARTS, isCoursePart, partLabels, type CoursePart } from "@/domain/course-parts";

const ENTITY = "course";

// ---------- each part's value, as typed (its schema: the shapes and the outer limits; the real limits are the part's check) ----------

/** Text as typed, at most `max` characters, without what Postgres cannot store (a NUL, a lone surrogate: jsonb refuses them, and the 500 would be tried again for good). */
const text = (max: number) => z.string().max(max, "tooLong").transform(toStorable);
const i18n = z.object({ et: text(20_000), ru: text(20_000).optional() });
const itemId = z.string().regex(/^[0-9a-z]{1,32}$/, "invalid");
const question = z.discriminatedUnion("kind", [
  z.object({ id: itemId, kind: z.literal("choice"), text: text(5_000), options: z.array(z.object({ id: itemId, text: text(2_000), correct: z.boolean() })).max(50, "tooMany") }),
  z.object({ id: itemId, kind: z.literal("open"), text: text(5_000) }),
]);
const twice = (ids: string[]) => new Set(ids).size !== ids.length;
/** The questions with their answer key; an id twice is no list the editor makes (newItemId). */
const questions = z
  .array(question)
  .max(200, "tooMany")
  .refine((qs) => !twice(qs.map((q) => q.id)) && !qs.some((q) => q.kind === "choice" && twice(q.options.map((o) => o.id))), "duplicateId");

const SCHEMAS = {
  basics: z
    .object({ title: i18n, slug: text(200), level: z.enum(["basic", "advanced"]), language: z.enum(COURSE_LANGUAGES), summary: i18n, body: i18n, type: z.enum(["e_learning", "contact"]) })
    .strict(),
  price: z.object({ price: text(40), accessMonths: text(40), videoCount: text(40), nextDiscount: i18n, priceGroup: text(40), priceIndividual: text(40), durationLabel: i18n }).strict(),
  outcomes: z.object({ outcomes: z.array(i18n).max(200, "tooMany") }).strict(),
  includes: z.object({ includes: z.array(i18n).max(200, "tooMany") }).strict(),
  protocolStages: z.object({ protocolStages: z.array(text(2_000)).max(200, "tooMany") }).strict(),
  test: z.object({ questions, passPercent: text(10), tries: text(10) }).strict(),
  certificate: z.object({ certificateSkills: z.array(text(2_000)).max(200, "tooMany"), certificateVolume: text(2_000) }).strict(),
  gallery: z.object({ images: z.array(z.object({ key: z.string().max(300, "tooLong"), alt: i18n })).max(200, "tooMany") }).strict(),
  recommendations: z.object({ recommendationIds: z.array(z.number().int().positive().max(ROW_ID_MAX)).max(200, "tooMany") }).strict(),
  badge: z.object({ badge: z.object({ label: z.object({ et: text(200), ru: text(200).optional() }), bg: z.string().max(20), fg: z.string().max(20) }).nullable() }).strict(),
  outline: OUTLINE_SCHEMA,
} satisfies { [P in CoursePart]: z.ZodType<PartValues[P]> };

const PATCHES = Object.fromEntries(COURSE_PARTS.map((part) => [part, SCHEMAS[part].partial().strict()])) as unknown as { [P in CoursePart]: z.ZodType<Partial<PartValues[P]>> };

/** A save's patch of `part` (the autosave route's schema): some of the part's fields, no other. */
export const coursePartPatch = <P extends CoursePart>(part: P): z.ZodType<Partial<PartValues[P]>> => PATCHES[part];

// ---------- the live course and the drafts over it ----------

/** The live course as the parts read it: the row (read under its lock where it is written), its images, its test row, its modules and lessons. */
type LiveCourse = { course: Course; images: CourseImage[]; test: CourseTest | null; outline: OutlineRows };

async function liveOf(q: Q, course: Course): Promise<LiveCourse> {
  const images = await q.select().from(courseImages).where(eq(courseImages.courseId, course.id)).orderBy(asc(courseImages.sort), asc(courseImages.id));
  const [test] = await q.select().from(courseTests).where(eq(courseTests.courseId, course.id)).limit(1);
  return { course, images, test: test ?? null, outline: await outlineRows(q, course.id) };
}

/** A part's live value: the editor's fields of the stored course (domain/course-editor.ts draftFromCourse); the outline's, its rows students see. */
const liveValue = <P extends CoursePart>(l: LiveCourse, part: P): PartValues[P] =>
  (part === "outline" ? liveOutline(l.outline) : partValue(part as Exclude<P, "outline">, draftFromCourse({ ...l.course, images: l.images, test: l.test }))) as PartValues[P];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b);

/**
 * A stored draft's value read defensively (jsonb holds anything): its part's fields over the live ones, through the part's schema; live when it does
 * not pass. The outline's is held to the rows as they are now (rows deleted since are left out, a flagged module keeps its row's name).
 */
function draftValueOf<P extends CoursePart>(l: LiveCourse, part: P, raw: unknown): PartValues[P] {
  const live = liveValue(l, part);
  const fields: readonly string[] = PART_FIELDS[part];
  const own = isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter(([k]) => fields.includes(k))) : {};
  const parsed = SCHEMAS[part].safeParse({ ...live, ...own });
  if (!parsed.success) return live;
  if (part === "outline") return (outlineFromDraft(l.outline, parsed.data) ?? live) as PartValues[P];
  return parsed.data as PartValues[P];
}

/** The course's live values and drafts as its editor works on them: drafts only while it is published (an unpublished course saves straight to the record). */
type CourseState = { live: LiveCourse; drafts: DraftPart[]; type: CourseType };

/** The type the cards follow: the drafted one while the basics have a draft (R-a), else the course's. */
function effectiveType(live: LiveCourse, drafts: DraftPart[]): CourseType {
  const basics = drafts.find((d) => d.part === "basics");
  return basics ? draftValueOf(live, "basics", basics.value).type : live.course.type;
}

async function stateOf(q: Q, course: Course): Promise<CourseState> {
  const live = await liveOf(q, course);
  const drafts = course.published ? await readDrafts(q, ENTITY, course.id) : [];
  return { live, drafts, type: effectiveType(live, drafts) };
}

/** A draft's version as its editor holds it (R-b, I-1): the row's id and its counter, "d:<id>.<n>": never an earlier draft's of the part. */
const draftVersion = (id: number, n: number): string => `d:${id}.${n}`;

type PartState = { liveValue: Record<string, unknown>; liveHash: string; draft: DraftPart | null; version: string; value: Record<string, unknown> };

async function partStateOf(s: CourseState, part: CoursePart): Promise<PartState> {
  const live = liveValue(s.live, part) as Record<string, unknown>;
  const liveHash = await contentVersion(live);
  const draft = s.drafts.find((d) => d.part === part) ?? null;
  if (!draft) return { liveValue: live, liveHash, draft: null, version: `l:${liveHash}`, value: live };
  return { liveValue: live, liveHash, draft, version: draftVersion(draft.id, draft.version), value: draftValueOf(s.live, part, draft.value) as Record<string, unknown> };
}

/** A part as its card reads it (the autosave route's `read`): the version (R-b) and the value; null when there is no such course (404). */
export async function readCoursePart(db: Q, courseId: number, part: CoursePart): Promise<{ version: string; value: unknown } | null> {
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
  if (!course) return null;
  const s = await partStateOf(await stateOf(db, course), part);
  return { version: s.version, value: s.value };
}

// ---------- each part's check and writer ----------

type CheckContext = { q: Q; course: Course; type: CourseType };
type PartDef<P extends CoursePart, N> = {
  /** The part's check (server/admin-content.ts): the values to store, or null; its field errors in `c`. `type`: the one it will be stored with. */
  check(ctx: CheckContext, c: Check, value: PartValues[P]): Promise<N | null> | N | null;
  /** Stores the checked values live, under the course's lock (`course`: the row as locked, before this publish's writes). */
  write(tx: Tx, course: Course, checked: N, now: Date): Promise<void>;
  /** The check's field names that are not the part's own. */
  rename?: Record<string, string>;
};
const def = <P extends CoursePart, N>(d: PartDef<P, N>) => d as unknown as PartDef<P, unknown>;
const columns = (tx: Tx, course: Course, checked: object, now: Date) => updateCourseColumns(tx, course.id, checked, now);

const PARTS: { [P in CoursePart]: PartDef<P, unknown> } = {
  basics: def({
    check: (ctx, c, v: PartValues["basics"]) => checkCourseBasics(ctx.q, c, v, ctx.course.id),
    async write(tx, course, checked, now) {
      await updateCourseColumns(tx, course.id, checked, now);
      if (checked.type !== course.type) await clearOtherCourseType(tx, course.id, checked.type, now);
    },
  }),
  price: def({ check: (ctx, c, v: PartValues["price"]) => checkCoursePrice(c, v, ctx.type), write: columns }),
  outcomes: def({ check: (_ctx, c, v: PartValues["outcomes"]) => ({ outcomes: c.list("outcomes", v.outcomes) }), write: columns }),
  includes: def({ check: (ctx, c, v: PartValues["includes"]) => ({ includes: checkCourseIncludes(c, v.includes, ctx.type) }), write: columns }),
  protocolStages: def({ check: (_ctx, c, v: PartValues["protocolStages"]) => ({ protocolStages: checkCourseStages(c, v.protocolStages) }), write: columns }),
  test: def({
    check(ctx, c, v: PartValues["test"]) {
      const checked = checkCourseTest(c, v, ctx.type);
      return checked === "duplicateId" ? null : { test: checked.test }; // (the schema refuses an id twice before)
    },
    write: (tx, course, checked, now) => writeCourseTest(tx, course.id, checked.test, now),
    rename: { test: "questions", testPassPercent: "passPercent", testTries: "tries" },
  }),
  certificate: def({ check: (ctx, c, v: PartValues["certificate"]) => checkCourseCertificate(c, v, ctx.type), write: columns }),
  gallery: def({ check: (_ctx, c, v: PartValues["gallery"]) => checkCourseGallery(c, v.images), write: (tx, course, checked, now) => writeCourseImages(tx, course.id, checked, now) }),
  recommendations: def({
    check: async (ctx, c, v: PartValues["recommendations"]) => ({ recommendationIds: await checkCourseRecommendations(ctx.q, c, v.recommendationIds, ctx.course.id) }),
    write: columns,
  }),
  badge: def({ check: (_ctx, c, v: PartValues["badge"]) => ({ badge: checkCourseBadge(c, v.badge) }), write: columns }),
  // the modules and lessons (B18): the course's own rows once each, their names and texts as the card's forms check them; written to the rows at
  // the publish, and (R-e) no row of the course flagged any more. Never saved whole (writeCoursePart): its draft is the rows' changes'
  // (server/course-outline.ts storeLayout)
  outline: def({
    check: (ctx, c, v: PartValues["outline"]) => checkOutline(ctx.q, ctx.course.id, c, v),
    write: async (tx, course, checked) => void (await publishOutline(tx, course.id, checked)),
  }),
};

/**
 * A refusal's fields, named as the part names them. The screen holds back the fields a refusal names among those it sent: when none of them is named
 * (the error is in a field the save made wrong without carrying it, e.g. the slug made from a new title), every field sent is named with it too.
 */
function refusedFields(part: CoursePart, errors: Record<string, string>, patch: Record<string, unknown>): Record<string, string> {
  const rename = PARTS[part].rename ?? {};
  const out: Record<string, string> = {};
  for (const [name, code] of Object.entries(errors)) out[rename[name] ?? name] ??= code;
  const sent = Object.keys(patch);
  if (!Object.keys(out).some((n) => sent.includes(n))) {
    const code = Object.values(out)[0] ?? "invalid";
    for (const n of sent) out[n] ??= code;
  }
  return out;
}

/**
 * A card's save (the autosave route's `write`): `patch` (some of the part's fields; any other is not read) over the part's value at `version`, under
 * the course's lock. The answers (server/autosave-route.ts): ok with the part's version after it; a conflict with the stored version and value (another
 * tab, a publish or a discard meanwhile; a course deleted meanwhile: version "", value null); invalid with the part's field codes (the old editor's
 * checks, per part). A published course's save is its draft (the price may wait in it: the rule of a published course's price is checked at publish);
 * an unpublished course's is written live at once. A save that changes nothing answers the current version and writes nothing. The outline is
 * never saved whole: invalid `modules`, always (Task 5 review I-1).
 */
export async function writeCoursePart(
  db: Db,
  courseId: number,
  part: CoursePart,
  patch: Record<string, unknown>,
  version: string,
  admin: { email: string },
  now: Date,
): Promise<SaveAnswer> {
  // the outline is published and discarded as a part, but no editor saves it whole (Task 5 review I-1, M-2): a row's text has its own autosave
  // (server/admin-lessons.ts writeOutlineText, its "t:" version), and the moves and deletes are the card's actions
  if (part === "outline") return { ok: false, error: "invalid", fields: { modules: "invalid" } };
  const savedAt = now.toISOString();
  return db.transaction(async (tx): Promise<SaveAnswer> => {
    const course = await lockCourse(tx, courseId);
    if (!course) return { ok: false, error: "conflict", version: "", value: null };
    const s = await stateOf(tx, course);
    const current = await partStateOf(s, part);
    if (version !== current.version) return { ok: false, error: "conflict", version: current.version, value: current.value };
    const fields: readonly string[] = PART_FIELDS[part];
    const own = Object.fromEntries(Object.entries(patch).filter(([k]) => fields.includes(k)));
    const parsed = SCHEMAS[part].safeParse({ ...current.value, ...own });
    // (an issue that names no field: none named, so every field sent is, refusedFields)
    if (!parsed.success) return { ok: false, error: "invalid", fields: refusedFields(part, fieldCodes(parsed.error.issues) ?? {}, own) };
    const value = parsed.data as Record<string, unknown>;
    if (same(value, current.value)) return { ok: true, version: current.version, savedAt };
    const c = new Check();
    const type = part === "basics" ? (value as PartValues["basics"]).type : s.type;
    const checked = await PARTS[part].check({ q: tx, course, type }, c, value as never);
    if (!c.ok || checked === null) return { ok: false, error: "invalid", fields: refusedFields(part, c.errors, own) };
    if (course.published) {
      if (same(value, current.liveValue)) {
        // typed back to what is live: no change is left to publish
        if (current.draft) await dropDraftPart(tx, ENTITY, courseId, part);
        return { ok: true, version: `l:${current.liveHash}`, savedAt };
      }
      const saved = await saveDraftPart(tx, { entity: ENTITY, entityId: courseId, part, value, baseVersion: current.liveHash, version: current.draft?.version ?? null, by: admin.email });
      if (saved.ok) {
        // a draft just made: its row's id (read under the same lock)
        const rowId = current.draft?.id ?? (await readDrafts(tx, ENTITY, courseId)).find((d) => d.part === part)?.id;
        if (rowId !== undefined) return { ok: true, version: draftVersion(rowId, saved.version), savedAt };
      }
      // (under the course's lock nothing saves the draft between the read and the write: answered as any conflict)
      const stored = await partStateOf(await stateOf(tx, course), part);
      return { ok: false, error: "conflict", version: stored.version, value: stored.value };
    }
    await PARTS[part].write(tx, course, checked, now);
    const [after] = await tx.select().from(courses).where(eq(courses.id, courseId));
    return { ok: true, version: `l:${await contentVersion(liveValue(await liveOf(tx, after), part))}`, savedAt };
  });
}

// ---------- what is unpublished ----------

/**
 * A part's changes as the PublishBar names them: the changed fields' labels (P-3), the price's of the type it is stored with; the outline's modules
 * (course-outline.ts outlineLabels: `Moodul {nn}`, `Moodulite järjekord`, a contact course's `Programm`); its card's title when none differs.
 * `value`: the part's draft value (null for the outline: no draft, only flagged rows).
 */
function labelsOf(l: LiveCourse, part: CoursePart, value: unknown, type: CourseType): string[] {
  let labels: string[];
  if (part === "outline") labels = outlineLabels(l.outline, value as PartValues["outline"] | null, type === "contact");
  else {
    let changed = changedFields(part, value, liveValue(l, part));
    if (part === "price") {
      const own: readonly string[] = TYPE_PRICE_FIELDS[type];
      changed = Object.fromEntries(Object.entries(changed).filter(([f]) => own.includes(f)));
    }
    labels = partLabels(part, changed);
  }
  return labels.length > 0 ? labels : [type === "contact" && part === "outline" ? adminEt.courseEditor.sections.modulesC : partTitle(part)];
}

function changesOf(live: LiveCourse, drafts: DraftPart[]): { part: CoursePart; labels: string[] }[] {
  const type = effectiveType(live, drafts);
  return COURSE_PARTS.flatMap((part) => {
    const draft = drafts.find((d) => d.part === part);
    // the modules and lessons also wait with no draft: a flagged row is a change to publish (R-e, review M-5)
    if (part === "outline" && !draft) {
      const labels = outlineLabels(live.outline, null, type === "contact");
      return labels.length > 0 ? [{ part, labels }] : [];
    }
    if (!draft) return [];
    return [{ part, labels: labelsOf(live, part, draftValueOf(live, part, draft.value), type) }];
  });
}

/**
 * The PublishBar's list (`changed`: the labels, flattened): each drafted part with its changed fields' labels, in screen order, and the outline also
 * while only flagged rows wait (R-e). None for an unpublished course (it has no drafts: its saves are live).
 */
export async function courseChanges(db: Q, courseId: number): Promise<{ part: string; labels: string[] }[]> {
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
  if (!course || !course.published) return [];
  const s = await stateOf(db, course);
  return changesOf(s.live, s.drafts);
}

// ---------- „Avalda muudatused“ ----------

/**
 * A part „Avalda muudatused“ left in its draft (S3-P3-b): "changed", its live value changed after the draft began (or something it needs did: its
 * slug was taken, its type was locked meanwhile), `fields` the labels of its changes; "missing", a published course would lose its price, `fields`
 * the missing fields' labels in lowercase (`Puudub: hind`).
 */
export type BlockedPart = { part: string; reason: "changed" | "missing"; fields: string[] };
export type PublishResult = { published: string[]; blocked: BlockedPart[] };

/** The course is not there (deleted meanwhile): nothing to publish. */
class CourseGone extends Error {}
/** The „Avaldatud“ switch is refused: a part could not be published. */
class SwitchRefused extends Error {
  constructor(readonly blocked: string[]) {
    super("blocked");
  }
}

/**
 * The course's Publisher with what it decided (R-c). `priceRule`: whether a published course's price is required ("published": when the course is
 * published; false: switching it off, R-d).
 * - lock: lockCourse, then the live course read under it (every part's live version comes from it);
 * - hold: every current part checked again with the type the publish ends with (the basics' draft's when it is published), as the old editor's
 *   save does; a part that fails is held as changed (its slug was taken, its type locked meanwhile), and the others are checked again without it,
 *   until they all pass; then a published course must keep its price: a price part that would leave it without one is held as missing, else the
 *   basics whose type change would;
 * - write: each part's checked values, with that type (a type change empties the other type's fields, whichever part is written first).
 */
function makeCoursePublisher(courseId: number, o: { now: Date; priceRule: "published" | false }) {
  let live: LiveCourse | null = null;
  const checked = new Map<string, unknown>();
  const held = new Map<string, Omit<BlockedPart, "part">>();
  const known = (): LiveCourse => {
    if (!live) throw new CourseGone();
    return live;
  };
  const publisher: Publisher = {
    async lock(tx) {
      const course = await lockCourse(tx, courseId);
      if (!course) throw new CourseGone();
      live = await liveOf(tx, course);
    },
    // (a part this code does not know never matches: it stays a draft)
    liveVersion: async (_tx, part) => (isCoursePart(part) ? contentVersion(liveValue(known(), part)) : ""),
    async hold(tx, parts) {
      const l = known();
      const set = new Map<CoursePart, unknown>();
      for (const p of parts) if (isCoursePart(p.part)) set.set(p.part, draftValueOf(l, p.part, p.value));
      const priceRule = o.priceRule === "published" && l.course.published;
      for (;;) {
        const basics = set.get("basics") as PartValues["basics"] | undefined;
        const type = basics ? basics.type : l.course.type;
        let failed: CoursePart | null = null;
        for (const [part, value] of set) {
          const c = new Check();
          const n = await PARTS[part].check({ q: tx, course: l.course, type }, c, value as never);
          if (!c.ok || n === null) {
            failed = part;
            break;
          }
          checked.set(part, n);
        }
        if (failed) {
          held.set(failed, { reason: "changed", fields: labelsOf(l, failed, set.get(failed), type) });
          set.delete(failed);
          continue;
        }
        // the price is taken away only by the price part, or by a type change (the other type's price fields are emptied): a basics draft that
        // keeps the type publishes on a course whose price is missing already (review M-1), as the other parts do
        const typeChange = basics !== undefined && basics.type !== l.course.type;
        if (priceRule && (set.has("price") || typeChange)) {
          const c = new Check();
          checkCoursePriceRequired(c, set.has("price") ? (checked.get("price") as PriceFields) : l.course, type);
          if (!c.ok) {
            const culprit: CoursePart = set.has("price") ? "price" : "basics";
            held.set(culprit, { reason: "missing", fields: [PRICE_MISSING] });
            set.delete(culprit);
            continue;
          }
        }
        return [...held.keys()];
      }
    },
    async write(tx, part) {
      const l = known();
      if (!isCoursePart(part) || !checked.has(part)) throw new Error(`[course-parts] ${part} was not checked before its write`);
      await PARTS[part].write(tx, l.course, checked.get(part), o.now);
    },
    revalidate: () => revalidatePublic({ kind: "courses" }),
  };
  return { publisher, held };
}

/**
 * The course's Publisher (R-c) for the draft layer's publishDrafts: lockCourse first, the parts' checks at publish, `{ kind: "courses" }` revalidated
 * after the commit. It publishes the drafts only: the flagged rows of a course whose outline has no draft are publishCourse's (publishIn).
 */
export const coursePublisher = (courseId: number): Publisher => makeCoursePublisher(courseId, { now: new Date(), priceRule: "published" }).publisher;

/** The blocked parts with their reasons: the held ones as decided, the others changed meanwhile, with their changes' labels (read after the publish). */
async function blockedOf(db: Q, courseId: number, names: string[], held: Map<string, Omit<BlockedPart, "part">>): Promise<BlockedPart[]> {
  if (names.length === 0) return [];
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
  const labels = course ? new Map(changesOf(await liveOf(db, course), await readDrafts(db, ENTITY, courseId)).map((c) => [c.part as string, c.labels])) : new Map<string, string[]>();
  return names.map((part) => ({ part, ...(held.get(part) ?? { reason: "changed" as const, fields: labels.get(part) ?? [] }) }));
}

/**
 * The publish's work inside a caller's transaction (publishDraftsIn with the course's Publisher), and then the modules and lessons flagged
 * `unpublished` (R-e): when the outline had no draft (none published, none blocked), the flags are cleared in live's own order with the flagged rows
 * at their places (review M-5: also with no draft at all), and the outline counts as published. A blocked outline keeps its rows flagged: the
 * draft's order is what places them.
 */
async function publishIn(tx: Tx, courseId: number, publisher: Publisher): Promise<{ published: string[]; blocked: string[] }> {
  const result = await publishDraftsIn(tx, ENTITY, courseId, publisher);
  const outline: CoursePart = "outline";
  if (!result.published.includes(outline) && !result.blocked.includes(outline) && (await publishOutline(tx, courseId, null))) result.published.push(outline);
  return result;
}

/**
 * „Avalda muudatused“ (R-c): the course's drafts with its Publisher, in one transaction (publishIn): the course row's lock, the drafts', every part's
 * live version against its draft's base, the parts' checks, the writes, then the flagged rows (R-e); `{ kind: "courses" }` revalidated once after the
 * commit when anything was published (a failure there is logged: the publish stands). The parts it could not publish stay drafts and are listed
 * with why. `now`: the course's updatedAt.
 */
export async function publishCourse(db: Db, courseId: number, now: Date): Promise<PublishResult> {
  const { publisher, held } = makeCoursePublisher(courseId, { now, priceRule: "published" });
  let result: { published: string[]; blocked: string[] };
  try {
    result = await db.transaction((tx) => publishIn(tx, courseId, publisher));
  } catch (e) {
    if (e instanceof CourseGone) return { published: [], blocked: [] };
    throw e;
  }
  if (result.published.length > 0) {
    try {
      publisher.revalidate();
    } catch (e) {
      logFailure(`[course-parts] course ${courseId}: revalidating after the publish failed`, e);
    }
  }
  return { published: result.published, blocked: await blockedOf(db, courseId, result.blocked, held) };
}

// ---------- „Loobu muudatustest“ ----------

const NO_CLEANUP: LessonCleanup = { videoIds: [], fileKeys: [] };

/**
 * „Loobu muudatustest“: the course's drafts deleted (the outline's too) and, R-e, its modules and lessons flagged `unpublished` (made on the published
 * course and not published yet) with their files; live stays as it is. Under the course's lock first (the lock order). A flagged module goes only
 * once it holds no lesson (a published lesson is never deleted with it). The number of drafts and rows deleted, and the deleted lessons' Bunny videos
 * and stored files (their removed ones too) for the cleanup after the commit (the route removes them in `after()`).
 */
export async function discardCourse(db: Db, courseId: number): Promise<{ discarded: number; cleanup: LessonCleanup }> {
  return db.transaction(async (tx) => {
    if (!(await lockCourse(tx, courseId))) return { discarded: 0, cleanup: NO_CLEANUP };
    const parts = await discardDrafts(tx, ENTITY, courseId);
    const flagged = await tx
      .select({ id: lessons.id, videoId: lessons.videoId, replacedVideoId: lessons.replacedVideoId })
      .from(lessons)
      .innerJoin(courseModules, eq(lessons.moduleId, courseModules.id))
      .where(and(eq(courseModules.courseId, courseId), eq(lessons.unpublished, true)))
      .orderBy(asc(lessons.id));
    const ids = flagged.map((l) => l.id);
    const files = ids.length
      ? await tx.select({ key: lessonFiles.r2Key }).from(lessonFiles).where(inArray(lessonFiles.lessonId, ids)).orderBy(asc(lessonFiles.lessonId), asc(lessonFiles.position), asc(lessonFiles.id))
      : [];
    if (ids.length) await tx.delete(lessons).where(inArray(lessons.id, ids));
    const modules = await tx
      .delete(courseModules)
      .where(and(eq(courseModules.courseId, courseId), eq(courseModules.unpublished, true), notExists(tx.select({ one: sql`1` }).from(lessons).where(eq(lessons.moduleId, courseModules.id)))))
      .returning();
    const videoIds = flagged.flatMap((l) => [l.videoId, l.replacedVideoId]).filter((v): v is string => v !== null);
    return { discarded: parts + ids.length + modules.length, cleanup: { videoIds, fileKeys: files.map((f) => f.key) } };
  });
}

// ---------- the instant switches „Avaldatud“ (R-d) and „Näidissisu“ ----------

/** A switch's answer: done (also when it was in that state already), refused with the fields (no price) or the parts that could not be published. */
export type SwitchResult =
  | { ok: true }
  | { ok: false; error: "notFound" | "server" }
  | { ok: false; error: "invalid"; fields?: Record<string, FieldError> }
  | { ok: false; error: "blocked"; blocked: BlockedPart[] };

/** A switch as the editor sends it: `{ id, on }`; null for anything else. */
export function parseSwitch(input: unknown): { id: number; on: boolean } | null {
  const parsed = z.object({ id: z.number().int().positive().max(ROW_ID_MAX), on: z.boolean() }).strict().safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * „Avaldatud“, instant (R-d). Switched ON: today's price rule (an e-course needs its price, a contact course a group or an individual price; the field's
 * error otherwise); a module or lesson still flagged (left by an earlier way of unpublishing) is shown with the course. Switched OFF with drafts or
 * flagged rows: they are published first, in the same transaction (as „Avalda muudatused“, under the course's lock; an unpublished course needs no
 * price, so a price cleared in its draft goes too), then `published` is false; if any part is blocked, the switch is refused with them and nothing is
 * published or unpublished. `{ kind: "courses" }` is revalidated once after a change.
 */
export async function switchCoursePublished(db: Db, courseId: number, on: boolean, now: Date): Promise<SwitchResult> {
  if (on) {
    const done = await db.transaction(async (tx): Promise<SwitchResult | "changed"> => {
      const course = await lockCourse(tx, courseId);
      if (!course) return { ok: false, error: "notFound" };
      if (course.published) return { ok: true };
      const c = new Check();
      checkCoursePriceRequired(c, course, course.type);
      if (!c.ok) return { ok: false, error: "invalid", fields: c.errors };
      await publishOutline(tx, courseId, null);
      await updateCourseColumns(tx, courseId, { published: true }, now);
      return "changed";
    });
    if (done !== "changed") return done;
    revalidatePublic({ kind: "courses" });
    return { ok: true };
  }
  const { publisher, held } = makeCoursePublisher(courseId, { now, priceRule: false });
  try {
    const done = await db.transaction(async (tx): Promise<"notFound" | "same" | "changed"> => {
      const course = await lockCourse(tx, courseId);
      if (!course) return "notFound";
      if (!course.published) return "same";
      const { blocked } = await publishIn(tx, courseId, publisher);
      if (blocked.length > 0) throw new SwitchRefused(blocked); // the transaction takes the published parts back
      await updateCourseColumns(tx, courseId, { published: false }, now);
      return "changed";
    });
    if (done === "notFound") return { ok: false, error: "notFound" };
    if (done === "changed") revalidatePublic({ kind: "courses" });
    return { ok: true };
  } catch (e) {
    if (e instanceof SwitchRefused) return { ok: false, error: "blocked", blocked: await blockedOf(db, courseId, e.blocked, held) };
    if (e instanceof CourseGone) return { ok: false, error: "notFound" };
    throw e;
  }
}

/** „Näidissisu“, instant: the prototype's sample mark (admin only: no public page shows it). Under the course's lock, as every course write. */
export async function switchCourseSample(db: Db, courseId: number, on: boolean, now: Date): Promise<SwitchResult> {
  return db.transaction(async (tx): Promise<SwitchResult> => {
    const course = await lockCourse(tx, courseId);
    if (!course) return { ok: false, error: "notFound" };
    if (course.isSample !== on) await updateCourseColumns(tx, courseId, { isSample: on }, now);
    return { ok: true };
  });
}

/** Is there a course `id` (the publish and discard routes' 404)? */
export async function courseExists(db: Q, id: number): Promise<boolean> {
  const [row] = await db.select({ id: courses.id }).from(courses).where(eq(courses.id, id));
  return row !== undefined;
}

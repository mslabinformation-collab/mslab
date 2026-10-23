import { z } from "zod";
import type { Db, Q } from "@/db/client";
import { courses, type TestQuestion } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { courseUsage, typeLocked, deleteUnusedSession, getCourseForEdit, getSession, isSlugTaken, moveCourseTo, saveCourseWithImages, upsertSession, type CourseFields } from "@/db/queries/admin";
import { tallinnInstant } from "@/domain/calendar";
import { CERT_LIMITS } from "@/domain/certificate";
import { checkQuestions, checkSettings, PASS_RANGE, readQuestions, TRIES_RANGE, type QuestionProblem } from "@/domain/completion";
import { BADGE_MAX, badgeOf, COURSE_LANGUAGES, emptyTestDraft, LIMITS, swatchOf, type CourseDraft, type CourseType, type DraftImage, type TestDraft } from "@/domain/course-editor";
import { checkStages } from "@/domain/protocols";
import type { I18n } from "@/i18n/field";
import { isSlug, SLUG_MAX, slugify } from "@/lib/slug";
import { toStorable } from "@/lib/to-storable";
import { Check, field, invalid, isStorableImageKey, type EditResult, type FieldError, type FieldPlace } from "./edit-check";

// The content editors' form handling (courses, calendar sessions). Callers have already checked the admin session
// (server/actions/admin-content.ts wraps each in adminAction); these take a Db and run without Next.js
// (tests/db/admin-content.test.ts). Nothing the browser sends is trusted: the draft is parsed and every field checked
// again here.

export type { EditResult, FieldError } from "./edit-check";
export { isStorableImageKey } from "./edit-check";

const ID_MAX = 2_147_483_647;
const id = z.coerce.number().int().positive().max(ID_MAX);
/** The JSON draft is at most this long (a course with 40-row lists in two languages is far below it). */
const DRAFT_MAX = 400_000;

/** The question list's problems (domain/completion.ts checkQuestions) as the field errors the editor shows under "Teadmiste test". */
const TEST_ERRORS: Record<Exclude<QuestionProblem["error"], "duplicateId">, FieldError> = {
  tooMany: "testTooMany",
  empty: "testEmpty",
  tooLong: "testTooLong",
  options: "testOptions",
  noCorrect: "testNoCorrect",
};

/** Where a question problem is, for the editor (EditResult.at): the question (-1: the list as a whole), and the option when it names one. */
const placeOf = (p: QuestionProblem): FieldPlace => ("option" in p && p.option !== undefined ? { index: p.index, option: p.option } : { index: p.index });

/** A pasted one-line text Postgres can store: control characters and broken surrogates go (toStorable), Word's line or page break is a space. */
const heading = (s: string) => toStorable(s).replace(/[\r\n]+/g, " ");

const i18n = z.object({ et: z.string().max(20_000), ru: z.string().max(20_000).optional() });
const draftSchema = z.object({
  id: z.number().int().positive().max(ID_MAX).nullable(),
  version: z.string().max(40).nullable(),
  type: z.enum(["e_learning", "contact"]),
  level: z.enum(["basic", "advanced"]),
  slug: z.string().max(200),
  language: z.enum(COURSE_LANGUAGES),
  title: i18n,
  summary: i18n,
  body: i18n,
  outcomes: z.array(i18n).max(200),
  includes: z.array(i18n).max(200),
  // loose: the real limits are checkStages', with a field error; the default: an editor page loaded before the deploy posts no headings, and its save must not fail on them
  protocolStages: z.array(z.string().max(2000)).max(200).default([]),
  // "Teadmiste test" (e-course completion, R1): loose here — the questions are typed as the draft's but read defensively (readQuestions) and checked
  // after (checkQuestions, the settings), with field errors; the default: an editor page loaded before the deploy posts no test
  test: z
    .object({ questions: z.array(z.custom<TestQuestion>()).max(200), passPercent: z.string().max(10), tries: z.string().max(10) })
    .default(emptyTestDraft),
  // "Tunnistus" (phase 3d): loose here, the real limits after (with field errors); the defaults: an editor page loaded before the deploy posts neither
  certificateSkills: z.array(z.string().max(2000)).max(200).default([]),
  certificateVolume: z.string().max(2000).default(""),
  price: z.string().max(40),
  priceGroup: z.string().max(40),
  priceIndividual: z.string().max(40),
  accessMonths: z.string().max(40),
  videoCount: z.string().max(40),
  durationLabel: i18n,
  nextDiscount: i18n,
  badge: z.object({ label: z.object({ et: z.string().max(200), ru: z.string().max(200).optional() }), bg: z.string().max(20), fg: z.string().max(20) }).nullable(),
  images: z.array(z.object({ key: z.string().max(300), alt: i18n })).max(200),
  recommendationIds: z.array(z.number().int().positive().max(ID_MAX)).max(200),
  published: z.boolean(),
  isSample: z.boolean(),
}) satisfies z.ZodType<CourseDraft>;

// ---------- the course's checks, one per part (admin UX pass piece 3a: the old editor's save runs them all, a part's autosave and its publish
// run its own; server/course-parts.ts). Each takes the editor's values (CourseDraft's fields: text as typed), collects its field errors in `c`
// and returns the values to store; `type` is the type the values will be stored with. ----------

/** "Põhiinfo" with the type (course part `basics`). */
export type BasicsInput = Pick<CourseDraft, "type" | "level" | "slug" | "language" | "title" | "summary" | "body">;
export type BasicsFields = Pick<CourseFields, "type" | "level" | "slug" | "language" | "title" | "summary" | "body">;

/**
 * The basics: a title (required), the summary and the long text, and the slug: typed, or made from the Estonian title; never one another course
 * has. A course with sessions or registrations keeps its type: an e-learning course with dated sessions would put them in the public calendar
 * (K1/K2), and the sessions could no longer be edited under a contact course. An e-course with lessons or anyone's access keeps its type too: its
 * lessons and its students' access belong to an e-course (db/queries/admin.ts typeLocked). `id`: the course's (null: a new one). Null when the title
 * is refused.
 */
export async function checkCourseBasics(q: Q, c: Check, d: BasicsInput, id: number | null): Promise<BasicsFields | null> {
  if (id != null) {
    const usage = await courseUsage(q, id);
    if (usage && usage.type !== d.type && typeLocked(usage)) c.fail("type", "typeLocked");
  }
  const title = c.text("title", d.title, LIMITS.title, { required: true });
  const summary = c.text("summary", d.summary, LIMITS.summary) ?? { et: "" };
  const body = c.text("body", d.body, LIMITS.body) ?? { et: "" };
  const typed = d.slug.trim().toLowerCase();
  const slug = typed || slugify(d.title.et.trim()).slice(0, SLUG_MAX).replace(/-+$/, "");
  if (!isSlug(slug)) c.fail("slug", typed || d.title.et.trim() ? "slugFormat" : "required");
  else if (await isSlugTaken(q, slug, id ?? undefined)) c.fail("slug", "slugTaken");
  return title ? { type: d.type, level: d.level, language: d.language, slug, title, summary, body } : null;
}

/** "Õppevorm ja hind" without the type (course part `price`). */
export type PriceInput = Pick<CourseDraft, "price" | "accessMonths" | "videoCount" | "nextDiscount" | "priceGroup" | "priceIndividual" | "durationLabel">;
export type PriceFields = Pick<CourseFields, "price" | "accessMonths" | "videoCount" | "nextDiscount" | "priceGroup" | "priceIndividual" | "durationLabel">;

/** The type's own price fields; the other type's are null (stored empty). */
export function checkCoursePrice(c: Check, d: PriceInput, type: CourseType): PriceFields {
  const online = type === "e_learning";
  return {
    price: online ? c.amount("price", d.price) : null,
    accessMonths: online ? c.whole("accessMonths", d.accessMonths, 1, LIMITS.accessMonths) : null,
    videoCount: online ? c.whole("videoCount", d.videoCount, 0, LIMITS.videoCount) : null,
    nextDiscount: online ? c.text("nextDiscount", d.nextDiscount, LIMITS.discount) : null,
    priceGroup: online ? null : c.amount("priceGroup", d.priceGroup),
    priceIndividual: online ? null : c.amount("priceIndividual", d.priceIndividual),
    durationLabel: online ? null : c.text("durationLabel", d.durationLabel, LIMITS.duration),
  };
}

/** A published course must be buyable / bookable: an e-course its price, a contact course a group or an individual price (a field's own error first). */
export function checkCoursePriceRequired(c: Check, p: Pick<PriceFields, "price" | "priceGroup" | "priceIndividual">, type: CourseType): void {
  if (type === "e_learning") {
    if (p.price == null && !c.errors.price) c.fail("price", "priceRequired");
  } else if (p.priceGroup == null && p.priceIndividual == null && !c.errors.priceGroup && !c.errors.priceIndividual) c.fail("priceGroup", "priceRequired");
}

/** „Koolitus sisaldab“: a contact course's (an e-course stores none). */
export const checkCourseIncludes = (c: Check, includes: I18n[], type: CourseType): I18n[] => (type === "e_learning" ? [] : c.list("includes", includes));

/**
 * "Protokolli punktid": a contact course's headings (phase protocols), an e-course's practical points (e-course completion, spec §5.1); trimmed,
 * no blank rows, at most 30 of at most 120 characters. A pasted heading is cleaned first (toStorable: control characters and broken surrogates go):
 * Postgres refuses NUL in jsonb, and checkStages does not look; a heading is one line (its field is an input, which would drop a line break), so
 * Word's line or page break in it is a space between the words.
 */
export function checkCourseStages(c: Check, protocolStages: string[]): string[] {
  const stages = checkStages(protocolStages.map(heading));
  if (stages.ok) return stages.stages;
  c.fail("protocolStages", stages.error);
  return [];
}

/**
 * "Teadmiste test" (e-course completion, spec §3.1, §5.1, R1): an e-course's questions, pass mark and tries (a contact course has none: null). A
 * pasted question is cleaned as a heading is; its text may keep its lines (a text box), an option is one line (an input). A problem names the
 * question (and the option) it is in (`at`), so the editor shows it there. The pass mark is 1–100 and the tries 1–10, whole numbers, never blank.
 * "duplicateId": an id twice, never from the editor (newItemId): not a draft it made.
 */
export function checkCourseTest(c: Check, d: TestDraft, type: CourseType): { test: CourseFields["test"]; at?: FieldPlace } | "duplicateId" {
  if (type !== "e_learning") return { test: null };
  let test: CourseFields["test"] = null;
  let at: FieldPlace | undefined;
  const clean = (q: TestQuestion): TestQuestion =>
    q.kind === "open" ? { ...q, text: toStorable(q.text) } : { ...q, text: toStorable(q.text), options: q.options.map((o) => ({ ...o, text: heading(o.text) })) };
  const checked = checkQuestions(readQuestions(d.questions).map(clean));
  if (!checked.ok) {
    const { error } = checked.problem;
    if (error === "duplicateId") return "duplicateId";
    c.fail("test", TEST_ERRORS[error]);
    at = placeOf(checked.problem);
  }
  const passPercent = c.whole("testPassPercent", d.passPercent, PASS_RANGE.min, PASS_RANGE.max) ?? c.fail("testPassPercent", "whole");
  const tries = c.whole("testTries", d.tries, TRIES_RANGE.min, TRIES_RANGE.max) ?? c.fail("testTries", "whole");
  if (passPercent !== null && tries !== null) {
    const settings = checkSettings(passPercent, tries);
    if (!settings.ok) c.fail(settings.error === "pass" ? "testPassPercent" : "testTries", "whole");
    else if (checked.ok) test = { questions: checked.questions, passPercent, tries };
  }
  return { test, at };
}

/**
 * "Tunnistus" (phase 3d, spec §6): an e-course's certificate lines and volume, each cleaned as a heading is (one line), trimmed, blank lines
 * dropped; at most 16 lines of at most 120 characters, the volume at most 80. A contact course has no certificate: it stores none.
 */
export function checkCourseCertificate(
  c: Check,
  d: Pick<CourseDraft, "certificateSkills" | "certificateVolume">,
  type: CourseType,
): Pick<CourseFields, "certificateSkills" | "certificateVolume"> {
  if (type !== "e_learning") return { certificateSkills: [], certificateVolume: "" };
  let certificateSkills: string[] = [];
  const lines = d.certificateSkills.map((s) => heading(s).trim()).filter(Boolean);
  if (lines.length > CERT_LIMITS.skills) c.fail("certificateSkills", "tooMany");
  else if (lines.some((s) => s.length > CERT_LIMITS.skill)) c.fail("certificateSkills", "tooLong");
  else certificateSkills = lines;
  return { certificateSkills, certificateVolume: c.plain("certificateVolume", heading(d.certificateVolume), CERT_LIMITS.volume) };
}

/** The badge: one of D's swatches and at most 18 characters (each language), or none; the Russian text is optional. */
export function checkCourseBadge(c: Check, d: CourseDraft["badge"]): CourseFields["badge"] {
  if (!d || !d.label.et.trim()) return null;
  const swatch = swatchOf(d);
  if (!swatch) return c.fail("badge", "badge");
  if (d.label.et.trim().length > BADGE_MAX || (d.label.ru ?? "").trim().length > BADGE_MAX) return c.fail("badge", "tooLong");
  return badgeOf(d.label, swatch);
}

/** The gallery: uploads (img/<uuid>.<ext>) and the seed's static photos only, never an outside address. */
export function checkCourseGallery(c: Check, d: DraftImage[]): { key: string; alt: I18n | null }[] {
  const images: { key: string; alt: I18n | null }[] = [];
  if (d.length > LIMITS.images) c.fail("images", "tooMany");
  for (const img of d.slice(0, LIMITS.images)) {
    if (!isStorableImageKey(img.key)) {
      c.fail("images", "image");
      break;
    }
    images.push({ key: img.key, alt: c.text("images", img.alt, LIMITS.alt) });
  }
  return images;
}

/** The recommendations: other existing courses, each once, at most 3, in the chosen order (`self`: the course's own id, never recommended). */
export async function checkCourseRecommendations(q: Q, c: Check, ids: number[], self: number | null): Promise<number[]> {
  const wanted = [...new Set(ids)].filter((x) => x !== self);
  if (wanted.length > LIMITS.recommendations) c.fail("recommendationIds", "tooMany");
  const existing = wanted.length ? new Set((await q.select({ id: courses.id }).from(courses).where(inArray(courses.id, wanted))).map((r) => r.id)) : new Set<number>();
  return wanted.filter((x) => existing.has(x)).slice(0, LIMITS.recommendations);
}

/**
 * The course editor's save. Field `data`: the editor's draft as JSON (CourseDraft). Only the chosen type's own fields
 * are stored; the other type's are emptied (a course is e-learning or contact, never both). "Protokolli punktid" are
 * both types': a contact course's protocol headings, an e-course's practical points. "Teadmiste test" is an e-course's
 * (course_tests, R1); a contact course's row is deleted. So is "Tunnistus" (phase 3d): a contact course stores no lines and no
 * volume. A new course (id null) is created after the others; an existing one is refused as `stale` when it was saved elsewhere
 * since `version`. The checks are the parts' above, all of them.
 */
export async function saveCourseForm(db: Db, formData: FormData): Promise<EditResult> {
  const raw = field(formData, "data");
  if (!raw || raw.length > DRAFT_MAX) return { ok: false, error: "invalid" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid" };
  }
  const parsed = draftSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const d = parsed.data;
  const expected = d.version ? new Date(d.version) : null;
  if (d.id != null && (!expected || Number.isNaN(expected.getTime()))) return { ok: false, error: "invalid" };

  const c = new Check();
  const basics = await checkCourseBasics(db, c, d, d.id);
  const outcomes = c.list("outcomes", d.outcomes);
  const price = checkCoursePrice(c, d, d.type);
  const includes = checkCourseIncludes(c, d.includes, d.type);
  const protocolStages = checkCourseStages(c, d.protocolStages);
  const test = checkCourseTest(c, d.test, d.type);
  if (test === "duplicateId") return { ok: false, error: "invalid" };
  const certificate = checkCourseCertificate(c, d, d.type);
  if (d.published) checkCoursePriceRequired(c, price, d.type);
  const badge = checkCourseBadge(c, d.badge);
  const images = checkCourseGallery(c, d.images);
  const recommendationIds = await checkCourseRecommendations(db, c, d.recommendationIds, d.id);

  if (!c.ok || !basics) return invalid(c.errors, test.at);

  const fields: CourseFields = {
    ...basics,
    outcomes,
    includes,
    protocolStages,
    ...price,
    badge,
    recommendationIds,
    published: d.published,
    isSample: d.isSample,
    test: test.test,
    ...certificate,
  };
  const saved = await saveCourseWithImages(db, { id: d.id, expected: expected ?? undefined }, fields, images);
  if (saved === "notFound" || saved === "stale") return { ok: false, error: saved };
  return { ok: true, id: saved.id, created: d.id == null };
}

/** The course list's move: `{ id, index }`, the course and the place (0 is the first) it goes to; ↑ / ↓ send the neighbour's place, a drop its own. */
const moveRequest = z.object({ id: z.number().int().positive().max(ID_MAX), index: z.number().int().min(0).max(ID_MAX) });

/** Course list, a drag, ↑ / ↓ or the phone's „↕“ menu: one `moveCourseTo`. Nothing the browser sends is trusted (an index past the end is fine, it goes last). */
export async function moveCourseRequest(db: Db, input: unknown): Promise<EditResult> {
  const request = moveRequest.safeParse(input);
  if (!request.success) return { ok: false, error: "invalid" };
  return (await moveCourseTo(db, request.data.id, request.data.index)) === "ok" ? { ok: true, id: request.data.id } : { ok: false, error: "notFound" };
}

// ---------- calendar ----------

const SESSION_STATUS = z.enum(["scheduled", "cancelled"]);

/**
 * The session form: id (empty for a new one), courseId (a contact course), date (YYYY-MM-DD) and time (HH:MM) in
 * Estonian time, city, venue, language (ET | RU | ET / RU), capacity (1–99), status (scheduled | cancelled).
 */
export async function saveSessionForm(db: Db, formData: FormData): Promise<EditResult> {
  const rawId = field(formData, "id") ?? "";
  const sessionId = rawId === "" ? null : id.safeParse(rawId);
  if (sessionId && !sessionId.success) return { ok: false, error: "invalid" };
  const c = new Check();

  const courseId = id.safeParse(field(formData, "courseId"));
  const course = courseId.success ? await getCourseForEdit(db, courseId.data) : null;
  if (!course || course.type !== "contact") c.fail("courseId", "course");

  const date = (field(formData, "date") ?? "").trim();
  const time = (field(formData, "time") ?? "").trim();
  if (!date) c.fail("date", "required");
  else if (!tallinnInstant(date, "12:00")) c.fail("date", "date");
  if (!time) c.fail("time", "required");
  else if (!tallinnInstant("2026-01-01", time)) c.fail("time", "time");
  const startsAt = tallinnInstant(date, time);

  const city = (field(formData, "city") ?? "").trim();
  if (!city) c.fail("city", "required");
  else if (city.length > 60) c.fail("city", "tooLong");
  const venue = (field(formData, "venue") ?? "").trim();
  if (venue.length > 120) c.fail("venue", "tooLong");
  const language = z.enum(COURSE_LANGUAGES).safeParse(field(formData, "language"));
  if (!language.success) c.fail("language", "required");
  const capacityText = (field(formData, "capacity") ?? "").trim();
  const capacity = /^\d{1,2}$/.test(capacityText) ? Number(capacityText) : NaN;
  if (!(capacity >= 1 && capacity <= 99)) c.fail("capacity", "capacity");
  const status = SESSION_STATUS.safeParse(field(formData, "status"));
  if (!status.success) return { ok: false, error: "invalid" };

  if (!c.ok || !course || !startsAt || !language.success) return invalid(c.errors);
  if (sessionId && !(await getSession(db, sessionId.data))) return { ok: false, error: "notFound" };
  const saved = await upsertSession(db, {
    ...(sessionId ? { id: sessionId.data } : {}),
    courseId: course.id,
    startsAt,
    city,
    venue,
    language: language.data,
    capacity,
    status: status.data,
  });
  return { ok: true, id: saved.id, created: !sessionId };
}

/** "Kustuta toimumine": field id. Refused (inUse) when registrations point to the session. */
export async function deleteSessionForm(db: Db, formData: FormData): Promise<EditResult> {
  const session = id.safeParse(field(formData, "id"));
  if (!session.success) return { ok: false, error: "invalid" };
  const result = await deleteUnusedSession(db, session.data);
  if (result === "deleted") return { ok: true, id: session.data, deleted: true };
  return { ok: false, error: result };
}

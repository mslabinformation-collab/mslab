import type { CourseDraft, CourseType, TestDraft } from "./course-editor";
import { adminEt } from "@/i18n/dict/admin";
import type { I18n } from "@/i18n/field";
import { stableJson } from "@/lib/version";

// A course's parts on the draft layer (admin UX pass piece 3a, ruling R-a; README B2, §1.8): what the course editor's cards save one at a time,
// a published course's into its draft (`content_drafts`, entity "course"), an unpublished one's straight to the record. Each part's value is the
// editor's own fields of that card, as typed (CourseDraft's fields; the test part is CourseDraft's `test` itself). Pure, no database: the browser
// takes the part names, their fields and the PublishBar's labels from here too; the server's side is server/course-parts.ts.
//
// „Avaldatud“ and „Näidissisu“ are no part: they are instant switches (server/course-parts.ts switchCoursePublished, switchCourseSample).

/**
 * The parts (R-a), in the order the editor draws its cards (the PublishBar lists the changed fields in screen order). The modules' and lessons'
 * order and texts are a part too, `outline` (B18, Task 5), after "outcomes", where the section map draws „Moodulid ja õppetunnid“ (a contact
 * course's „Programm“).
 */
export const COURSE_PARTS = ["basics", "price", "outcomes", "outline", "includes", "protocolStages", "test", "certificate", "gallery", "recommendations", "badge"] as const;
export type CoursePart = (typeof COURSE_PARTS)[number];
/** The parts made of the course editor's own fields (CourseDraft): every one but the outline, which is the modules' and lessons' rows. */
export type EditorPart = Exclude<CoursePart, "outline">;

export const isCoursePart = (part: string): part is CoursePart => (COURSE_PARTS as readonly string[]).includes(part);

/**
 * Each part's fields, as the autosave saves them (a patch names some of them), in screen order:
 * - basics: „Põhiinfo“ and the type („Õppevorm“: in the type card, but it decides which of the other cards there are);
 * - price: the rest of „Õppevorm ja hind“, both types' fields (only the course's type's are stored; the other type's are emptied);
 * - outline: „Moodulid ja õppetunnid“ / „Programm“, the order and the texts of the modules and lessons students see (OutlineValue);
 * - test: „Teadmiste test“, the e-course's questions with their answer key, the pass mark and the tries (course_tests, never on a public course);
 * - certificate: „Tunnistus“, the e-course's certificate lines and volume;
 * - the lists and cards: their one field.
 */
export const PART_FIELDS = {
  basics: ["title", "slug", "level", "language", "summary", "body", "type"],
  price: ["price", "accessMonths", "videoCount", "nextDiscount", "priceGroup", "priceIndividual", "durationLabel"],
  outcomes: ["outcomes"],
  outline: ["modules"],
  includes: ["includes"],
  protocolStages: ["protocolStages"],
  test: ["questions", "passPercent", "tries"],
  certificate: ["certificateSkills", "certificateVolume"],
  gallery: ["images"],
  recommendations: ["recommendationIds"],
  badge: ["badge"],
} as const satisfies Record<CoursePart, readonly string[]>;

/**
 * The outline part's value (B18, R-e): the modules and lessons students see (the rows not flagged `unpublished`), in order, with their texts (a
 * lesson's short text is `{ et: "" }` when it has none). A flagged module is listed only while a live lesson is placed in it (moved there in the
 * draft), under its own row's name: a flagged row itself is never drafted (server/course-outline.ts).
 */
export type OutlineValue = { modules: { id: number; title: I18n; lessons: { id: number; title: I18n; body: I18n }[] }[] };

/** The value of each part. */
export type PartValues = {
  basics: Pick<CourseDraft, "title" | "slug" | "level" | "language" | "summary" | "body" | "type">;
  price: Pick<CourseDraft, "price" | "accessMonths" | "videoCount" | "nextDiscount" | "priceGroup" | "priceIndividual" | "durationLabel">;
  outcomes: Pick<CourseDraft, "outcomes">;
  outline: OutlineValue;
  includes: Pick<CourseDraft, "includes">;
  protocolStages: Pick<CourseDraft, "protocolStages">;
  test: TestDraft;
  certificate: Pick<CourseDraft, "certificateSkills" | "certificateVolume">;
  gallery: Pick<CourseDraft, "images">;
  recommendations: Pick<CourseDraft, "recommendationIds">;
  badge: Pick<CourseDraft, "badge">;
};

/**
 * A card's part as the course editor starts from it (server/course-parts.ts readCourseEditor; Task 7): its version (R-b), its value (the draft's, else
 * live's) and live's value beside it, which the PublishBar's labels and the fields' „· avaldamata“ are worked out against.
 */
export type PartSeed<P extends EditorPart> = { version: string; value: PartValues[P]; live: PartValues[P] };
/** Every card's part: all the parts but the outline (the modules' and lessons' rows, which their own card reads). */
export type EditorParts = { [P in EditorPart]: PartSeed<P> };

/** A part's value out of the editor's whole draft (the test part is the draft's `test`; the outline is no field of it). */
export function partValue<P extends EditorPart>(part: P, draft: CourseDraft): PartValues[P] {
  if (part === "test") return { ...draft.test } as PartValues[P];
  const source = draft as unknown as Record<string, unknown>;
  return Object.fromEntries(PART_FIELDS[part].map((f) => [f, source[f]])) as PartValues[P];
}

/** The price fields of each type (the other type's are emptied when stored). */
export const TYPE_PRICE_FIELDS = {
  e_learning: ["price", "accessMonths", "videoCount", "nextDiscount"],
  contact: ["priceGroup", "priceIndividual", "durationLabel"],
} as const;

const fieldText = adminEt.courseEditor.fields;
const cardText = adminEt.courseEditor.sections;

/** A field's visible label without a unit in brackets (P-3): „Hind (€)“ is `Hind`, „Ligipääs (kuud)“ `Ligipääs`. */
const bare = (label: string): string => label.replace(/\s*\([^()]*\)$/, "");

/** The labels of the fields the PublishBar names one by one (piece 3 texts P-3); every other part is named by its card's title. */
const FIELD_LABELS: Record<string, string> = {
  title: fieldText.title,
  slug: fieldText.slug,
  level: fieldText.level,
  language: fieldText.language,
  summary: fieldText.summary,
  body: fieldText.body,
  type: fieldText.type,
  price: bare(fieldText.price),
  accessMonths: bare(fieldText.accessMonths),
  videoCount: bare(fieldText.videoCount),
  nextDiscount: bare(fieldText.nextDiscount),
  priceGroup: bare(fieldText.priceGroup),
  priceIndividual: bare(fieldText.priceIndividual),
  durationLabel: bare(fieldText.durationLabel),
};

/** Each part's card title (a list or a card is named by it, P-3; basics and price fall back to it when no field of theirs differs). */
const CARD_TITLES: Record<CoursePart, string> = {
  basics: cardText.basics,
  price: cardText.type,
  outcomes: cardText.outcomes,
  outline: adminEt.lessons.title,
  includes: cardText.includes,
  protocolStages: cardText.protocolStages,
  test: cardText.test,
  certificate: cardText.certificate,
  gallery: cardText.gallery,
  recommendations: cardText.recommendations,
  badge: adminEt.badge.title,
};

/** A part's card title. */
export const partTitle = (part: CoursePart): string => CARD_TITLES[part];

/**
 * The PublishBar's labels of a part's changes (piece 3 texts P-3; README "the changed field labels", drawn „Lühikirjeldus, Hind, Moodul 03“).
 * `value`: the changed fields of the part (changedFields): basics and price name each changed field by its visible label without a unit, in screen
 * order; a list or a card is named once by its card's title. No changed field: none.
 */
export function partLabels(part: CoursePart, value: Record<string, unknown>): string[] {
  const fields: readonly string[] = PART_FIELDS[part];
  const changed = fields.filter((f) => Object.prototype.hasOwnProperty.call(value, f));
  if (changed.length === 0) return [];
  if (part === "basics" || part === "price") return changed.map((f) => FIELD_LABELS[f]);
  return [CARD_TITLES[part]];
}

/** The fields of `value` (a part's draft) that differ from `live`, with the draft's values: what partLabels names. */
export function changedFields(part: CoursePart, value: unknown, live: unknown): Record<string, unknown> {
  const v = (value ?? {}) as Record<string, unknown>;
  const l = (live ?? {}) as Record<string, unknown>;
  return Object.fromEntries(PART_FIELDS[part].filter((f) => stableJson(v[f]) !== stableJson(l[f])).map((f) => [f, v[f]]));
}

/**
 * The PublishBar's labels of a drafted part's changes against `live` (P-3): the changed fields' labels, the price's only of the fields of `type` (the
 * type the part is stored with: the other type's are emptied); none when nothing differs. The server's courseChanges and the editor's bar both use it.
 */
export function changeLabels(part: EditorPart, value: unknown, live: unknown, type: CourseType): string[] {
  let changed = changedFields(part, value, live);
  if (part === "price") {
    const own: readonly string[] = TYPE_PRICE_FIELDS[type];
    changed = Object.fromEntries(Object.entries(changed).filter(([f]) => own.includes(f)));
  }
  return partLabels(part, changed);
}

/** The label of the price in „Puudub: {väljad}“ (S3-P3-b: the labels in lowercase): `hind`. A contact course needs a group or an individual price. */
export const PRICE_MISSING = bare(fieldText.price).toLocaleLowerCase("et");

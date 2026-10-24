import type { SectionEntry } from "@/components/admin/SectionMap";
import type { AutosaveStatus } from "@/domain/autosave";
import type { CourseType } from "@/domain/course-editor";
import { changedFields, changeLabels, COURSE_PARTS, partLabels, partTitle, type CoursePart, type EditorPart, type PartValues } from "@/domain/course-parts";
import { adminEt } from "@/i18n/dict/admin";
import type { I18n } from "@/i18n/field";
import { stableJson } from "@/lib/version";

// The course editor's pure rules (admin UX pass piece 3a, Task 7; README B2, §1.4, §1.8; piece3-texts P-3, §4): which cards a course type has and in
// what order, the section map's entries (a count, „RU puudub“ or „Kontrolli“), the PublishBar's labels worked out in the browser from each card's
// fields against live's, the one SaveStatus of the screen made of every card's, and whether a list's change is typed or instant. No React, no
// database. It runs on Maria's old iPad: no regex lookbehind (tests/unit/old-safari.test.ts lists it).

/** Each card's id on the page: the section map's links go to `#id`. */
export const CARD_ID: Record<CoursePart, string> = {
  basics: "course-basics",
  price: "course-type",
  outcomes: "course-outcomes",
  outline: "course-outline",
  includes: "course-includes",
  protocolStages: "course-stages",
  test: "course-test",
  certificate: "course-certificate",
  gallery: "course-gallery",
  recommendations: "course-recommendations",
  badge: "course-badge",
};

/**
 * The content column's cards of a course type, in screen order (README B2: only the cards this type has): an e-course has the test and the
 * certificate, a contact course „Koolitus sisaldab“; both have the modules (a contact course's are its „Programm“). The type card („Õppevorm ja
 * hind“) is the price part's, with the basics' type in it. The badge stands in the side column, with the switches.
 */
export function cardsOf(type: CourseType): CoursePart[] {
  return COURSE_PARTS.filter((part) => part !== "badge" && (type === "e_learning" ? part !== "includes" : part !== "test" && part !== "certificate"));
}

const s = adminEt.courseEditor.sections;
const f = adminEt.courseEditor.fields;

/** A card's title, as the section map lists it (the modules' card is „Programm“ for a contact course). */
export function cardTitle(part: CoursePart, type: CourseType): string {
  if (part === "outline") return type === "contact" ? s.modulesC : adminEt.lessons.title;
  return partTitle(part);
}

/** The visible name of a field, for the leave guard's notice („Muudatust „{field}“ …“): basics' and price's by their label, a list's by its card. */
export function fieldLabel(part: EditorPart, field: string): string {
  if (part === "test") return field === "passPercent" ? f.testPass : field === "tries" ? f.testTries : s.test;
  if (part === "certificate") return field === "certificateVolume" ? f.certificateVolume : f.certificateSkills;
  if (part === "price" || part === "basics") {
    const known = { title: f.title, slug: f.slug, level: f.level, language: f.language, summary: f.summary, body: f.body, type: f.type } as Record<string, string>;
    return known[field] ?? partLabels(part, { [field]: true })[0] ?? partTitle(part);
  }
  return partTitle(part);
}

const lacksRu = (v: I18n | null | undefined): boolean => Boolean(v && v.et.trim()) && !(v?.ru && v.ru.trim());

/** Does a bilingual text of the part, of the fields its card shows for `type`, have Estonian and no Russian? („RU puudub“) */
export function ruMissing<P extends EditorPart>(part: P, value: PartValues[P], type: CourseType): boolean {
  const v = value as Record<string, unknown>;
  switch (part) {
    case "basics":
      return [v.title, v.summary, v.body].some((x) => lacksRu(x as I18n));
    case "price":
      return lacksRu((type === "e_learning" ? v.nextDiscount : v.durationLabel) as I18n);
    case "outcomes":
    case "includes":
      return ((v[part] as I18n[] | undefined) ?? []).some(lacksRu);
    case "gallery":
      return ((v.images as { alt: I18n }[] | undefined) ?? []).some((img) => lacksRu(img.alt));
    default:
      return false;
  }
}

/** How many rows a card holds, for the cards that hold a list (piece3-texts §4): none for the others. */
function countOf<P extends EditorPart>(part: P, value: PartValues[P]): number | undefined {
  const v = value as Record<string, unknown>;
  const n = (x: unknown) => (Array.isArray(x) ? x.length : 0);
  switch (part) {
    case "outcomes":
      return n(v.outcomes);
    case "includes":
      return n(v.includes);
    case "protocolStages":
      return n(v.protocolStages);
    case "test":
      return n(v.questions);
    case "gallery":
      return n(v.images);
    case "recommendations":
      return n(v.recommendationIds);
    default:
      return undefined;
  }
}

export type MapPart<P extends EditorPart = EditorPart> = { value: PartValues[P]; attention: boolean };

/**
 * The section map's entries (README B2): the cards of `type` in screen order, each with its count (a list's rows; the modules' card its modules) and
 * a flag in #6b4f5c: „Kontrolli“ when the card needs a look (a field held back, a conflict, a part the publish could not publish), else „RU puudub“
 * when one of its texts has Estonian and no Russian.
 */
export function sectionsOf(type: CourseType, parts: { [P in EditorPart]: MapPart<P> }, modules: number, blocked: readonly string[] = []): SectionEntry[] {
  return cardsOf(type).map((part) => {
    const entry: SectionEntry = { id: CARD_ID[part], label: cardTitle(part, type) };
    if (part === "outline") {
      entry.count = modules;
      if (blocked.includes(part)) entry.flag = "check";
      return entry;
    }
    const p = parts[part] as MapPart;
    const count = countOf(part, p.value);
    if (count !== undefined) entry.count = count;
    if (p.attention || blocked.includes(part)) entry.flag = "check";
    else if (ruMissing(part, p.value, type)) entry.flag = "ru";
    return entry;
  });
}

/**
 * The PublishBar's labels (`changed`, P-3) of a published course, in screen order: each part whose card's fields differ from live's, named by its
 * changed fields (basics, the price of `type`) or its card's title, as the server's courseChanges names a drafted part; the modules' and lessons'
 * labels as the server gives them (`outline`). A price whose only change is the other type's fields is named by its card, as on the server.
 */
export function publishLabels(type: CourseType, parts: { [P in EditorPart]: { value: PartValues[P]; live: PartValues[P] } }, outline: readonly string[]): string[] {
  const out: string[] = [];
  for (const part of COURSE_PARTS) {
    if (part === "outline") {
      out.push(...outline);
      continue;
    }
    const { value, live } = parts[part] as { value: unknown; live: unknown };
    if (Object.keys(changedFields(part, value, live)).length === 0) continue;
    const labels = changeLabels(part, value, live, type);
    out.push(...(labels.length > 0 ? labels : [partTitle(part)]));
  }
  return out;
}

/** The one chip of the screen (README §1.4) made of every card's: what needs her first, then what is on its way; saved when all are, at the last time. */
export function combineStatus(statuses: readonly AutosaveStatus[]): AutosaveStatus {
  for (const kind of ["conflict", "gone", "signedOut"] as const) if (statuses.some((x) => x.kind === kind)) return { kind } as AutosaveStatus;
  const invalid = statuses.flatMap((x) => (x.kind === "invalid" ? x.fields : []));
  if (statuses.some((x) => x.kind === "invalid")) return { kind: "invalid", fields: invalid };
  for (const kind of ["retry", "saving", "checking", "dirty"] as const) if (statuses.some((x) => x.kind === kind)) return { kind } as AutosaveStatus;
  let at: Date | null = null;
  for (const x of statuses) if (x.kind === "saved" && x.at && (!at || x.at > at)) at = x.at;
  return { kind: "saved", at };
}

/**
 * A list's change as a card sees it: "instant" when rows were added, removed or moved (the same rows in another order), which saves now (README §1.3:
 * reorder, an added or removed row); "typed" when a row's text changed, which waits out the typing.
 */
export function listChange(before: readonly unknown[], after: readonly unknown[]): "instant" | "typed" {
  if (before.length !== after.length) return "instant";
  const key = (x: unknown) => stableJson(x);
  const a = before.map(key).sort();
  const b = after.map(key).sort();
  return a.every((x, i) => x === b[i]) ? "instant" : "typed";
}

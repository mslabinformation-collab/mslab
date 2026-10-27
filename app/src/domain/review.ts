// The student reviews' pure rules (student reviews, Task 1; spec §2 D1, D4, D5, §3): the kinds and statuses a review has, its limits, the name a
// form offers from a full name, the consent the feedback form's tick and name field must satisfy, what Maria's „Lisa arvustus“ must hold, and the
// month a review shows. No database, no React: the server, Maria's screens, the student's form and the public pages share them. It runs in the
// browser too (the feedback form, the admin form), on iOS Safari before 16.4 as well: no lookbehind here nor in what it imports
// (tests/unit/old-safari.test.ts), and no builtin newer than Safari 15.

import { formatMonthYear } from "@/i18n/format";
import { ROW_ID_MAX, parseRowId } from "@/lib/row-id";
import { toStorable } from "@/lib/to-storable";
import { tallinnInstant } from "./calendar";
import { FEEDBACK_TEXT_MAX } from "./protocols";

/** Whose words it is (§3): a graduate's answer, copied at her consent, or one Maria added from elsewhere (D4). */
export type ReviewKind = "student" | "manual";
/** Waiting for Maria, shown on the public pages, or hidden by her (D2). */
export type ReviewStatus = "pending" | "published" | "hidden";
/** Every ReviewStatus, for the checks of what comes from the browser (a decision's undo, piece 4c). */
export const REVIEW_STATUSES = ["pending", "published", "hidden"] as const satisfies readonly ReviewStatus[];

/** A review's text is the form's answer, so it has the form's limit: one constant. */
export const REVIEW_TEXT_MAX = FEEDBACK_TEXT_MAX;
/** The name shown under a review, in characters. */
export const REVIEW_NAME_MAX = 40;
/** Maria's internal source note of a manual review, in characters. */
export const REVIEW_NOTE_MAX = 500;
/** Reviews a course page shows at first (D5); the rest are behind „Näita kõiki“, up to COURSE_REVIEWS_MAX. */
export const COURSE_REVIEWS_SHOWN = 6;
export const COURSE_REVIEWS_MAX = 50;
/** Reviews the home page shows (D5). */
export const HOME_REVIEWS_MAX = 6;

/** Why a field is refused: nothing in it, more than its limit, or something that is no value of its kind. */
type FieldError = "required" | "tooLong" | "invalid";
type Checked<T> = { ok: true; value: T } | { ok: false; error: FieldError };

/**
 * The name a form offers (D1) from a full name: the first name and the initial of the last, "Kati Maria Kask" → "Kati K.", "Kati Mänd-Kask" →
 * "Kati M.". One word is shown as it is; nothing (or only white space) is "". The initial is the last word's first letter as a capital (a letter
 * with its accent, or outside the BMP, is one letter). She can change it before she sends it; checkConsent decides whether it will do.
 */
export function shownNameFrom(fullName: string): string {
  const words = fullName.normalize("NFC").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0];
  return `${words[0]} ${Array.from(words[words.length - 1])[0].toUpperCase()}.`;
}

/** A name to show: white space collapsed to single spaces and trimmed; 1 to REVIEW_NAME_MAX characters that Postgres can store. */
function cleanName(raw: unknown): Checked<string> {
  if (raw === undefined || raw === null) return { ok: false, error: "required" };
  if (typeof raw !== "string") return { ok: false, error: "invalid" };
  const name = raw.replace(/\s+/g, " ").trim();
  if (name === "") return { ok: false, error: "required" };
  if (name.length > REVIEW_NAME_MAX) return { ok: false, error: "tooLong" };
  if (toStorable(name) !== name) return { ok: false, error: "invalid" }; // (toStorable leaves alone exactly what Postgres stores)
  return { ok: true, value: name };
}

/** The feedback form's tick, checked: `consentText` (the tick with no answer to publish) or `consentName` (no name, or one over its limit). */
export type ConsentCheck = { ok: true; name: string } | { ok: false; error: "consentText" | "consentName" };

/**
 * The permission the tick gives (D1, §4), checked against the form's `recommend` answer (undefined when she left it blank) and the name she typed:
 * the answer must have text, checked first; then the name, with its white space collapsed, 1 to REVIEW_NAME_MAX characters (a longer one is
 * refused, not cut). The name returned is the collapsed one, what the review will show.
 */
export function checkConsent(recommend: string | undefined, name: unknown): ConsentCheck {
  if (typeof recommend !== "string" || recommend.trim() === "") return { ok: false, error: "consentText" };
  const shown = cleanName(name);
  return shown.ok ? { ok: true, name: shown.value } : { ok: false, error: "consentName" };
}

/** What Maria's „Lisa arvustus“ form holds (D4), as checkManualReview returns it: `writtenAt` is the day, "YYYY-MM-DD" (Estonian time). */
export type ManualReviewInput = { courseId: number; name: string; text: string; writtenAt: string; locale: "et" | "ru"; note: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const missing = (v: unknown): boolean => v === undefined || v === null || v === "";

/** A free text: trimmed, 1 to `max` characters that Postgres can store (the rules of the feedback form's own texts). */
function cleanText(raw: unknown, max: number): Checked<string> {
  if (missing(raw)) return { ok: false, error: "required" };
  if (typeof raw !== "string") return { ok: false, error: "invalid" };
  const text = raw.trim();
  if (text === "") return { ok: false, error: "required" };
  if (text.length > max) return { ok: false, error: "tooLong" };
  if (toStorable(text) !== text) return { ok: false, error: "invalid" };
  return { ok: true, value: text };
}

/** A row id, as a number or as the digits a form field holds (lib/row-id.ts parseRowId). */
function cleanCourseId(raw: unknown): Checked<number> {
  if (missing(raw)) return { ok: false, error: "required" };
  const id = typeof raw === "number" ? (Number.isInteger(raw) && raw >= 1 && raw <= ROW_ID_MAX ? raw : null) : typeof raw === "string" ? parseRowId(raw) : null;
  return id === null ? { ok: false, error: "invalid" } : { ok: true, value: id };
}

/** The earliest year of a review Maria adds: a typo like 0026 is refused, a date ahead is not. */
const FIRST_YEAR = 2000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as "YYYY-MM-DD", from FIRST_YEAR on; a future one is fine. */
function cleanDay(raw: unknown): Checked<string> {
  if (missing(raw)) return { ok: false, error: "required" };
  if (typeof raw !== "string") return { ok: false, error: "invalid" };
  const parts = DAY.exec(raw);
  if (!parts || Number(parts[1]) < FIRST_YEAR || tallinnInstant(raw, "00:00") === null) return { ok: false, error: "invalid" };
  return { ok: true, value: raw };
}

function cleanLocale(raw: unknown): Checked<"et" | "ru"> {
  if (missing(raw)) return { ok: false, error: "required" };
  return raw === "et" || raw === "ru" ? { ok: true, value: raw } : { ok: false, error: "invalid" };
}

/**
 * „Lisa arvustus“ as the admin form sends it (D4): `courseId` (a row id; whether the course exists is the server's to know), `name` (as the
 * consent's, up to REVIEW_NAME_MAX), `text` (up to REVIEW_TEXT_MAX), `writtenAt` (a real day, "YYYY-MM-DD", the future allowed), `locale` (et or ru)
 * and her `note`, „Kust see pärit on?“ (required, up to REVIEW_NOTE_MAX). Text, name and note come back trimmed. Every wrong field is named in
 * `fields` with "required", "tooLong" or "invalid"; anything but an object is `{ form: "invalid" }`. Keys it does not know are left out.
 */
export function checkManualReview(raw: unknown): { ok: true; value: ManualReviewInput } | { ok: false; fields: Record<string, string> } {
  if (!isObject(raw)) return { ok: false, fields: { form: "invalid" } };
  const checked = {
    courseId: cleanCourseId(raw.courseId),
    name: cleanName(raw.name),
    text: cleanText(raw.text, REVIEW_TEXT_MAX),
    writtenAt: cleanDay(raw.writtenAt),
    locale: cleanLocale(raw.locale),
    note: cleanText(raw.note, REVIEW_NOTE_MAX),
  };
  const { courseId, name, text, writtenAt, locale, note } = checked;
  if (courseId.ok && name.ok && text.ok && writtenAt.ok && locale.ok && note.ok) {
    return { ok: true, value: { courseId: courseId.value, name: name.value, text: text.value, writtenAt: writtenAt.value, locale: locale.value, note: note.value } };
  }
  const fields: Record<string, string> = {};
  for (const [key, result] of Object.entries(checked)) if (!result.ok) fields[key] = result.error;
  return { ok: false, fields };
}

/** "okt 2026" / "окт. 2026" (D5): the month and year a review was written, in Estonian time. */
export function reviewMonth(writtenAt: Date, locale: "et" | "ru"): string {
  return formatMonthYear(writtenAt, locale);
}

/**
 * A review card's stars on Maria's „Arvustused“ (admin UX pass piece 4c, S4-Q5 = B): from the student's „Hinne“ (0–10) of the answer the review
 * was made from, 9–10 → 5, 7–8 → 4, 5–6 → 3, 3–4 → 2, 0–2 → 1. No score — a review Maria added, an answer without one, or a number outside
 * 0–10 — is 0: no stars. Admin only: the public pages show no score of any kind.
 */
export function starsOf(score: number | null | undefined): 0 | 1 | 2 | 3 | 4 | 5 {
  if (typeof score !== "number" || !(score >= 0 && score <= 10)) return 0;
  if (score >= 9) return 5;
  if (score >= 7) return 4;
  if (score >= 5) return 3;
  if (score >= 3) return 2;
  return 1;
}

/**
 * What „Võta tagasi“ of „Avalda“ / „Peida“ sends back (admin UX pass piece 4c, R-a), as the decision answered it: the review as the press left it
 * (`status`, `updatedAt`: the undo goes through only while it still is, so a change made since — in another tab too — is never overwritten), and
 * what the press replaced (`previous`), which the undo puts back. Instants as ISO strings: the answer goes to the browser and comes back.
 */
export type DecisionExpected = { status: ReviewStatus; updatedAt: string; previous: { status: ReviewStatus; decidedAt: string | null } };

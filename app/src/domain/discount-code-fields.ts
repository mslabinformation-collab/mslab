import { addDays, CODE_MAX, DAYS_MAX, DAYS_MIN, isCode, normalizeCode, PERCENT_MAX, PERCENT_MIN, type Audience, type CodeScope, type UseMark } from "./discount-codes";
import { parseEuroCents } from "./money";

// A discount code's fields as the Sooduskoodid drawer holds them and the server checks them (F1 Task 13, spec §4.10, R16–R18). Pure: no database, no
// React. The server's checks (server/discount-code-admin.ts, under the code's lock, over the stored row merged with the patch: R16) and the drawer's own
// (its `validate`) are these, so the browser refuses what the server would. Imported by the browser (tests/unit/old-safari.test.ts), so no lookbehind.

/** The fields the drawer autosaves, in screen order. The switch „Aktiivne“ is none of them: it has its own instant action. */
export const CODE_FIELDS = ["code", "kind", "percent", "amount", "scope", "courseIds", "startsOn", "endsOn", "maxUses", "audience", "oncePerPerson", "daysAfterSignup", "note"] as const;
export type CodeField = (typeof CODE_FIELDS)[number];

/**
 * The fields as typed: the code, the value as one of two kinds (the other field stays as typed, unread), the scope with its chosen courses, the two
 * days (YYYY-MM-DD), the limit and the days after sign-up as text, who may use it, once per person, and Maria's note.
 */
export type CodeFields = {
  code: string;
  kind: "percent" | "euro";
  percent: string;
  amount: string;
  scope: CodeScope;
  courseIds: number[];
  startsOn: string;
  endsOn: string;
  maxUses: string;
  audience: Audience;
  oncePerPerson: boolean;
  daysAfterSignup: string;
  note: string;
};

/**
 * Why a field is refused (the admin dict's `fieldErrors` keys): `codeTaken` (the server's, "codeTaken:<id>" of the code that has the text) and `codeUsed`
 * (the server's: a used code's text) are decided there; `amountTooHigh` (R18, Draft) when `at.highestCents` says the euros are above every list price in
 * the scope; `date` and `tooLong` are the shared field errors' own.
 */
export type CodeFieldError =
  | "codeRequired"
  | "codeFormat"
  | "codeTaken"
  | "codeUsed"
  | "discountRange"
  | "whole"
  | "amountEuro"
  | "amountTooHigh"
  | "endBeforeStart"
  | "coursesRequired"
  | "codeDaysRange"
  | "date"
  | "tooLong";

/** The longest note (the registration's note has the same limit). */
export const CODE_NOTE_MAX = 2000;
/** The largest „Kasutuskordi kokku“ taken (a count that fits every column and no one will reach). */
export const MAX_USES_MAX = 1_000_000;

/** A new code's fields; the welcome code is a percentage on every course, for the first training, once. */
export function emptyCodeFields(welcome: boolean): CodeFields {
  return {
    code: "",
    kind: "percent",
    percent: welcome ? "10" : "",
    amount: "",
    scope: "all",
    courseIds: [],
    startsOn: "",
    endsOn: "",
    maxUses: "",
    audience: welcome ? "first" : "all",
    oncePerPerson: true,
    daysAfterSignup: "",
    note: "",
  };
}

/** The courses a ceiling is read over: id, kind and the list price the code applies to (domain/discount-codes.ts listCentsOf), null when it has none. */
export type CeilingCourse = { id: number; type: "e_learning" | "contact"; listCents: number | null };

/**
 * R18: the highest list price among the courses in a scope, in cents; null when none of them has a price (nothing to compare with: no ceiling). A
 * scope `courses` reads its chosen courses only; every price counts whether the course is published or not.
 */
export function highestListCents(scope: CodeScope, courseIds: readonly number[], courses: readonly CeilingCourse[]): number | null {
  const inScope = courses.filter(
    (c) => scope === "all" || (scope === "ecourse" && c.type === "e_learning") || (scope === "contact" && c.type === "contact") || (scope === "courses" && courseIds.includes(c.id)),
  );
  const prices = inScope.flatMap((c) => (c.listCents === null ? [] : [c.listCents]));
  return prices.length === 0 ? null : Math.max(...prices);
}

const WHOLE = /^\d{1,9}$/;

/** A day typed as YYYY-MM-DD that exists. */
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;

/** „Soodustus (%)“ as typed → the percentage, or null when it is not a whole number (`whole`) — the range is the caller's. */
export const percentOf = (text: string): number | null => (WHOLE.test(text.trim()) ? Number(text.trim()) : null);

/** The code's value in cents when it is euros: the typed amount, a positive one; else null. */
export function amountCentsOf(text: string): number | null {
  const cents = parseEuroCents(text);
  return cents !== null && cents > 0 ? cents : null;
}

/**
 * The problems of `v`, each field's first (none: {}). The whole value is checked, never a part of it (R16: the server checks the stored row merged with
 * the patch). `at.welcome`: the welcome row (it alone has „Kehtib pärast liitumist (päeva)“). `at.highestCents`: R18's ceiling — the highest list price in
 * the code's scope (highestListCents), given only when the euros, the kind or the scope are being changed: a stored amount that a later price drop left
 * above it does not stop a note from saving. The value's problem is on `percent` or `amount` by the kind, the courses' on `courseIds`, the dates' order on
 * `endsOn`; the screens that hold fields back together (the kind with its value) do that themselves.
 */
export function codeFieldProblems(v: CodeFields, at: { welcome: boolean; highestCents?: number | null }): Partial<Record<CodeField, CodeFieldError>> {
  const out: Partial<Record<CodeField, CodeFieldError>> = {};
  const code = normalizeCode(v.code);
  if (code === "") out.code = "codeRequired";
  else if (!isCode(code) || code.length > CODE_MAX) out.code = "codeFormat";

  if (v.kind === "percent") {
    const n = percentOf(v.percent);
    if (n === null) out.percent = "whole";
    else if (n < PERCENT_MIN || n > PERCENT_MAX) out.percent = "discountRange";
  } else {
    const cents = amountCentsOf(v.amount);
    if (cents === null) out.amount = "amountEuro";
    else if (at.highestCents !== undefined && at.highestCents !== null && cents > at.highestCents) out.amount = "amountTooHigh";
  }

  if (v.scope === "courses" && v.courseIds.length === 0) out.courseIds = "coursesRequired";

  const starts = v.startsOn.trim();
  const ends = v.endsOn.trim();
  if (starts !== "" && !isDay(starts)) out.startsOn = "date";
  if (ends !== "" && !isDay(ends)) out.endsOn = "date";
  if (!out.startsOn && !out.endsOn && starts !== "" && ends !== "" && ends < starts) out.endsOn = "endBeforeStart";

  const max = v.maxUses.trim();
  if (max !== "" && !(WHOLE.test(max) && Number(max) >= 1 && Number(max) <= MAX_USES_MAX)) out.maxUses = "whole";

  if (at.welcome) {
    const days = v.daysAfterSignup.trim();
    if (days !== "") {
      if (!WHOLE.test(days)) out.daysAfterSignup = "whole";
      else if (Number(days) < DAYS_MIN || Number(days) > DAYS_MAX) out.daysAfterSignup = "codeDaysRange";
    }
  }

  if (v.note.length > CODE_NOTE_MAX) out.note = "tooLong";
  return out;
}

/** The fields of `next` that are not `stored`'s (the text trimmed, the chosen courses as a set); every field for a new code (`stored` null). */
export function changedCodeFields(next: CodeFields, stored: CodeFields | null): CodeField[] {
  const norm = (f: CodeField, x: CodeFields): string => {
    const value = x[f];
    if (f === "courseIds") return [...(value as number[])].sort((a, b) => a - b).join(",");
    return typeof value === "string" ? value.trim() : String(value);
  };
  return CODE_FIELDS.filter((f) => stored === null || norm(f, next) !== norm(f, stored));
}

/** The fields whose change makes R18's ceiling matter: the kind, the euros, the scope and its courses. */
export const CEILING_FIELDS: readonly CodeField[] = ["kind", "amount", "scope", "courseIds"];

/** The columns a checked `v` is stored as (the caller has run codeFieldProblems: nothing here fails). The welcome row has its own rules fixed. */
export function codeColumns(v: CodeFields, welcome: boolean) {
  const percent = v.kind === "percent" ? percentOf(v.percent) : null;
  const days = v.daysAfterSignup.trim();
  return {
    code: normalizeCode(v.code),
    percent,
    amountCents: v.kind === "euro" ? amountCentsOf(v.amount) : null,
    scope: v.scope,
    startsOn: v.startsOn.trim() === "" ? null : v.startsOn.trim(),
    endsOn: v.endsOn.trim() === "" ? null : v.endsOn.trim(),
    maxUses: v.maxUses.trim() === "" ? null : Number(v.maxUses.trim()),
    audience: welcome ? ("first" as const) : v.audience,
    oncePerPerson: welcome ? true : v.oncePerPerson,
    daysAfterSignup: welcome && days !== "" ? Number(days) : null,
    note: v.note.trim(),
  };
}

/** R20 „Soodustust kokku“: the cents the uses that count have taken off (a cancelled, unpaid, failed or refunded use gave its discount back). */
export const discountGiven = (uses: readonly { cents: number; mark: UseMark }[]): number => uses.reduce((sum, u) => (u.mark === "counts" ? sum + u.cents : sum), 0);

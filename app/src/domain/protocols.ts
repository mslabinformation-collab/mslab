// The protocols' and the course feedback form's pure rules (phase protocols, spec §3, §4, §7): a protocol's status, the stage headings a
// course copies into a new protocol and their limits, what a save may hold, the feedback form's fixed questions and their stored keys, the
// answers' check, and when the form opens. No database, no React: the admin's screen, the account's pages and the server share them.

import type { ProtocolStage } from "@/db/schema";
import { toStorable } from "@/lib/to-storable"; // (this file runs in the browser too: no lookbehind here nor in what it imports, tests/unit/old-safari.test.ts)
import { tallinnFormParts } from "./calendar";
import type { RegStatus } from "./registration";

/** At most 30 headings of at most 120 characters; every note and the general notes at most 10 000 characters (spec §3). */
export const PROTOCOL_LIMITS = { stages: 30, title: 120, note: 10_000 } as const;

/** none: no protocol yet; draft (Mustand): not sent; sent (Saadetud): the sent version; changed (Muudetud pärast saatmist): edited since. */
export type ProtocolStatus = "none" | "draft" | "sent" | "changed";

/** The status of a protocol row (spec §3's table), or "none" without one. Never stored. */
export function protocolStatus(row: { sentAt: Date | string | null; version: number; sentVersion: number | null } | null): ProtocolStatus {
  if (row === null) return "none";
  if (row.sentAt === null || row.sentVersion === null) return "draft";
  return row.version > row.sentVersion ? "changed" : "sent";
}

/** A course's headings as stored (jsonb: anything): its strings, trimmed, the blank ones left out, at most 30 of at most 120 characters. */
export function readStages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((v) => (typeof v === "string" && v.trim() ? [v.trim().slice(0, PROTOCOL_LIMITS.title)] : []))
    .slice(0, PROTOCOL_LIMITS.stages);
}

/** The course editor's "Protokolli punktid" as typed: trimmed, the blank rows dropped; more than 30, or one longer than 120, refused. */
export function checkStages(list: readonly string[]): { ok: true; stages: string[] } | { ok: false; error: "tooMany" | "tooLong" } {
  const stages = list.map((s) => s.trim()).filter(Boolean);
  if (stages.some((s) => s.length > PROTOCOL_LIMITS.title)) return { ok: false, error: "tooLong" };
  if (stages.length > PROTOCOL_LIMITS.stages) return { ok: false, error: "tooMany" };
  return { ok: true, stages };
}

/** A new protocol's practice part: the course's headings, each with an empty note (spec §3: copied when the protocol is created). */
export const stagesFrom = (headings: readonly string[]): ProtocolStage[] => headings.map((title) => ({ title, note: "" }));

/** Is anything written: a note under a stage, or the general notes? Blank text does not count. */
export const hasText = (p: { stages: readonly ProtocolStage[]; generalNote: string }): boolean =>
  p.generalNote.trim() !== "" || p.stages.some((s) => s.note.trim() !== "");

/** A note box: its stage's index, or the general notes. */
export type NotePlace = number | "general";

/** The boxes longer than PROTOCOL_LIMITS.note: the screen says so under each, and nothing is sent until they are shortened. */
export function overLimit(notes: readonly string[], generalNote: string): NotePlace[] {
  const out: NotePlace[] = notes.flatMap((n, i) => (n.length > PROTOCOL_LIMITS.note ? [i] : []));
  if (generalNote.length > PROTOCOL_LIMITS.note) out.push("general");
  return out;
}

/**
 * "Lukusta ja saada kõik" sends a protocol that has something new (spec §4): one with text that is not sent as it is — a draft (or one whose
 * first save is still on its way: "none" with text), or one changed after it was sent. One without text is skipped and named.
 */
export const newToSend = (status: ProtocolStatus, written: boolean): boolean => written && status !== "sent";

/** The date of an instant in Estonian time, "2026-10-12": it compares as text. */
const tallinnDate = (d: Date): string => tallinnFormParts(d).date;

/**
 * Does the feedback form open for a registration (spec §3, §9)? Never when it is cancelled. Then when its protocol has been sent, or when it is
 * a group registration whose session started before today in Tallinn and was not called off.
 */
export function feedbackOpen(
  r: { status: RegStatus; kind: "group" | "individual"; session: { startsAt: Date; cancelled: boolean } | null; protocolSentAt: Date | null },
  now: Date,
): boolean {
  if (r.status === "cancelled") return false;
  if (r.protocolSentAt !== null) return true;
  return r.kind === "group" && r.session !== null && !r.session.cancelled && tallinnDate(r.session.startsAt) < tallinnDate(now);
}

// ---------- the feedback form (spec §7: Maria's paper form, fixed, not editable in the admin) ----------

/** The seven choice questions and their options, as stored. The texts are the dictionaries' (account.feedback.questions). */
export const FEEDBACK_CHOICES = {
  expectations: ["exceeded", "met", "not_met"],
  clarity: ["very_clear", "fairly_clear", "needs_work"],
  balance: ["ideal", "more_practice", "more_theory"],
  ready: ["fully", "mostly", "rather_not", "no"],
  trainer: ["excellent", "good", "satisfactory", "needs_growth"],
  safe: ["very", "rather_yes", "rather_not"],
  materials: ["yes", "rather_yes", "rather_not", "no"],
} as const;
export type ChoiceKey = keyof typeof FEEDBACK_CHOICES;

/** The two free texts: "Kas soovitaksid … Miks?" and the message. */
export const FEEDBACK_TEXTS = ["recommend", "message"] as const;
export type TextKey = (typeof FEEDBACK_TEXTS)[number];

/** The paper form's order: the score, the seven choices, the two free texts. */
export const FEEDBACK_ORDER = ["score", "expectations", "clarity", "balance", "ready", "trainer", "safe", "materials", "recommend", "message"] as const;
export type FeedbackKey = (typeof FEEDBACK_ORDER)[number];

/** A free text's longest answer. */
export const FEEDBACK_TEXT_MAX = 2000;

/** The stored answers: keys only (a wording fix never breaks an old answer); a question not answered is absent. */
export type FeedbackAnswers = { score?: number } & { [K in ChoiceKey]?: (typeof FEEDBACK_CHOICES)[K][number] } & { [K in TextKey]?: string };

export type FeedbackCheck = { ok: true; answers: FeedbackAnswers } | { ok: false; error: string };

const KNOWN: ReadonlySet<string> = new Set(FEEDBACK_ORDER);
/** Is `key` one of the seven choice questions? (Own keys only: "constructor" or "__proto__" are no question.) */
export const isChoice = (key: string): key is ChoiceKey => Object.hasOwn(FEEDBACK_CHOICES, key);

/**
 * The answers as the form sends them (spec §7): an object of the known keys only (any other key: "answers"); the score a whole number 1–10; a
 * choice one of its options; a free text a string of at most 2000 characters that Postgres can store, trimmed (blank: not answered). A key that
 * is null is not answered. Nothing is required, but at least one answer is ("empty"). The first wrong key is the error.
 */
export function checkFeedback(value: unknown): FeedbackCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "answers" };
  const answers: Record<string, string | number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!KNOWN.has(key)) return { ok: false, error: "answers" };
    if (raw === null || raw === undefined) continue;
    if (key === "score") {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 10) return { ok: false, error: "score" };
      answers.score = raw;
    } else if (isChoice(key)) {
      if (typeof raw !== "string" || !(FEEDBACK_CHOICES[key] as readonly string[]).includes(raw)) return { ok: false, error: key };
      answers[key] = raw;
    } else {
      if (typeof raw !== "string") return { ok: false, error: key };
      const text = raw.trim();
      if (text.length > FEEDBACK_TEXT_MAX || toStorable(text) !== text) return { ok: false, error: key }; // (toStorable leaves alone exactly what Postgres stores)
      if (text) answers[key] = text;
    }
  }
  return Object.keys(answers).length === 0 ? { ok: false, error: "empty" } : { ok: true, answers: answers as FeedbackAnswers };
}

/** Every option of every choice question with how many chose it. */
export type OptionCounts = { [K in ChoiceKey]: Record<(typeof FEEDBACK_CHOICES)[K][number], number> };

/** A course's feedback in numbers (the admin's "Tagasiside"): how many answered, how many gave a score, its average (one decimal), the counts. */
export type FeedbackSummary = { count: number; scored: number; average: number | null; options: OptionCounts };

export function summarizeFeedback(list: readonly FeedbackAnswers[]): FeedbackSummary {
  const keys = Object.keys(FEEDBACK_CHOICES) as ChoiceKey[];
  const options = Object.fromEntries(keys.map((key) => [key, Object.fromEntries(FEEDBACK_CHOICES[key].map((o) => [o, 0]))])) as OptionCounts;
  let sum = 0;
  let scored = 0;
  for (const answers of list) {
    if (typeof answers.score === "number") {
      sum += answers.score;
      scored++;
    }
    for (const key of keys) {
      const counts = options[key] as Record<string, number>;
      const value = answers[key];
      if (value !== undefined && Object.hasOwn(counts, value)) counts[value] += 1;
    }
  }
  return { count: list.length, scored, average: scored ? Math.round((sum / scored) * 10) / 10 : null, options };
}

/** The questions' texts in one language (account.feedback.questions of a dictionary). */
export type FeedbackQuestionTexts = { [K in FeedbackKey]: { label: string; options?: Record<string, string> } };

/** A dictionary's questions (`account.feedback.questions` of et.ts or ru.ts) as answerText reads them: the one cast, the keys checked by tests. */
export const feedbackQuestions = (questions: object): FeedbackQuestionTexts => questions as FeedbackQuestionTexts;

/** An answer in words: the score as "9/10", an option as the dictionary words it, a free text as written. */
export function answerText(key: FeedbackKey, value: string | number, q: FeedbackQuestionTexts): string {
  if (key === "score") return `${value}/10`;
  return q[key].options?.[String(value)] ?? String(value);
}

/**
 * The open rule (feedbackOpen) for a registration read with its session and protocol: the form's server side (server/course-feedback.ts)
 * and the dashboard's card (server/client-data.ts loadDashboard) read the same columns. No session: an individual course.
 */
export function feedbackOpenFor(
  r: { status: RegStatus; kind: "group" | "individual"; startsAt: Date | null; sessionStatus: string | null; protocolSentAt: Date | null },
  now: Date,
): boolean {
  const session = r.startsAt === null ? null : { startsAt: r.startsAt, cancelled: r.sessionStatus === "cancelled" };
  return feedbackOpen({ status: r.status, kind: r.kind, session, protocolSentAt: r.protocolSentAt }, now);
}

/**
 * One student on the course day's screen as the page hands her over and GET /api/admin/protokoll answers: her protocol's draft, every date as text.
 * `awaiting`: her registration waits for its prepayment ("ootab ettemaksu"). `version` 0: no protocol yet (the course's headings, empty notes).
 * `protocolId`: the protocol's row, null for none yet (one deleted with the account and made again is another row, even at the same version).
 */
export type ScreenStudentView = {
  registrationId: number;
  protocolId: number | null;
  name: string;
  awaiting: boolean;
  version: number;
  titles: string[];
  notes: string[];
  generalNote: string;
  sentVersion: number | null;
  sentAt: string | null;
  savedAt: string | null;
};

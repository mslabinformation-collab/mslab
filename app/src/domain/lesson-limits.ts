import type { I18n } from "@/i18n/field";

// The limits of a course's module and lesson texts, and the rule they are checked by (admin UX pass piece 3a, final review P10-1 / M-2): one
// pure module for the server's checks (server/edit-check.ts Check.text, server/course-outline.ts, server/admin-lessons.ts) and the browser's
// (components/admin/LessonsEditor.tsx, a module's name; components/admin/LessonDrawer.tsx, a lesson's name and short text), so the browser never
// holds back a text the server would take, nor sends one it refuses. It imports nothing at run time: no server module enters the browser bundle.

/** A module's and a lesson's name and a lesson's short text at most (characters per language, trimmed). */
export const LESSON_LIMITS = { title: 120, body: 5000 } as const;

/** What a text in two languages fails on, as the server's check says it. */
export type TextProblem = "tooLong" | "required";

/**
 * The server's rule for a text in two languages (Check.text): each language trimmed; "tooLong" when either is longer than `max`; "required"
 * without the Estonian one when it is `required`, or when only the Russian one is there; null when it passes.
 */
export function textProblem(f: I18n, max: number, opts: { required?: boolean } = {}): TextProblem | null {
  const et = f.et.trim();
  const ru = (f.ru ?? "").trim();
  if (et.length > max || ru.length > max) return "tooLong";
  if (!et && (ru || opts.required)) return "required";
  return null;
}

/** The field codes of a module's or lesson's name (needed) and a lesson's short text (optional), as the server checks them; empty when they pass. */
export function lessonTextProblems(f: { title?: I18n; body?: I18n }): Record<string, TextProblem> {
  const out: Record<string, TextProblem> = {};
  const title = f.title ? textProblem(f.title, LESSON_LIMITS.title, { required: true }) : null;
  const body = f.body ? textProblem(f.body, LESSON_LIMITS.body) : null;
  if (title) out.title = title;
  if (body) out.body = body;
  return out;
}

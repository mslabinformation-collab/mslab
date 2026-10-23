import { z } from "zod";
import type { Db } from "@/db/client";
import { attemptForReview, type ReviewAttempt } from "@/db/queries/assessment";
import type { SaveAnswer } from "@/domain/autosave";
import { TEST_LIMITS } from "@/domain/completion";
import { MARKS_ENTITY, MARKS_PART, startMarks, type Marks } from "@/domain/test-review-marks";
import { readDrafts, saveDraftPart, type DraftPart } from "./drafts";

// Maria's marks on a test attempt's open answers, saved as she works (admin UX pass, piece 2, Task 11; README A4 "Test review", B15; behaviours.md
// B15): the second form part on the editors' autosave (components/admin/autosave), through POST /api/admin/testi-hinnang/<attempt>
// (server/autosave-route.ts autosaveHandler). Where it differs from the registration note (server/registration-note.ts):
// - the marks are a DRAFT of the review, in the draft layer (server/drafts.ts, `content_drafts`: entity "test_review", the attempt's id, part "marks",
//   value `{ submittedAt, marks }`). They are never written to `test_attempts.review`, which is what the student is shown (server/test-attempts.ts);
//   „Saada“ (reviewAttempt) sends them and deletes the draft in the same transaction;
// - a mark is one field of the form: its name is the question's id, its value `{ verdict, comment }`; a save names the marks that changed and the
//   rest of the draft stays;
// - the part's version is the draft's counter as text (the draft layer counts 1, 2, …; the editors' engine compares texts): "0" while there is
//   no draft (to read) for these answers;
// - the draft belongs to the answers it was written for: one with another `submittedAt` (the student rewrote her answers since) is not read,
//   and the next save replaces it, so a mark is never put onto answers Maria has not seen.
// Without Next.js: tests/db/test-review-route.test.ts runs the route on a real (PGlite) database. Logs never carry a comment's text.

/** One save's patch: marks by question id; each a verdict (or none) and a comment of at most TEST_LIMITS.comment characters, without a NUL (jsonb holds none). */
export const marksPatch = z.record(
  z.string().max(64),
  z.object({
    verdict: z.enum(["ok", "fix"]).nullable(),
    comment: z
      .string()
      .max(TEST_LIMITS.comment, "tooLong")
      .refine((v) => !v.includes("\u0000"), "text"),
  }),
);
export type MarksPatch = z.infer<typeof marksPatch>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What the draft layer holds for these answers, and the part as the form reads it. */
export type MarksPart = {
  /** The part's version as the editors' engine sees it: the live draft's counter, "0" without one. */
  version: string;
  /** Every open answer's mark: the form's start, the saved marks over it. */
  value: Marks;
  /** The saved marks alone (null: no draft for these answers). */
  saved: Marks | null;
  /** The stored row, a draft for older answers included (a save over it goes by its counter). */
  row: DraftPart | null;
};

/** The saved marks of a draft's value, defensively (jsonb holds anything): open answers only, and only if it was written for these answers. */
function savedMarks(a: Pick<ReviewAttempt, "questions" | "submittedAt">, value: unknown): Marks | null {
  if (!isRecord(value) || value.submittedAt !== a.submittedAt.toISOString() || !isRecord(value.marks)) return null;
  const out: Marks = {};
  for (const q of a.questions) {
    const m = q.kind === "open" ? value.marks[q.id] : undefined;
    if (!isRecord(m)) continue;
    out[q.id] = { verdict: m.verdict === "ok" || m.verdict === "fix" ? m.verdict : null, comment: typeof m.comment === "string" ? m.comment : "" };
  }
  return out;
}

/** The marks part of `a` out of the entity's drafts (`readDrafts`): see MarksPart. */
export function marksFrom(a: Pick<ReviewAttempt, "questions" | "review" | "submittedAt">, drafts: readonly DraftPart[]): MarksPart {
  const row = drafts.find((d) => d.part === MARKS_PART) ?? null;
  const saved = row ? savedMarks(a, row.value) : null;
  return { version: saved && row ? String(row.version) : "0", value: { ...startMarks(a.questions, a.review), ...saved }, saved, row };
}

/** The marks part of an attempt the page has read (the review page reads it for Maria's form). */
export async function marksOf(db: Db, a: Pick<ReviewAttempt, "id" | "questions" | "review" | "submittedAt">): Promise<MarksPart> {
  return marksFrom(a, await readDrafts(db, MARKS_ENTITY, a.id));
}

/** The marks part of an attempt as the route reads it; null for an id that is no attempt, or whose access an admin ended (the route's 404). */
export async function readMarks(db: Db, attemptId: number): Promise<{ version: string; value: Marks } | null> {
  const a = await attemptForReview(db, attemptId);
  if (!a) return null;
  const { version, value } = await marksOf(db, a);
  return { version, value };
}

/**
 * Stores `patch` over the marks a save was made on (`version`). Another version is a conflict, answered with the stored marks (the screen shows its
 * notice and „Taasta minu tekst“ saves over them); the write itself is the draft layer's compare-and-set (a save from another tab between the read
 * and the write is a conflict too, never overwritten). An attempt that is not waiting for her any more (she sent the review on another device) is a
 * conflict with no marks (and no draft is made). A mark for a question that is no open question of this attempt is refused at that field. A patch
 * with no mark changes nothing and answers the current version.
 */
export async function writeMarks(db: Db, attemptId: number, patch: MarksPatch, version: string, by: string, now: Date): Promise<SaveAnswer> {
  const a = await attemptForReview(db, attemptId);
  if (!a) return { ok: false, error: "conflict", version: "0", value: null };
  const read = async () => marksFrom(a, await readDrafts(db, MARKS_ENTITY, attemptId));
  const conflict = (m: MarksPart): SaveAnswer => ({ ok: false, error: "conflict", version: m.version, value: m.value });
  const current = await read();
  if (a.status !== "review") return { ok: false, error: "conflict", version: current.version, value: null };
  if (version !== current.version) return conflict(current);
  const open = new Set(a.questions.filter((q) => q.kind === "open").map((q) => q.id));
  const unknown = Object.keys(patch).filter((id) => !open.has(id));
  if (unknown.length > 0) return { ok: false, error: "invalid", fields: Object.fromEntries(unknown.map((id) => [id, "unknown"])) };
  if (Object.keys(patch).length === 0) return { ok: true, version: current.version, savedAt: now.toISOString() };
  const submittedAt = a.submittedAt.toISOString();
  const saved = await saveDraftPart(db, {
    entity: MARKS_ENTITY,
    entityId: attemptId,
    part: MARKS_PART,
    value: { submittedAt, marks: { ...current.saved, ...patch } },
    baseVersion: submittedAt,
    // a draft for these answers is saved over by its counter; one for older answers is replaced by its counter too; none is created
    version: current.row ? current.row.version : null,
    by,
  });
  if (saved.ok) return { ok: true, version: String(saved.version), savedAt: now.toISOString() };
  return conflict(await read());
}

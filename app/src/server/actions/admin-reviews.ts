"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import type { ManualReviewInput } from "@/domain/review";
import { adminEt } from "@/i18n/dict/admin";
import { ROW_ID_MAX } from "@/lib/row-id";
import { adminAction } from "../auth";
import { logFailure } from "../log";
import { revalidatePublic } from "../public-cache";
import { decideReview, deleteManualReview, saveManualReview, setFeatured } from "../reviews";

// Maria's review actions (student reviews, Task 4, spec D2, D4, §5): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is in ../reviews.ts
// (the rules and the writes); here the input is checked once more (a press the page never sends is refused without a read), the work's refusals get
// Estonian words (adminEt.reviews.errors, the codes of the work's own results and `server` for a throw, logged by the review's id and the error's
// class only, never a name or a text), and a success tells the public pages first (the review's course and the home page: cache-targets.ts "reviews")
// and the open admin page next. A review that is not there any more (the student took her permission back, or another tab deleted it) is answered
// in words and the page is refreshed too, so that its row goes.

type ErrorCode = keyof typeof adminEt.reviews.errors;
type Failure<C extends ErrorCode = ErrorCode> = { ok: false; error: C; text: string };

const fail = <C extends ErrorCode>(error: C): Failure<C> => ({ ok: false, error, text: adminEt.reviews.errors[error] });

const rowId = z.number().int().min(1).max(ROW_ID_MAX);
const decisionInput = z.object({ id: rowId, decision: z.enum(["publish", "hide"]) });
const featuredInput = z.object({ id: rowId, featured: z.boolean() });
const idOnly = z.object({ id: rowId });
/** The form's `id`: null for „Lisa arvustus“, the review's row id for „Muuda“. The fields are checked by saveManualReview (domain/review.ts). */
const saveTarget = z.object({ id: rowId.nullable() });

/** The pages of the review's course are stale, and so is the open page: in this order. */
function changed(courseSlug: string): void {
  revalidatePublic({ kind: "reviews", course: courseSlug });
  refresh();
}

/**
 * „Avalda“ / „Peida“: `{ id, decision }`. The review becomes published or hidden, whatever it was (a hidden one is published again; the same press
 * twice is harmless). Done: `{ ok: true }`. `gone`: no such review any more (the student took her permission back), in words, with the page refreshed.
 */
export const decideReviewAction = adminAction(async (_admin, input: { id: number; decision: "publish" | "hide" }) => {
  const parsed = decisionInput.safeParse(input);
  if (!parsed.success) return fail("gone");
  const { id, decision } = parsed.data;
  let result: Awaited<ReturnType<typeof decideReview>>;
  try {
    result = await decideReview(getDb(), id, decision, new Date());
  } catch (e) {
    logFailure(`[reviews] review ${id}: the decision failed`, e);
    return fail("server");
  }
  if (!result.ok) {
    refresh();
    return fail(result.error);
  }
  changed(result.courseSlug);
  return { ok: true as const };
});

/**
 * „Avalehel“: `{ id, featured }`. A published review is put on the home page or taken off it. Done: `{ ok: true }`. `notPublished`: the review is
 * pending or hidden (its row was stale), `gone`: no such review any more; both are answered in words, with the page refreshed.
 */
export const setFeaturedAction = adminAction(async (_admin, input: { id: number; featured: boolean }) => {
  const parsed = featuredInput.safeParse(input);
  if (!parsed.success) return fail("gone");
  const { id, featured } = parsed.data;
  let result: Awaited<ReturnType<typeof setFeatured>>;
  try {
    result = await setFeatured(getDb(), id, featured, new Date());
  } catch (e) {
    logFailure(`[reviews] review ${id}: the home page toggle failed`, e);
    return fail("server");
  }
  if (!result.ok) {
    refresh();
    return fail(result.error);
  }
  changed(result.courseSlug);
  return { ok: true as const };
});

/**
 * „Lisa arvustus“ (`id: null`) or „Muuda“ (the id of a review Maria added): the form as typed, checked by saveManualReview (every wrong field comes
 * back by name in `fields`: required, tooLong or invalid; nothing is stored then). Saved: `{ ok: true, id }`; a moved review refreshes the page of the
 * course it left as well (ruling R4). A student's review is `notManual` (never edited), one that is not there `manualGone`.
 */
export const saveManualReviewAction = adminAction(async (_admin, input: { id: number | null } & ManualReviewInput) => {
  const target = saveTarget.safeParse(input);
  if (!target.success) return { ok: false as const, fields: { form: "invalid" } };
  const { id } = target.data;
  let result: Awaited<ReturnType<typeof saveManualReview>>;
  try {
    result = await saveManualReview(getDb(), id, input, new Date());
  } catch (e) {
    logFailure(id === null ? "[reviews] a new review's save failed" : `[reviews] review ${id}: the save failed`, e);
    return fail("server");
  }
  if (!result.ok) {
    if (result.fields.form === "gone") {
      refresh();
      return fail("manualGone");
    }
    if (result.fields.form === "notManual") return fail("notManual");
    return { ok: false as const, fields: result.fields };
  }
  if (result.previousCourseSlug) revalidatePublic({ kind: "reviews", course: result.previousCourseSlug });
  changed(result.courseSlug);
  return { ok: true as const, id: result.id };
});

/** „Kustuta“: `{ id }`. A review Maria added is deleted. A student's review is not hers to delete, and one that is gone is gone: `manualGone`, page refreshed. */
export const deleteManualReviewAction = adminAction(async (_admin, input: { id: number }) => {
  const parsed = idOnly.safeParse(input);
  if (!parsed.success) return fail("manualGone");
  const { id } = parsed.data;
  let result: Awaited<ReturnType<typeof deleteManualReview>>;
  try {
    result = await deleteManualReview(getDb(), id);
  } catch (e) {
    logFailure(`[reviews] review ${id}: the deletion failed`, e);
    return fail("server");
  }
  if (!result.ok) {
    refresh();
    return fail("manualGone");
  }
  changed(result.courseSlug);
  return { ok: true as const };
});

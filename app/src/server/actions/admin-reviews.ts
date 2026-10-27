"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { REVIEW_STATUSES, type DecisionExpected, type ManualReviewInput } from "@/domain/review";
import { adminEt } from "@/i18n/dict/admin";
import { ROW_ID_MAX } from "@/lib/row-id";
import { adminAction } from "../auth";
import { logFailure } from "../log";
import { revalidatePublic } from "../public-cache";
import { purgeRemovedReviews } from "../review-purge";
import { decideReview, removeManualReview, restoreManualReview, restoreReviewDecision, saveManualReview, setFeatured } from "../reviews";

// Maria's review actions (student reviews, Task 4, spec D2, D4, §5): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is in ../reviews.ts
// (the rules and the writes); here the input is checked once more (a press the page never sends is refused without a read), the work's refusals get
// Estonian words (adminEt.reviews.errors, the codes of the work's own results and `server` for a throw, logged by the review's id and the error's
// class only, never a name or a text), and a success tells the public pages first (the review's course and the home page: cache-targets.ts "reviews")
// and the open admin page next. A review that is not there any more (the student took her permission back, or another tab deleted it) is answered
// in words and the page is refreshed too, so that its row goes. Admin UX pass piece 4c: a decision answers what its „Võta tagasi“ needs
// (undoDecisionAction, R-a), and „Kustuta“ is a soft delete with its own „Võta tagasi“ (removeReviewAction, undoRemoveReviewAction, R-b); each of
// them revalidates the course's pages once, after its transaction has committed.

type ErrorCode = keyof typeof adminEt.reviews.errors;
type Failure<C extends ErrorCode = ErrorCode> = { ok: false; error: C; text: string };

const fail = <C extends ErrorCode>(error: C): Failure<C> => ({ ok: false, error, text: adminEt.reviews.errors[error] });

const rowId = z.number().int().min(1).max(ROW_ID_MAX);
const decisionInput = z.object({ id: rowId, decision: z.enum(["publish", "hide"]) });
const featuredInput = z.object({ id: rowId, featured: z.boolean() });
const idOnly = z.object({ id: rowId });
/** The form's `id`: always null, „Lisa arvustus“ (piece 4c, ruling c3: „Muuda“ autosaves on its route). The fields are checked by saveManualReview. */
const saveTarget = z.object({ id: z.null() });
const reviewStatus = z.enum(REVIEW_STATUSES);
/** What decideReviewAction answered as `expected` (domain/review.ts DecisionExpected), sent back by its „Võta tagasi“. */
const undoInput = z.object({
  id: rowId,
  expected: z.object({ status: reviewStatus, updatedAt: z.iso.datetime(), previous: z.object({ status: reviewStatus, decidedAt: z.iso.datetime().nullable() }) }),
});

/** The pages of the review's course are stale, and so is the open page: in this order. */
function changed(courseSlug: string): void {
  revalidatePublic({ kind: "reviews", course: courseSlug });
  refresh();
}

/**
 * „Avalda“ / „Peida“: `{ id, decision }`. The review becomes published or hidden, whatever it was (a hidden one is published again; the same press
 * twice is harmless). Done: `{ ok: true, expected }`, where `expected` is what its „Võta tagasi“ sends back to undoDecisionAction (piece 4c, R-a).
 * `gone`: no such review any more (the student took her permission back); `manualGone`: a review Maria added and removed (in another tab), in her
 * words, as the undo answers it (review M-1). Each in words, with the page refreshed.
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
    return fail(result.error === "removed" ? "manualGone" : result.error);
  }
  changed(result.courseSlug);
  return { ok: true as const, expected: result.expected };
});

/**
 * „Võta tagasi“ of „Avalda“ / „Peida“ (piece 4c, R-a): `{ id, expected }`, the `expected` that decision answered. The status and `decided_at` of
 * the moment before the press come back. Done: `{ ok: true }`. `changed`: the review moved since the press (another tab decided it, „Avalehel“, an
 * edit; or a `previous` no press replaced), S4-38's words, nothing overwritten; `manualGone`: a review Maria added and removed since (review M-1);
 * `gone`: it is not there any more. Each refreshes the page, so that the row shows what it is now. An undo the page never sends is `gone` without a
 * read.
 */
export const undoDecisionAction = adminAction(async (_admin, input: { id: number; expected: DecisionExpected }) => {
  const parsed = undoInput.safeParse(input);
  if (!parsed.success) return fail("gone");
  const { id, expected } = parsed.data;
  let result: Awaited<ReturnType<typeof restoreReviewDecision>>;
  try {
    result = await restoreReviewDecision(getDb(), id, expected, new Date());
  } catch (e) {
    logFailure(`[reviews] review ${id}: the decision's undo failed`, e);
    return fail("server");
  }
  if (!result.ok) {
    refresh();
    return fail(result.error === "removed" ? "manualGone" : result.error);
  }
  changed(result.courseSlug);
  return { ok: true as const };
});

/**
 * „Avalehel“: `{ id, featured }`. A published review is put on the home page or taken off it. Done: `{ ok: true }`. `notPublished`: the review is
 * pending or hidden (its row was stale), `gone`: no such review any more, `manualGone`: a review Maria added and removed (in another tab, piece 4c
 * ruling c4: in her words, as the decision answers it); each is answered in words, with the page refreshed.
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
    return fail(result.error === "removed" ? "manualGone" : result.error);
  }
  changed(result.courseSlug);
  return { ok: true as const };
});

/**
 * „Lisa arvustus“ (`{ id: null, …the form }`): the form as typed, checked by saveManualReview (every wrong field comes back by name in `fields`:
 * required, tooLong or invalid; nothing is stored then). Saved: `{ ok: true, id }`. Only a create (piece 4c, ruling c3): any `id` but null is
 * `{ form: "invalid" }`, nothing read or written — „Muuda“ autosaves from the version it read (POST /api/admin/arvustus/<id>, R-c).
 */
export const saveManualReviewAction = adminAction(async (_admin, input: { id: null } & ManualReviewInput) => {
  const target = saveTarget.safeParse(input);
  if (!target.success) return { ok: false as const, fields: { form: "invalid" } };
  let result: Awaited<ReturnType<typeof saveManualReview>>;
  try {
    result = await saveManualReview(getDb(), input, new Date());
  } catch (e) {
    logFailure("[reviews] a new review's save failed", e);
    return fail("server");
  }
  if (!result.ok) return { ok: false as const, fields: result.fields };
  changed(result.courseSlug);
  return { ok: true as const, id: result.id };
});

/**
 * What comes after a stored change runs once the answer has gone (`after`), and never throws: whatever fails is logged here (the shape of the lesson
 * actions' afterwards, server/actions/admin-lessons.ts; review M-5).
 */
function afterwards(what: string, work: () => Promise<void>): void {
  after(async () => {
    try {
      await work();
    } catch (e) {
      logFailure(`[reviews] ${what} failed`, e);
    }
  });
}

/**
 * The purge of the reviews removed 10 s ago and more (server/review-purge.ts, R-b), once the answer has gone: „Kustuta“ never waits for it. It never
 * takes the review just removed: its mark is younger than 10 s.
 */
const purgeAfter = () => afterwards("the removed reviews' purge", async () => void (await purgeRemovedReviews(getDb(), new Date())));

/**
 * „Kustuta“ on a review Maria added (piece 4c, R-b): `{ id }`. The review is only marked (server/reviews.ts removeManualReview), so the page puts up
 * S4-38's „Arvustus kustutatud.“ with „Võta tagasi“ (undoRemoveReviewAction); the row goes once the mark is 10 s old, and each „Kustuta“ purges what
 * is due by then, after its answer. Done: `{ ok: true }`. `notManual`: a student's words are not Maria's to delete; `manualGone`: no such review, or
 * removed already (another tab), with the page refreshed. An id the page never sends is `manualGone` without a read.
 */
export const removeReviewAction = adminAction(async (_admin, input: { id: number }) => {
  const parsed = idOnly.safeParse(input);
  if (!parsed.success) return fail("manualGone");
  const { id } = parsed.data;
  let result: Awaited<ReturnType<typeof removeManualReview>>;
  try {
    result = await removeManualReview(getDb(), id, new Date());
  } catch (e) {
    logFailure(`[reviews] review ${id}: the removal failed`, e);
    return fail("server");
  } finally {
    purgeAfter();
  }
  if (!result.ok) {
    if (result.error === "notManual") return fail("notManual");
    refresh();
    return fail("manualGone");
  }
  changed(result.courseSlug);
  return { ok: true as const };
});

/**
 * „Võta tagasi“ of „Kustuta“ (piece 4c, R-b): `{ id }`. The review comes back as it was while its row is there (server/reviews.ts
 * restoreManualReview). Done: `{ ok: true }`. Purged already (the 10 s are over): `manualGone`, with the page refreshed. An id the page never sends is
 * `manualGone` without a read.
 */
export const undoRemoveReviewAction = adminAction(async (_admin, input: { id: number }) => {
  const parsed = idOnly.safeParse(input);
  if (!parsed.success) return fail("manualGone");
  const { id } = parsed.data;
  let result: Awaited<ReturnType<typeof restoreManualReview>>;
  try {
    result = await restoreManualReview(getDb(), id, new Date());
  } catch (e) {
    logFailure(`[reviews] review ${id}: the removal's undo failed`, e);
    return fail("server");
  }
  if (!result.ok) {
    refresh();
    return fail("manualGone");
  }
  changed(result.courseSlug);
  return { ok: true as const };
});

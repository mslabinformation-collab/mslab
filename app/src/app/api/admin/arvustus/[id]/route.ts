import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { revalidatePublic } from "@/server/public-cache";
import { MANUAL_REVIEW_PATCH, readManualReview, writeManualReview } from "@/server/reviews";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const save = autosaveHandler({
  schema: MANUAL_REVIEW_PATCH,
  // (only its 404: the write reads the review again under its lock)
  read: (id) => readManualReview(getDb(), id),
  write: async (id, patch, version) => {
    const done = await writeManualReview(getDb(), id, patch, version, new Date());
    // after the commit, once for each course page the review is on or has left (and the home page with them: cache-targets.ts "reviews")
    for (const course of done.courseSlugs) revalidatePublic({ kind: "reviews", course });
    return done.answer;
  },
});

/**
 * POST /api/admin/arvustus/<id> — „Muuda“ on a review Maria added, autosaved (admin UX pass piece 4c, Task 2; ruling R-c): `{ version, patch: { courseId?,
 * name?, text?, writtenAt?, locale?, note? } }` (the drawer's fields as typed) from the review's version ("r:<hash>" of its course, name, text, day,
 * language and note), answered by autosaveHandler (server/autosave-route.ts: 200 the new version, 409 the stored fields, 400 by field — checkManualReview's
 * codes —, 404 no review of Maria's to edit: none, a removed one, or a student's, whose words are never edited). Signed-in admins only, a cross-site POST
 * is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const id = parseRowId((await ctx.params).id);
  return id === null ? Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } }) : save(request, id, admin);
});

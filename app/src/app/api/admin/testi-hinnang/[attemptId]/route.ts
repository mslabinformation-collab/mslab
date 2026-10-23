import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { marksPatch, readMarks, writeMarks } from "@/server/test-review-marks";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ attemptId: string }> };

const save = autosaveHandler({
  schema: marksPatch,
  read: (id) => readMarks(getDb(), id),
  write: (id, patch, version, admin) => writeMarks(getDb(), id, patch, version, admin.email, new Date()),
});

/**
 * POST /api/admin/testi-hinnang/<attempt> — the test review's marks autosave (admin UX pass, piece 2, Task 11; README A4, B15): a save of
 * `{ version, patch: { <question id>: { verdict, comment } } }` from the marks' version (the draft layer's counter as text, "0" for none), answered by
 * autosaveHandler (server/autosave-route.ts: 200 the new version, 409 the stored marks, 400 the field codes, 404 for an id that is no attempt). The
 * marks are a draft of the review, not the review (server/test-review-marks.ts). Signed-in admins only, a cross-site POST is 403 (withAdmin). POST, not
 * PATCH: the editors' engine sends every save as a POST (autosave/engine.ts patchSender).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const id = parseRowId((await ctx.params).attemptId);
  return id === null ? Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } }) : save(request, id, admin);
});

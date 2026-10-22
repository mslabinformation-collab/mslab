import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { notePatch, readNote, writeNote } from "@/server/registration-note";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const save = autosaveHandler({
  schema: notePatch,
  read: (id) => readNote(getDb(), id),
  write: (id, patch, version) => writeNote(getDb(), id, patch, version, new Date()),
});

/**
 * POST /api/admin/registreering/<id>/markus — the registration drawer's „Märkus“ autosave (admin UX pass, piece 2, Task 5; README A2 drawer 3): a
 * save of `{ version, patch: { note } }` (at most 2000 characters) from the note's version, answered by autosaveHandler (server/autosave-route.ts:
 * 200 the new version, 409 the stored note, 400 the field's code, 404 for an id that is no registration). Signed-in admins only, a cross-site
 * POST is 403 (withAdmin). POST, not PATCH: the editors' engine sends every save as a POST (autosave/engine.ts patchSender).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const id = parseRowId((await ctx.params).id);
  return id === null ? Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } }) : save(request, id, admin);
});

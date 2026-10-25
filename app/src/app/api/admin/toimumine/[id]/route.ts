import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { readSession, SESSION_PATCH, writeSession } from "@/server/session-edit";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const save = autosaveHandler<Record<string, unknown>>({
  schema: SESSION_PATCH,
  // (only its 404: the write reads the session again under its lock)
  read: (id) => readSession(getDb(), id),
  // (the write revalidates the public pages' dates once, after its commit)
  write: (id, patch, version, admin) => writeSession(getDb(), id, patch, version, admin, new Date()),
});

/**
 * POST /api/admin/toimumine/<id> — a calendar session's fields, autosaved (admin UX pass piece 3b, Task 2; README B3 „fields autosave“): `{ version, patch:
 * { courseId?, date?, time?, city?, venue?, language?, capacity? } }` from the session's version ("s:<hash>", R-a), answered by autosaveHandler
 * (server/autosave-route.ts: 200 the new version, 409 the stored fields, 400 by field — each field's check, `capacityBelow` (R-c) and `courseLocked`
 * (R-b) decided under the session's lock —, 404 no such session). The status is not a field here: it has its own instant action. Signed-in admins only,
 * a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const id = parseRowId((await ctx.params).id);
  return id === null ? Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } }) : save(request, id, admin);
});

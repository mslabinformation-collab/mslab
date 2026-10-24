import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { outlineTextExists, writeOutlineText } from "@/server/admin-lessons";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { OUTLINE_TEXT_PATCHES } from "@/server/course-outline";
import { revalidatePublic } from "@/server/public-cache";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const save = autosaveHandler<Record<string, unknown>>({
  schema: OUTLINE_TEXT_PATCHES.module,
  // (only its 404: the write reads the row's text under the course's lock)
  read: async (id) => ((await outlineTextExists(getDb(), "module", id)) ? { version: "", value: null } : null),
  // a module's name is on the public course page: revalidated when it went live (an unpublished course's module; a draft and a flagged row show nowhere)
  write: (id, patch, version, admin) => writeOutlineText(getDb(), "module", id, patch, version, admin, new Date(), { live: () => revalidatePublic({ kind: "courses" }) }),
});

/**
 * POST /api/admin/moodul/<id> — a module's name, autosaved (admin UX pass piece 3a, Task 5 review I-1; README B2 „the title edits inline“): `{ version,
 * patch: { title } }` from the row's version ("t:<hash>", R-b amended), answered by autosaveHandler (server/autosave-route.ts: 200 the new version, 409
 * the stored name, 400 `title`, 404 no such module). A published course's live module waits in the outline draft for „Avalda muudatused“; a flagged
 * module and an unpublished course's are written to the row (server/admin-lessons.ts writeOutlineText). Signed-in admins only, a cross-site POST is
 * 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const id = parseRowId((await ctx.params).id);
  return id === null ? Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } }) : save(request, id, admin);
});

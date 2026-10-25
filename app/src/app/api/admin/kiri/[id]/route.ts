import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { CAMPAIGN_PATCH, readCampaign, writeCampaign } from "@/server/newsletter-campaigns";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const save = autosaveHandler<Record<string, unknown>>({
  schema: CAMPAIGN_PATCH,
  // (only its 404: the write reads the letter again, FOR UPDATE)
  read: (id) => readCampaign(getDb(), id),
  write: (id, patch, version) => writeCampaign(getDb(), id, patch, version, new Date()),
});

/**
 * POST /api/admin/kiri/<id> — a newsletter letter's fields, autosaved (admin UX pass piece 3b, Task 6; README B5 „The editor autosaves“): `{ version,
 * patch: { name?, subject?, preheader?, imageKey?, body?, code?, buttonLabel?, buttonHref? } }` from the letter's version ("k:<hash>" of its fields and
 * its status), answered by autosaveHandler (server/autosave-route.ts: 200 the new version — a save that changes nothing keeps it and the letter's
 * `updatedAt`, spec C4 —, 409 the stored fields — another tab's save, or a send that began —, 400 by field, 404 no such letter). Signed-in admins only,
 * a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const id = parseRowId((await ctx.params).id);
  return id === null ? Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } }) : save(request, id, admin);
});

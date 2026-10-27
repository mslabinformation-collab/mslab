import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { logFailure } from "@/server/log";
import { discardSite, parseSiteTarget, siteTargetExists } from "@/server/site-drafts";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ entity: string; id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/sisu/<entity>/<id>/loobu — „Loobu muudatustest“ of Avaleht, Koolitaja or Praktika (id 0; admin UX pass piece 4a, Task 1; README §1.8,
 * B2; ruling R-e), of Hüpikaken ("popup/0"; piece 4b) or of a post (post/<its id>; piece 4b): every draft of it deleted (server/site-drafts.ts discardSite); live stays as it is, so
 * nothing is revalidated. Pictures uploaded into a draft stay in the store (harmless orphans). 200 `{ stamp }`: the database's clock after the commit
 * (server/read-stamp.ts; null when it cannot be read). 404 for an entity or an id that is none (a post that is not there); 500 `{ ok: false, error:
 * "server" }`, logged. Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (_request, ctx) => {
  const { entity, id } = await ctx.params;
  const target = parseSiteTarget(entity, id);
  if (!target) return json({ ok: false, error: "notFound" }, 404);
  try {
    const db = getDb();
    if (!(await siteTargetExists(db, target))) return json({ ok: false, error: "notFound" }, 404);
    return json(await discardSite(db, target), 200);
  } catch (e) {
    logFailure(`[admin] site ${entity} ${id}: the discard failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

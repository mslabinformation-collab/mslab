import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { logFailure } from "@/server/log";
import { discardSite, isSiteEntity, SITE_ENTITY_ID } from "@/server/site-drafts";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ entity: string; id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/sisu/<entity>/0/loobu — „Loobu muudatustest“ of Avaleht, Koolitaja or Praktika (admin UX pass piece 4a, Task 1; README §1.8, B2;
 * ruling R-e): every draft of the entity deleted (server/site-drafts.ts discardSite); live stays as it is, so nothing is revalidated. Pictures
 * uploaded into a draft stay in the store (harmless orphans). 200 `{ stamp }`: the database's clock after the commit (server/read-stamp.ts). 404
 * for an entity that is none or an id other than 0; 500 `{ ok: false, error: "server" }`, logged. Signed-in admins only, a cross-site POST is 403
 * (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (_request, ctx) => {
  const { entity, id } = await ctx.params;
  if (!isSiteEntity(entity) || id !== String(SITE_ENTITY_ID)) return json({ ok: false, error: "notFound" }, 404);
  try {
    return json(await discardSite(getDb(), entity), 200);
  } catch (e) {
    logFailure(`[admin] site ${entity}: the discard failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

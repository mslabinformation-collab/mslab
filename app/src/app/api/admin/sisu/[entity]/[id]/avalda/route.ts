import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { logFailure } from "@/server/log";
import { isSiteEntity, publishSite, SITE_ENTITY_ID } from "@/server/site-drafts";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ entity: string; id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/sisu/<entity>/0/avalda — „Avalda muudatused“ of Avaleht, Koolitaja or Praktika (admin UX pass piece 4a, Task 1; README §1.8, B2;
 * rulings R-c, R-d): the entity's drafts written live in one transaction through the parts' strict checks and writers (server/site-drafts.ts
 * publishSite), the public pages revalidated once. 200 `{ stamp, published, blocked }`: the database's clock after the commit (server/read-stamp.ts,
 * a number, null when it cannot be read, as the course's; the editor starts its cards over from a page read at or past it), the parts written, and those left in their drafts with why (S3-P3-b, S4-2:
 * "missing" with the labels `Puudub:` lists, or "changed" meanwhile). 404 for an entity that is none or an id other than 0; 500 `{ ok: false,
 * error: "server" }`, logged. Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (_request, ctx) => {
  const { entity, id } = await ctx.params;
  if (!isSiteEntity(entity) || id !== String(SITE_ENTITY_ID)) return json({ ok: false, error: "notFound" }, 404);
  try {
    return json(await publishSite(getDb(), entity), 200);
  } catch (e) {
    logFailure(`[admin] site ${entity}: the publish failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

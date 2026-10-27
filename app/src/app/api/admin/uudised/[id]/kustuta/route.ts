import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { logFailure } from "@/server/log";
import { deletePost } from "@/server/site-drafts";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/uudised/<id>/kustuta — „Kustuta postitus“ (admin UX pass piece 4b, Task 1; ruling R-h): the post and its drafts deleted in one
 * transaction, the post pages revalidated when it was published (server/site-drafts.ts deletePost). The body is not read. 200 `{ ok: true }`; 404 for
 * an id that is no post (also once it is deleted); 500 `{ ok: false, error: "server" }`, logged. Signed-in admins only, a cross-site POST is 403
 * (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (_request, ctx) => {
  const id = parseRowId((await ctx.params).id);
  if (id === null) return json({ ok: false, error: "notFound" }, 404);
  try {
    return (await deletePost(getDb(), id)) ? json({ ok: true }, 200) : json({ ok: false, error: "notFound" }, 404);
  } catch (e) {
    logFailure(`[admin] post ${id}: the delete failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

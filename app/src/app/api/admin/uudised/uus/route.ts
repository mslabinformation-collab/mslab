import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { logFailure } from "@/server/log";
import { createPost } from "@/server/site-drafts";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/uudised/uus — „Lisa postitus +“ (admin UX pass piece 4b, Task 1; S4-19, ruling R-g): a post made at once, not published, titled
 * „Uus postitus“ with the address `uus-postitus` or the series' first free one (server/site-drafts.ts createPost: two presses at once make two posts,
 * never a unique-index error). The body is not read. 200 `{ id }`: the new post's (the editor opens at /admin/uudised/<id>); 500 `{ ok: false, error:
 * "server" }`, logged. Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin(async () => {
  try {
    const { id } = await createPost(getDb(), new Date());
    return json({ id }, 200);
  } catch (e) {
    logFailure("[admin] a new post could not be made", e);
    return json({ ok: false, error: "server" }, 500);
  }
});

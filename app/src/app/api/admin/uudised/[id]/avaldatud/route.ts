import { z } from "zod";
import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { logFailure } from "@/server/log";
import { switchPostPublished } from "@/server/site-drafts";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const switchBody = z.strictObject({ on: z.boolean() });

/**
 * POST /api/admin/uudised/<id>/avaldatud — a post's „Avaldatud“, instant (admin UX pass piece 4b, Task 1; ruling R-b): `{ on }`. On, a post that is
 * not published is published once S4-Q1 A's check passes; off, a published post's pending drafts are published first and it is hidden
 * (server/site-drafts.ts switchPostPublished). 200 with the answer: `{ ok: true, stamp }` (the database's clock after the commit, server/read-
 * stamp.ts; null when it cannot be read), or refused, nothing changed: `{ ok: false, missing }` (S4-22's labels, `Puudub: …` under the switch) or
 * `{ ok: false, blocked }` (the parts that could not be published: "changed" meanwhile, "invalid" with `errors: { slug: "slugTaken" }`). 404 for an
 * id that is no post; 400 `{ ok: false, error: "body" }` for another body; 500 `{ ok: false, error: "server" }`, logged. Signed-in admins only, a
 * cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx) => {
  const id = parseRowId((await ctx.params).id);
  if (id === null) return json({ ok: false, error: "notFound" }, 404);
  let on: boolean;
  try {
    const parsed = switchBody.safeParse(await request.json());
    if (!parsed.success) return json({ ok: false, error: "body" }, 400);
    on = parsed.data.on;
  } catch {
    return json({ ok: false, error: "body" }, 400);
  }
  try {
    const answer = await switchPostPublished(getDb(), id, on, new Date());
    if (!answer.ok && "error" in answer) return json({ ok: false, error: "notFound" }, 404);
    return json(answer, 200);
  } catch (e) {
    logFailure(`[admin] post ${id}: the switch failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

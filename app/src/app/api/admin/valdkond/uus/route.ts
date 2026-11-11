import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { addArea } from "@/server/course-areas";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/valdkond/uus — „Lisa valdkond“ in Seaded → „Valdkonnad“ (course areas, spec 2026-11-11 §4.1): `{ et, ru }`, both names required,
 * the Estonian one unique (server/course-areas.ts addArea); the new area goes last. 200 `{ ok: true, id, areas }`: the list after it; 400 `{ ok:
 * false, error: "invalid", fields }` by name, or `{ error: "body" }` for a body that is no JSON; 500 `{ ok: false, error: "server" }`, logged without
 * the names. Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin(async (request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "body" }, 400);
  }
  try {
    const answer = await addArea(getDb(), body);
    return json(answer, answer.ok ? 200 : 400);
  } catch (e) {
    logFailure("[admin] a new area could not be made", e);
    return json({ ok: false, error: "server" }, 500);
  }
});

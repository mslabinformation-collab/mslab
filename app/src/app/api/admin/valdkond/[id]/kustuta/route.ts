import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { deleteArea } from "@/server/course-areas";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/valdkond/<id>/kustuta — „Kustuta“ in Seaded → „Valdkonnad“ (course areas, spec 2026-11-11 §4.1): an area no course uses (live or in a
 * draft) is deleted (server/course-areas.ts deleteArea). The body is not read. 200 `{ ok: true, areas }`: the list without it; 409 `{ ok: false, error:
 * "inUse", used, areas }`: courses use it, it stays; 404 for no such area (also once it is deleted); 500 `{ ok: false, error: "server" }`, logged.
 * Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (_request, ctx) => {
  const id = parseRowId((await ctx.params).id);
  if (id === null) return json({ ok: false, error: "notFound" }, 404);
  try {
    const answer = await deleteArea(getDb(), id);
    return json(answer, answer.ok ? 200 : answer.error === "inUse" ? 409 : 404);
  } catch (e) {
    logFailure(`[admin] area ${id}: the delete failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

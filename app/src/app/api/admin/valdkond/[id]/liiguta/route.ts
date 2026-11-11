import { z } from "zod";
import { getDb } from "@/db/client";
import { parseRowId, ROW_ID_MAX } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { moveAreaTo } from "@/server/course-areas";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The place the area goes to (0 is the first; past the end: last). */
const BODY = z.object({ index: z.number().int().min(0).max(ROW_ID_MAX) }).strict();

/**
 * POST /api/admin/valdkond/<id>/liiguta — a drag, ↑ or ↓ in Seaded → „Valdkonnad“ (course areas, spec 2026-11-11 §4.1): `{ index }`, the place the
 * area goes to (server/course-areas.ts moveAreaTo: the list renumbered 1…n). 200 `{ ok: true, areas }`: the list in its new order; 404 for no such
 * area; 400 `{ ok: false, error: "body" }` for a body that is no place; 500 `{ ok: false, error: "server" }`, logged. Signed-in admins only, a
 * cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx) => {
  const id = parseRowId((await ctx.params).id);
  if (id === null) return json({ ok: false, error: "notFound" }, 404);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "body" }, 400);
  }
  const place = BODY.safeParse(body);
  if (!place.success) return json({ ok: false, error: "body" }, 400);
  try {
    const answer = await moveAreaTo(getDb(), id, place.data.index);
    return json(answer, answer.ok ? 200 : 404);
  } catch (e) {
    logFailure(`[admin] area ${id}: the move failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

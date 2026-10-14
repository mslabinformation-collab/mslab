import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { logFailure } from "@/server/log";
import { mediaStore } from "@/server/media-store";
import { photoFor } from "@/server/practical";
import { privateFileAnswer } from "@/server/private-file";

export const dynamic = "force-dynamic";
// R2 is given 10 s to answer (server/r2.ts); a hung database call must not hold the function for the plan's default 300 s
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

/** A photo's answer is one admin's, never kept; the screen's address is not passed on to R2 (next.config.ts's site-wide rule sends the origin at most). */
const HEADERS = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * GET /api/admin/foto/<id> (e-course completion, spec §5.3, R5): a student's practical photo for Maria's assessment screen — a 302 to a
 * 5-minute signed R2 address (server/private-file.ts), or the local folder's bytes; `?v=pisi` its thumbnail. Signed-in admins only (withAdmin:
 * 401 otherwise); any student's photo, whatever her access's state. 404 `{ error: "notFound" }` for an id that is no photo, and without a
 * store; 500 `{ error: "server" }` (logged by id).
 */
export const GET = withAdmin<Ctx>(async (request, ctx) => {
  const id = parseRowId((await ctx.params).id);
  if (id === null) return json({ ok: false, error: "notFound" }, 404);
  try {
    const photo = await photoFor(getDb(), { admin: true }, id);
    const store = mediaStore();
    if (!photo || !store) return json({ ok: false, error: "notFound" }, 404);
    const thumbnail = new URL(request.url).searchParams.get("v") === "pisi";
    return (await privateFileAnswer(store, thumbnail ? photo.thumbKey : photo.key, { contentType: "image/jpeg", headers: HEADERS })) ?? json({ ok: false, error: "notFound" }, 404);
  } catch (e) {
    logFailure(`[practical] photo ${id}: the admin's read failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

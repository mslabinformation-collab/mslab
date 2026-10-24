import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { courseExists, publishCourse } from "@/server/course-parts";
import { logFailure } from "@/server/log";
import { stampOrNull } from "@/server/read-stamp";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/koolitus/<id>/avalda — „Avalda muudatused“ of a course (admin UX pass piece 3a, Task 4; README §1.8, B2; R-c): its drafts written
 * live in one transaction (server/course-parts.ts publishCourse), the public course pages revalidated once. 200 `{ published, blocked, stamp }`: the
 * parts written, those left in their drafts with why (S3-P3-b: "changed" meanwhile, or "missing" a published course's price), and the database's clock
 * after the commit (server/read-stamp.ts; the editor starts its cards over from a page read at or past it, Task 9 review M-1). 404 for an id that is no
 * course; 500 `{ ok: false, error: "server" }`, logged. Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (_request, ctx) => {
  const id = parseRowId((await ctx.params).id);
  if (id === null) return json({ ok: false, error: "notFound" }, 404);
  try {
    const db = getDb();
    if (!(await courseExists(db, id))) return json({ ok: false, error: "notFound" }, 404);
    const result = await publishCourse(db, id, new Date());
    return json({ ...result, stamp: await stampOrNull(db) }, 200);
  } catch (e) {
    logFailure(`[admin] course ${id}: the publish failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

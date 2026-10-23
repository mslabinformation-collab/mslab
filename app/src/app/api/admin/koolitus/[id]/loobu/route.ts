import { after } from "next/server";
import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { bunnyApi, bunnyConfig } from "@/server/bunny";
import { courseExists, discardCourse } from "@/server/course-parts";
import { removeLessonMedia } from "@/server/lesson-media";
import { logFailure } from "@/server/log";
import { mediaStore } from "@/server/media-store";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/koolitus/<id>/loobu — „Loobu muudatustest“ of a course (admin UX pass piece 3a, Task 4; README §1.8, B2; R-e): its drafts deleted,
 * and its modules and lessons not published yet (server/course-parts.ts discardCourse); live stays as it is, so nothing is revalidated. Their Bunny
 * videos and stored files are removed after the answer (`after`: Maria does not wait for Bunny or R2; removeLessonMedia never throws). 200
 * `{ discarded }`: how many drafts and rows went. 404 for an id that is no course; 500 `{ ok: false, error: "server" }`, logged. Signed-in admins
 * only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (_request, ctx) => {
  const id = parseRowId((await ctx.params).id);
  if (id === null) return json({ ok: false, error: "notFound" }, 404);
  try {
    const db = getDb();
    if (!(await courseExists(db, id))) return json({ ok: false, error: "notFound" }, 404);
    const discarded = await discardCourse(db, id, (cleanup) =>
      after(async () => {
        try {
          const config = bunnyConfig();
          await removeLessonMedia(cleanup, { bunny: config ? bunnyApi(config) : null, files: mediaStore() });
        } catch (e) {
          logFailure(`[admin] course ${id}: the discarded lessons' cleanup failed`, e);
        }
      }),
    );
    return json({ discarded }, 200);
  } catch (e) {
    logFailure(`[admin] course ${id}: the discard failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

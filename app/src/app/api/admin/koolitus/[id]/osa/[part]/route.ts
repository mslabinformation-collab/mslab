import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { COURSE_PARTS, courseExists, coursePartPatch, isCoursePart, writeCoursePart, type CoursePart } from "@/server/course-parts";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string; part: string }> };

/**
 * The handler's `read` only says whether the course is there (its 404): the write reads the part itself, under the course's lock (review M-3), so the
 * save does not read it twice. Its version and value are not used.
 */
const exists = async (id: number) => ((await courseExists(getDb(), id)) ? { version: "", value: null } : null);

/** One save handler per part: its schema, the course's 404 and its write (server/course-parts.ts). */
const handlers = Object.fromEntries(
  COURSE_PARTS.map((part) => [
    part,
    autosaveHandler<Record<string, unknown>>({
      schema: coursePartPatch(part),
      read: exists,
      write: (id, patch, version, admin) => writeCoursePart(getDb(), id, part, patch, version, admin, new Date()),
    }),
  ]),
) as Record<CoursePart, ReturnType<typeof autosaveHandler>>;

const notFound = () => Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/koolitus/<id>/osa/<part> — a course editor card's autosave (admin UX pass piece 3a, Task 4; README B2): a save of
 * `{ version, patch }` from the part's version (R-b: "l:<hash>", or "d:<draft row id>.<n>" for a draft), answered by autosaveHandler (server/autosave-route.ts: 200 the new
 * version, 409 what is stored, 400 the field codes, 404 for an id that is no course or a name that is no part). A published course's save is its
 * draft, an unpublished one's goes live (server/course-parts.ts). The `outline` (the modules' and lessons' order and texts) is a part, but is never
 * saved whole here: 400 `modules` (Task 5 review I-1; a row's text saves at api/admin/moodul/<id> and api/admin/oppetund/<id>). Signed-in admins
 * only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const { id: rawId, part } = await ctx.params;
  const id = parseRowId(rawId);
  return id === null || !isCoursePart(part) ? notFound() : handlers[part](request, id, admin);
});

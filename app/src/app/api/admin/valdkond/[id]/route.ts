import { z } from "zod";
import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { areaThere, writeAreaName } from "@/server/course-areas";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

/** A row's names as typed (loose here: the real rule, 60 characters trimmed and the Estonian name unique, is writeAreaName's, with field codes). */
const PATCH = z.object({ et: z.string().max(2_000, "tooLong"), ru: z.string().max(2_000, "tooLong") }).partial().strict();

const save = autosaveHandler<z.infer<typeof PATCH>>({
  schema: PATCH,
  // (only its 404: the write reads the row's names under the list's lock)
  read: async (id) => ((await areaThere(getDb(), id)) ? { version: "", value: null } : null),
  write: (id, patch, version) => writeAreaName(getDb(), id, patch, version, new Date()),
});

/**
 * POST /api/admin/valdkond/<id> — an area's names in Seaded → „Valdkonnad“, autosaved (course areas, spec 2026-11-11 §4.1): `{ version, patch: { et?,
 * ru? } }` from the row's version (the hash of its names), answered by autosaveHandler (server/autosave-route.ts: 200 the new version, 409 the names
 * as stored, 400 `required` / `tooLong` / `taken` by field, 404 no such area). A change revalidates the calendar and the catalogue (server/
 * course-areas.ts writeAreaName). Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const id = parseRowId((await ctx.params).id);
  return id === null ? Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } }) : save(request, id, admin);
});

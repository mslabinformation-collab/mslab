import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { isSeadedPart, SEADED_PARTS, seadedPatch, writeSeadedPart, type SeadedPart } from "@/server/seaded";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ part: string }> };

/** One save handler per part: its schema and its write (server/seaded.ts). A settings part is always there (no row is a part's defaults): never 404. */
const handlers = Object.fromEntries(
  SEADED_PARTS.map((part) => [
    part,
    autosaveHandler<Record<string, unknown>>({
      schema: seadedPatch(part),
      read: async () => ({ version: "", value: null }),
      write: (_id, patch, version) => writeSeadedPart(getDb(), part, patch, version, new Date()),
    }),
  ]),
) as Record<SeadedPart, ReturnType<typeof autosaveHandler>>;

const notFound = () => Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/seaded/<part> — a Seaded card's autosave (admin UX pass piece 3b, Task 4; README B4, B21): a save of `{ version, patch }` for
 * contact | newsletter | prepayment | invoice | certificate | financing, answered by autosaveHandler (server/autosave-route.ts: 200 the part's new
 * version, 409 what is stored, 400 the field codes — „Järgmine number“'s `taken` among them —, 404 for a name that is no part). Signed-in admins
 * only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const { part } = await ctx.params;
  return isSeadedPart(part) ? handlers[part](request, 0, admin) : notFound();
});

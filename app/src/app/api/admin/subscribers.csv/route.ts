import { getDb } from "@/db/client";
import { listSubscribers } from "@/db/queries/admin";
import { subscriberFilterOf } from "@/domain/subscribers";
import { subscribersCsv, subscribersCsvName } from "@/server/admin";
import { withAdmin } from "@/server/auth";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/subscribers.csv — the newsletter subscribers as a CSV download (signed-in admins only: 401 JSON otherwise): exactly the rows
 * Tellijad shows for the same address (README B5, „Laadi alla (CSV)“ of the current filter), all of them, not a page. `?otsi=` the text an address
 * holds, `?olek=kinnitatud` the addresses whose owner confirmed the subscription (the ones a newsletter may go to), `?olek=ootab` those that
 * never did; the file is named after the state. (`?kinnitatud=1`, the former „Lae alla kinnitatud (CSV)“ link, means `?olek=kinnitatud`.)
 * Both the screen and this route read the address with domain/subscribers.ts subscriberFilterOf. Never cached; formula-like cells are defused
 * (server/csv.ts).
 */
export const GET = withAdmin(async (request) => {
  const url = new URL(request.url);
  // the parameters as Next gives a page its searchParams: a name given twice is a list (and the filter takes no list)
  const params: Record<string, string | string[]> = Object.create(null);
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    params[key] = all.length === 1 ? all[0] : all;
  }
  const filter = subscriberFilterOf(params);
  try {
    const body = subscribersCsv(await listSubscribers(getDb(), filter));
    return new Response(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${subscribersCsvName(new Date(), filter.state ?? null)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    logFailure("[admin] subscriber export failed", e);
    return Response.json({ ok: false, error: "server" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
});

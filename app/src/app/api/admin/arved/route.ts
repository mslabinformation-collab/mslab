import { getDb } from "@/db/client";
import { tallinnFormParts } from "@/domain/calendar";
import { parseMonth } from "@/domain/invoice";
import { withAdmin } from "@/server/auth";
import { invoicesCsv } from "@/server/invoices";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * GET /api/admin/arved?kuu=2026-10 (invoices Task 5, spec §6.5): the month's invoices for the accountant, as the CSV of domain/invoice.ts
 * invoiceCsv (`;`-separated, UTF-8 with a BOM, every invoice issued in that Tallinn month, cancelled ones marked) named
 * `MS-LAB-arved-2026-10.csv`; without `kuu`, this month. Private and never kept, nosniff. Signed-in admins only (withAdmin: 401 otherwise).
 * 400 `month` for a `kuu` that is not YYYY-MM; 500 `server` (logged, no data).
 */
export const GET = withAdmin(async (request) => {
  const asked = new URL(request.url).searchParams.get("kuu");
  const month = asked === null ? tallinnFormParts(new Date()).date.slice(0, 7) : parseMonth(asked);
  if (month === null) return json({ ok: false, error: "month" }, 400);
  try {
    return new Response(await invoicesCsv(getDb(), month), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="MS-LAB-arved-${month}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    logFailure("[invoices] the month's CSV failed", e);
    return json({ ok: false, error: "server" }, 500);
  }
});

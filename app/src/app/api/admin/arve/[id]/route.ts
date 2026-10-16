import { getDb } from "@/db/client";
import { invoiceDownloadHeaders } from "@/domain/invoice";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { invoiceForAdmin, invoicePdf } from "@/server/invoices";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";
// the PDF takes about a tenth of a second (spec §7): a hung database call ends after 30 s, not the default 300 s.
// next.config.ts traces assets/fonts into this function (outputFileTracingIncludes, invoices Task 1).
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * GET /api/admin/arve/<id> (invoices Task 5, spec §5): any invoice as Maria downloads it from the registration's „Arved“ or the „Arved“ page —
 * a cancelled or a paid one too. Rendered from its frozen row, its footer line too (server/invoices.ts invoicePdf), as
 * `attachment; filename="MS-LAB-arve-MSL2026-001.pdf"` (domain/invoice.ts invoiceDownloadHeaders), private and never kept. Signed-in admins
 * only (withAdmin: 401 otherwise). 404 `notFound` for an id that is no invoice; 500 `server` (logged by the invoice's id).
 */
export const GET = withAdmin<Ctx>(async (_request, ctx) => {
  const id = parseRowId((await ctx.params).id);
  if (id === null) return json({ ok: false, error: "notFound" }, 404);
  try {
    const db = getDb();
    const inv = await invoiceForAdmin(db, id);
    if (!inv) return json({ ok: false, error: "notFound" }, 404);
    const bytes = await invoicePdf(inv);
    return new Response(new Blob([bytes as BlobPart], { type: "application/pdf" }), {
      // the type, the file name and nosniff are domain/invoice.ts's; the answer is never kept
      headers: { ...invoiceDownloadHeaders(inv.number), "cache-control": "private, no-store" },
    });
  } catch (e) {
    logFailure(`[invoices] invoice ${id}: the admin's download failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

import { getDb } from "@/db/client";
import { contractDownloadHeaders } from "@/domain/contract";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { contractForAdmin, contractPdf } from "@/server/contracts";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";
// the PDF takes about a tenth of a second: a hung database call ends after 30 s, not the default 300 s.
// next.config.ts traces assets/fonts into this function (outputFileTracingIncludes, contracts Task 5).
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * GET /api/admin/leping/<id> (contracts Task 5, spec §4): any contract as Maria downloads it from the registration's „Leping“ block or the student's
 * „Lepingud“ — the current one or a superseded one, of a registration that is cancelled or gone too. Rendered from its frozen row alone
 * (server/contracts.ts contractPdf), as `attachment; filename="MS-LAB-leping-7.pdf"` (domain/contract.ts contractDownloadHeaders), private and never
 * kept. Signed-in admins only (withAdmin: 401 otherwise). 404 `notFound` for an id that is no contract; 500 `server` (logged by the contract's id).
 */
export const GET = withAdmin<Ctx>(async (_request, ctx) => {
  const id = parseRowId((await ctx.params).id);
  if (id === null) return json({ ok: false, error: "notFound" }, 404);
  try {
    const contract = await contractForAdmin(getDb(), id);
    if (!contract) return json({ ok: false, error: "notFound" }, 404);
    const bytes = await contractPdf(contract);
    return new Response(new Blob([bytes as BlobPart], { type: "application/pdf" }), {
      // the type, the file name and nosniff are domain/contract.ts's; the answer is never kept
      headers: { ...contractDownloadHeaders(contract.id), "cache-control": "private, no-store" },
    });
  } catch (e) {
    logFailure(`[contracts] contract ${id}: the admin's download failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

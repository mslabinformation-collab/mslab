import { getDb } from "@/db/client";
import { certificateDownloadHeaders } from "@/domain/certificate";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { certificateForAdmin, certificatePdf } from "@/server/certificates";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";
// the PDF takes about a tenth of a second (spec §7): a hung database call ends after 30 s, not the default 300 s.
// next.config.ts traces assets/fonts into this function (outputFileTracingIncludes, Task 1).
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * GET /api/admin/tunnistus/<id> (phase 3d, spec §6): any certificate as Maria downloads it from the Õpilased drawer or the register — a
 * revoked access's too (Review Focus 5). Rendered from its frozen row with Seaded's trainer's name of now, typed in the script font as the
 * signature (server/certificates.ts certificatePdf), as `attachment; filename="MS-LAB-tunnistus-{year}-{nn}.pdf"`, private and never kept.
 * Signed-in admins only (withAdmin: 401 otherwise). 404 `notFound` for an id that is no certificate; 500 `server` (logged by the
 * certificate's id).
 */
export const GET = withAdmin<Ctx>(async (_request, ctx) => {
  const id = parseRowId((await ctx.params).id);
  if (id === null) return json({ ok: false, error: "notFound" }, 404);
  try {
    const db = getDb();
    const cert = await certificateForAdmin(db, id);
    if (!cert) return json({ ok: false, error: "notFound" }, 404);
    const bytes = await certificatePdf(db, cert, new Date());
    return new Response(new Blob([bytes as BlobPart], { type: "application/pdf" }), {
      // the type, the file name and nosniff are Task 4's (domain/certificate.ts); the answer is never kept
      headers: { ...certificateDownloadHeaders(cert.year, cert.seq), "cache-control": "private, no-store" },
    });
  } catch (e) {
    logFailure(`[certificate] ${id}: the admin's download failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

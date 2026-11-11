import { getDb } from "@/db/client";
import { designFor, frozenOf } from "@/domain/certificate-design";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { listCertificateDesigns } from "@/server/certificate-designs";
import { sampleCertificatePdf, type CertificateSampleValues } from "@/server/certificate-sample";
import { logFailure } from "@/server/log";
import { mediaStore } from "@/server/media-store";

export const dynamic = "force-dynamic";
// as Maria's certificate download (api/admin/tunnistus/[id]); next.config.ts traces assets/fonts into this function
export const maxDuration = 30;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The card's fields the sample reads (server/certificate-sample.ts CertificateSampleValues), by their query names. */
const FIELDS = ["place", "registryCode", "practicalLine", "trainerName", "nextYear", "nextSeq"] as const;
/** No field is longer than this (the card's longest takes 200): a longer value is cut, so the address stays small whatever is sent. */
const MAX = 400;

/**
 * GET /api/admin/naidistunnistus?place=…&trainerName=… (Dim 07.11.2026): Seaded → „Näidistunnistus (PDF)“. A sample certificate drawn from the
 * card's values as they stand on the screen (the query holds the card's fields, saved or not; one left out reads as the default). Nothing is
 * stored and no number is used. `design=<id>` (2026-11-11 certificate designs: a design row's „Vaata näidist“): drawn in that design, its photo read
 * from the image store; none, or an id of no design, the first design (what an e-course with no pick gets); no design at all, today's dark page.
 * Shown in the browser as `inline; filename="MS-LAB-naidistunnistus.pdf"`, private and never kept, nosniff. Signed-in admins only (withAdmin: 401
 * otherwise). 500 `server` (logged, no data): also when the design's photo cannot be read (never a sample without it).
 */
export const GET = withAdmin(async (request) => {
  const query = new URL(request.url).searchParams;
  const values: CertificateSampleValues = {};
  for (const field of FIELDS) {
    const value = query.get(field);
    if (value !== null) values[field] = value.slice(0, MAX);
  }
  try {
    const design = designFor(await listCertificateDesigns(getDb()), parseRowId(query.get("design") ?? ""));
    const bytes = await sampleCertificatePdf(values, new Date(), design ? frozenOf(design) : null, design?.backgroundKey ? mediaStore() : null);
    return new Response(new Blob([bytes as BlobPart], { type: "application/pdf" }), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'inline; filename="MS-LAB-naidistunnistus.pdf"',
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    logFailure("[certificate] the sample certificate failed", e);
    return json({ ok: false, error: "server" }, 500);
  }
});

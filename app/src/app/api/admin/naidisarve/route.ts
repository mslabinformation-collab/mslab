import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { sampleInvoicePdf, type SampleValues } from "@/server/invoice-sample";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";
// as Maria's invoice download (api/admin/arve/[id]): the PDF takes about a tenth of a second; next.config.ts traces assets/fonts into this function
export const maxDuration = 30;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The card's fields the sample reads (server/invoice-sample.ts SampleValues), by their query names. */
const FIELDS = ["company", "registryCode", "address", "vatNumber", "vatOn", "vatRate", "prefix", "nextSeq", "termDays", "footer"] as const;
/** No field is longer than this (the card's longest takes 300): a longer value is cut, so the address stays small whatever is sent. */
const MAX = 400;

/**
 * GET /api/admin/naidisarve?company=…&registryCode=… (invoices Task 5, spec §5): Seaded → „Näidisarve (PDF)“. A sample invoice drawn from the
 * card's values as they stand on the screen (the query holds the card's fields, saved or not; one left out reads as empty), with the bank
 * details of Ettemaksu juhised as stored. Nothing is stored and no number is used. Shown in the browser as `inline; filename="MS-LAB-naidisarve.pdf"`,
 * private and never kept, nosniff. Signed-in admins only (withAdmin: 401 otherwise). 500 `server` (logged, no data).
 */
export const GET = withAdmin(async (request) => {
  const query = new URL(request.url).searchParams;
  const values: SampleValues = {};
  for (const field of FIELDS) {
    const value = query.get(field);
    if (value !== null) values[field] = value.slice(0, MAX);
  }
  try {
    const bytes = await sampleInvoicePdf(getDb(), values, new Date());
    return new Response(new Blob([bytes as BlobPart], { type: "application/pdf" }), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'inline; filename="MS-LAB-naidisarve.pdf"',
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    logFailure("[invoices] the sample invoice failed", e);
    return json({ ok: false, error: "server" }, 500);
  }
});

import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { sampleContractPdf, type ContractSampleValues } from "@/server/contract-sample";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";
// as Maria's contract download (api/admin/leping/[id]): the PDF takes about a tenth of a second; next.config.ts traces assets/fonts into this function
export const maxDuration = 30;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The card's fields the sample reads (server/contract-sample.ts ContractSampleValues), by their form names. */
const FIELDS = ["titleEt", "titleRu", "bodyEt", "bodyRu", "lang"] as const;
/** No text is longer than the legal texts' limit (30 000; the editors take a little more before they refuse it): a longer one is cut, so the sample stays small. */
const MAX = 40_000;

/**
 * POST /api/admin/naidisleping (contracts Task 5, spec §4): Seaded → Lepingud → „Näidisleping (PDF)“. A sample contract drawn from the card's texts as
 * they stand on the screen, saved or not: the card's form posts them (`titleEt`, `titleRu`, `bodyEt`, `bodyRu`, and `lang`: `ru` for the Russian sample), one
 * left out reads as empty. A form post, not a query: a contract text is up to 30 000 characters and a Russian one is six times that in an address.
 * Nothing is stored. Shown in the browser as `inline; filename="MS-LAB-naidisleping.pdf"`, private and never kept, nosniff. Signed-in admins only
 * (withAdmin: 401 otherwise). 400 `invalid` for a body that is no form; 500 `server` (logged, no data).
 */
export const POST = withAdmin(async (request) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "invalid" }, 400);
  }
  const values: ContractSampleValues = {};
  for (const field of FIELDS) {
    const value = form.get(field);
    if (typeof value === "string") values[field] = value.slice(0, MAX);
  }
  try {
    const bytes = await sampleContractPdf(getDb(), values, new Date());
    return new Response(new Blob([bytes as BlobPart], { type: "application/pdf" }), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'inline; filename="MS-LAB-naidisleping.pdf"',
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    logFailure("[contracts] the sample contract failed", e);
    return json({ ok: false, error: "server" }, 500);
  }
});

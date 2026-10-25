import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { sampleContractPdf, type ContractSampleValues } from "@/server/contract-sample";
import { sampleTexts } from "@/server/legal-drafts";
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
 * The most of a body the route reads: four fields of MAX characters, a form-posted Cyrillic character being six bytes ("%D0%A5"), is about 960 000, so
 * 1 MB holds the largest sample the card can send (its fields stop at 120 and 30 000 characters) and refuses anything that only wastes memory.
 */
const MAX_BODY = 1_000_000;

/**
 * The request's body read up to MAX_BODY bytes, or null when it is longer: a `content-length` above the cap is refused before a byte is read, and a
 * body that does not say its length (or lies) is read chunk by chunk and dropped at the first byte past the cap, so what the route holds never passes it.
 */
async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/**
 * POST /api/admin/naidisleping (contracts Task 5, spec §4): Seaded → Kontaktkoolituse leping → „Näidisleping (PDF)“. A sample contract drawn from the
 * card's texts as they stand on the screen, published or not: the card's form posts them (`titleEt`, `titleRu`, `bodyEt`, `bodyRu`, and `lang`: `ru`
 * for the Russian sample), one left out reads as empty. A post with none of the four is the contact text's draft when there is one, else its live
 * text (admin UX pass piece 3b, ruling R-d; server/legal-drafts.ts sampleTexts). A form post, not a query: a contract text is up to 30 000 characters
 * and a Russian one is six times that in an address.
 * Nothing is stored. Shown in the browser as `inline; filename="MS-LAB-naidisleping.pdf"`, private and never kept, nosniff. Signed-in admins only
 * (withAdmin: 401 otherwise, before a byte of the body is read). 413 `tooLarge` for a body over MAX_BODY (about 1 MB), refused by its `content-length` or
 * at the first byte past the cap; 400 `invalid` for a body that is no form; 500 `server` (logged, no data).
 */
export const POST = withAdmin(async (request) => {
  let body: Uint8Array | null;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, error: "invalid" }, 400); // (a body that broke off on its way)
  }
  if (body === null) return json({ ok: false, error: "tooLarge" }, 413);
  let form: FormData;
  try {
    // (the same bytes, kind and boundary: the body parsed as the form it was sent as)
    form = await new Response(body as BodyInit, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return json({ ok: false, error: "invalid" }, 400);
  }
  const values: ContractSampleValues = {};
  for (const field of FIELDS) {
    const value = form.get(field);
    if (typeof value === "string") values[field] = value.slice(0, MAX);
  }
  try {
    const db = getDb();
    const bytes = await sampleContractPdf(db, await sampleTexts(db, values), new Date());
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

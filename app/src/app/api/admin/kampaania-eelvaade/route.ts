import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { serverEnv } from "@/server/env";
import { logFailure } from "@/server/log";
import { campaignPreview } from "@/server/newsletter-campaigns";

export const dynamic = "force-dynamic";

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });

/**
 * The most of a body the route reads: the editor's draft with every text at its limit (two bodies of 10 000 characters, the Russian one two bytes a
 * character in UTF-8, or six as a JSON escape) is under 200 000 bytes; 256 kB holds it and refuses anything that only wastes memory.
 */
export const MAX_PREVIEW_BODY = 256 * 1024;

/**
 * The request's body read up to MAX_PREVIEW_BODY bytes, or null when it is longer: a `content-length` above the cap is refused before a byte is
 * read, and a body that does not say its length (or lies) is read chunk by chunk and dropped at the first byte past the cap (as
 * /api/admin/naidisleping reads its form).
 */
async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PREVIEW_BODY) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PREVIEW_BODY) {
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
 * POST /api/admin/kampaania-eelvaade (newsletter campaigns Task 4, spec D4, D5): the live preview of Maria's campaign editor. The body is JSON
 * `{ draft }`, the editor's fields as they stand, saved or not; the answer is `{ ok: true, et, ru, ruFallsBack }`, each language's
 * `{ subject, preheader, html }`: the real mail (server/newsletter-campaigns.ts campaignPreview) for the editor's <iframe srcdoc sandbox>, its links
 * on SITE_URL (never this request's address) and its unsubscribe link the test page's. Nothing is stored. Signed-in admins only (withAdmin: 401
 * otherwise, 403 for a POST from another site, before a byte of the body is read); private and never kept, nosniff. 413 `tooLarge` for a body over
 * MAX_PREVIEW_BODY, 400 `invalid` for a body that is no JSON object, 500 `server` (logged by the error's class, no data).
 */
export const POST = withAdmin(async (request) => {
  let body: Uint8Array | null;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, error: "invalid" }, 400); // (a body that broke off on its way)
  }
  if (body === null) return json({ ok: false, error: "tooLarge" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ ok: false, error: "invalid" }, 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return json({ ok: false, error: "invalid" }, 400);
  try {
    const preview = await campaignPreview(getDb(), serverEnv().SITE_URL, (parsed as { draft?: unknown }).draft, new Date());
    return json({ ok: true, ...preview }, 200);
  } catch (e) {
    logFailure("[newsletter] the campaign preview failed", e);
    return json({ ok: false, error: "server" }, 500);
  }
});

import { logFailure, logNote } from "../log";
import { JwtError } from "./jwt";
import type { Montonio, OrderToken } from "./montonio";
import { settleToken, type SettleDeps } from "./settle";

// Montonio's two ways back to the app (phase 2b, spec 6.5, 7.4), without Next.js: app/api/payments/notify/route.ts (and, from Task 6,
// return/route.ts) build the dependencies; the tests call these with PGlite and a stubbed Montonio. Without payments both are 404.

export type PaymentRouteDeps = Omit<SettleDeps, "montonio"> & { montonio: Montonio | null };

/** Montonio's webhook bodies are a few hundred bytes (spec 10: at most 8 KB). */
export const MAX_NOTIFY_BODY = 8 * 1024;

/** Every answer is a plain JSON one, never kept, never a redirect: Montonio reads the status and nothing else. */
const json = (status: number, body: unknown): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * The request's body as text, at most MAX_NOTIFY_BODY bytes, or null when it is longer. A declared length over the limit is refused without
 * reading; otherwise the stream is read chunk by chunk and cancelled the moment it passes the limit, whatever the sender said it would send.
 */
async function readBounded(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_NOTIFY_BODY) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_NOTIFY_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The body's `orderToken` and whether it is a refund webhook ({ refundToken }); null for a body over the limit or not JSON. */
async function readNotification(request: Request): Promise<{ orderToken: string; refund: boolean } | null> {
  try {
    const raw = await readBounded(request);
    if (raw === null) return null;
    const body = JSON.parse(raw) as { orderToken?: unknown; refundToken?: unknown } | null;
    return { orderToken: typeof body?.orderToken === "string" ? body.orderToken : "", refund: typeof body?.refundToken === "string" };
  } catch {
    return null;
  }
}

/**
 * POST /api/payments/notify `{ orderToken }`: Montonio's webhook, sent on every status change and retried 13 times over 48 hours unless the
 * answer is 200/201. 400 only for a token that cannot be verified (or a body that is none, or over the limit); 200 for everything understood
 * — a settled payment, one settled before, an unknown reference (logged), a refund webhook ({ refundToken }: REFUNDED also comes as the
 * order's own status, so it is not read); 503 when the database fails or a token in doubt cannot be confirmed with Montonio. No token, no
 * address is logged. 404 without payments. Never a redirect.
 */
export async function handleNotify(request: Request, deps: PaymentRouteDeps): Promise<Response> {
  const montonio = deps.montonio;
  if (!montonio) return json(404, { ok: false });
  const body = await readNotification(request);
  if (body?.refund && !body.orderToken) return json(200, { ok: true });
  let token: OrderToken;
  try {
    token = montonio.verifyOrderToken(body?.orderToken ?? "");
  } catch (e) {
    logNote(`[payments] webhook: a token that cannot be verified (${e instanceof JwtError ? e.code : "error"})`);
    return json(400, { ok: false });
  }
  try {
    const result = await settleToken({ ...deps, montonio }, token);
    return result.kind === "unconfirmed" ? json(503, { ok: false }) : json(200, { ok: true });
  } catch (e) {
    logFailure("[payments] webhook: not settled", e);
    return json(503, { ok: false });
  }
}

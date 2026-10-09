import { paymentContext } from "@/db/queries/payments";
import { resultFragment, type PaymentOutcome, type ResultView } from "@/domain/payments";
import { logFailure, logNote } from "../log";
import { JwtError } from "./jwt";
import type { Montonio, OrderToken } from "./montonio";
import { settleToken, type SettleDeps } from "./settle";

// Montonio's two ways back to the app (phase 2b, spec 6.5, 7.4), without Next.js: app/api/payments/notify/route.ts and
// return/route.ts build the dependencies; the tests call these with PGlite and a stubbed Montonio. Without payments both are 404.

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

/** Where the return sends the payer: /makse (Estonian) or /ru/makse, the result in the fragment (spec 6.5: no server or cache sees it). */
export const returnTarget = (locale: "et" | "ru", view: ResultView): string => `${locale === "ru" ? "/ru" : ""}/makse#${resultFragment(view)}`;

const NOTHING: Omit<ResultView, "outcome"> = { kind: null, payToken: null, course: null };

/**
 * A 303 to `target`, a path of ours built by returnTarget and sent as it is: a relative Location, which the payer's browser resolves against
 * the address it is already at. No host value (Host, a forwarded header, the request's URL) takes part, and nothing in the address can change
 * where it goes. Never cached, and the token in this request's address is passed on as no Referer.
 */
const seeOther = (target: string): Response =>
  new Response(null, { status: 303, headers: { location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" } });

/** The return when nothing could be read or settled (the settings, the database): the payer lands on /makse as "pooleli", never on an error page. */
export const returnPending = (): Response => seeOther(returnTarget("et", { outcome: "pooleli", ...NOTHING }));

/**
 * GET /api/payments/return?order-token=… — Montonio sends the payer back here, paid or not (also after a cancel at the bank). The token is
 * verified and settled through the one door (settle.ts; the webhook may come before, after or never). Then a 303 to /makse of the payment's
 * language: makstud (paid); pooleli (pending, held, or a token in doubt that Montonio could not confirm); katkestatud (failed or refunded).
 * "Proovi uuesti" is offered (`maksa`, or an e-course's `kursus`) on katkestatud and on a pooleli whose row is still pending — Montonio
 * answers a cancel at the bank with PENDING — never on a held one (the money is at Montonio: a second payment could charge her twice), and
 * never on a refunded one (she has paid, and may still open what she bought). The Location is a path only (seeOther). A
 * token that cannot be verified, an unknown reference: katkestatud with nothing more; a database failure: pooleli. Never an error page.
 * 404 without payments. The fragment holds the outcome, the kind, the pay token and the slug: no address, no Montonio uuid, no amount.
 */
export async function handleReturn(request: Request, deps: PaymentRouteDeps): Promise<Response> {
  const montonio = deps.montonio;
  if (!montonio) return json(404, { ok: false });
  const params = new URL(request.url).searchParams;
  // the documented name is `order-token`; the snake_case twin is taken too (some of Montonio's plugins send it)
  const raw = params.get("order-token") ?? params.get("order_token") ?? "";
  let token: OrderToken;
  try {
    token = montonio.verifyOrderToken(raw);
  } catch (e) {
    logNote(`[payments] return: a token that cannot be verified (${e instanceof JwtError ? e.code : "error"})`);
    return seeOther(returnTarget("et", { outcome: "katkestatud", ...NOTHING }));
  }
  try {
    const result = await settleToken({ ...deps, montonio }, token);
    if (result.kind === "unknown") return seeOther(returnTarget("et", { outcome: "katkestatud", ...NOTHING }));
    const p = result.payment;
    const outcome: PaymentOutcome =
      result.kind === "unconfirmed" ? "pooleli" : p.status === "paid" ? "makstud" : p.status === "pending" || p.status === "held" ? "pooleli" : "katkestatud";
    // never after a refund: the payer has paid (and may still open what she bought), so a second payment would charge her twice
    const retry = (outcome === "katkestatud" && p.status !== "refunded") || (result.kind === "done" && p.status === "pending");
    const ecourse = p.kind === "ecourse";
    // what it was for only decorates the landing: a read that fails after the settlement must not turn a paid payment into "pooleli"
    const ctx = await paymentContext(deps.db, p.id).catch((e: unknown) => {
      logFailure("[payments] return: what the payment was for could not be read", e);
      return null;
    });
    return seeOther(
      returnTarget(p.locale, {
        outcome,
        kind: ecourse ? "ekoolitus" : "registreering",
        payToken: !ecourse && retry ? (ctx?.payToken ?? null) : null,
        course: ecourse && (outcome === "makstud" || retry) ? (ctx?.course?.slug ?? null) : null,
      }),
    );
  } catch (e) {
    logFailure("[payments] return: not settled", e);
    return returnPending();
  }
}

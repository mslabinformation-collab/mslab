import type { WebhookEventPayload } from "resend";
import { getDb } from "@/db/client";
import { serverEnv } from "@/server/env";
import { serverKv } from "@/server/kv";
import { logFailure, logNote } from "@/server/log";
import type { Env } from "@/server/notify";
import { handleWebhook, webhookVerifier } from "@/server/resend-marketing";
import { sha256 } from "@/server/token";

export const dynamic = "force-dynamic";
// A contact deleted after an unsubscribe is one Resend call (8 s, and one retry after a 429): the function must not hang for the plan's 300 s.
export const maxDuration = 30;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
/** Resend's events are a few hundred bytes; anything much bigger is not one. */
const BODY_MAX = 64 * 1024;
/** How long a handled event's svix-id is remembered: Resend's retries of one event end within days. */
const SEEN_TTL_SEC = 7 * 24 * 60 * 60;

/**
 * POST /api/resend/webhook — Resend's webhook for the newsletter (newsletter campaigns, spec D3, D10, §4): contact.updated,
 * suppression.added and suppression.removed (server/resend-marketing.ts handleWebhook). The raw body is verified with the resend package's
 * webhooks.verify against the svix headers (svix-id, svix-timestamp, svix-signature) and RESEND_WEBHOOK_SECRET: a bad signature, a missing
 * header or no secret set is 400 and nothing is done. Every verified event is answered 200, the ones the site ignores too. An event's svix-id is
 * remembered for a week (the KV store, as a hash) and a repeat is answered 200 without doing it again (it would be harmless: deleting a row
 * twice deletes nothing). A database failure is 500, so Resend sends the event again; its svix-id is then not remembered. It goes through the
 * coming-soon gate (lib/site-gate.ts). Answers are never cached; the log has no address.
 */
export async function POST(request: Request): Promise<Response> {
  let env: Env;
  try {
    env = { ...serverEnv(), KV: serverKv() };
  } catch (e) {
    logFailure("[newsletter-sync] webhook: settings unavailable", e);
    return json(500, { ok: false });
  }
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    logNote("[newsletter-sync] webhook refused: RESEND_WEBHOOK_SECRET is not set");
    return json(400, { ok: false });
  }
  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!id || !timestamp || !signature || Number(request.headers.get("content-length") ?? 0) > BODY_MAX) return json(400, { ok: false });
  let payload: string;
  try {
    payload = await request.text();
  } catch {
    return json(400, { ok: false });
  }
  if (payload.length > BODY_MAX) return json(400, { ok: false });
  let event: WebhookEventPayload;
  try {
    event = webhookVerifier(env).webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret: secret });
  } catch {
    logNote("[newsletter-sync] webhook refused: the signature does not match");
    return json(400, { ok: false });
  }
  const seen = `resend-webhook:${await sha256(id)}`;
  try {
    if (await env.KV.get(seen)) return json(200, { ok: true });
  } catch (e) {
    logFailure("[newsletter-sync] webhook: seen events unavailable, handling it", e);
  }
  try {
    await handleWebhook({ db: getDb(), env, siteUrl: env.SITE_URL, now: new Date() }, event);
  } catch (e) {
    logFailure("[newsletter-sync] webhook event failed", e);
    return json(500, { ok: false });
  }
  try {
    await env.KV.put(seen, "1", { expirationTtl: SEEN_TTL_SEC });
  } catch (e) {
    logFailure("[newsletter-sync] webhook: event not remembered", e);
  }
  return json(200, { ok: true });
}

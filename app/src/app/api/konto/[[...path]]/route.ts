import { after } from "next/server";
import { getDb } from "@/db/client";
import { accountResponse, handleAccountApi, type AccountDeps } from "@/server/account-api";
import { bunnyConfig } from "@/server/bunny";
import { serverEnv } from "@/server/env";
import { serverKv } from "@/server/kv";
import { logFailure } from "@/server/log";
import { mediaStore } from "@/server/media-store";
import { paymentProvider } from "@/server/payments/montonio";
import { hostOrigin, isLocalHost, linkBase } from "@/server/site";

export const dynamic = "force-dynamic";
/** A hung database or provider call must not hold the function for the plan's default 300 s (as /media and the upload). */
export const maxDuration = 30;

/** The router's dependencies for this request: the app's one pool, the settings, the Postgres KV store, after(). */
function deps(request: Request): AccountDeps {
  const h = request.headers;
  const env = { ...serverEnv(), KV: serverKv() };
  return {
    db: getDb(),
    env,
    now: new Date(),
    // Links in e-mails come from the Host header only (Vercel routes by it); a Host outside the allow-list gives SITE_URL.
    siteUrl: linkBase(hostOrigin(h), env.SITE_URL),
    // E-mails and notifications go out after the response.
    later: (task) => after(() => task().catch((e) => logFailure("[account] background task failed", e))),
    dev: process.env.NODE_ENV !== "production" && isLocalHost(h.get("host")),
    // The lesson files' store (R2, or the local folder) and Bunny Stream (null without its three settings).
    files: mediaStore(),
    bunny: bunnyConfig(env),
    // online payments (phase 2b): null without the keys
    montonio: paymentProvider(),
  };
}

async function answer(request: Request): Promise<Response> {
  try {
    return (await handleAccountApi(request, deps(request))) ?? accountResponse({ ok: false }, 404);
  } catch (e) {
    logFailure("[account] request failed", e); // a missing setting (serverEnv) ends up here
    return accountResponse({ ok: false, error: "server" }, 500);
  }
}

export const GET = answer;
export const POST = answer;
export const PATCH = answer;
export const DELETE = answer; // phase 2c: DELETE /parool

/** Mail scanners and link previews often send HEAD first; Next would run GET for it and use up the login link. */
export function HEAD(): Response {
  return new Response(null, { status: 405, headers: { allow: "GET", "cache-control": "private, no-store" } });
}

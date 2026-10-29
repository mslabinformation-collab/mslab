import { after } from "next/server";
import { getDb } from "@/db/client";
import { serverEnv } from "@/server/env";
import { serverKv } from "@/server/kv";
import { logFailure } from "@/server/log";
import { handleLoginRequest } from "@/server/login";
import { clientIp } from "@/server/ratelimit";
import { hostOrigin, linkBase } from "@/server/site";

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Asks for a login link: `{ email, tagasi? }` as JSON (`tagasi`: the admin page to land on after signing in, B19). Answers
 * `{ ok: true }` whether or not the address is allowed (the link is e-mailed only to allowed ones), 400 `{ ok: false, error: "email" }`
 * for something that is not an e-mail address, 429 `{ ok: false, error: "rate" }` after 5 requests in 10 minutes from one IP,
 * 429 `{ ok: false, error: "address" }` for the 4th request for one address in 10 minutes, allowed or not (B20), 500 when the database fails.
 * Outside production the answer also carries `devLink` (tests and local development have no mailbox).
 */
export async function POST(request: Request): Promise<Response> {
  const h = request.headers;
  // A cross-site <form> cannot send application/json (a fetch could, but only after a CORS preflight that fails).
  if (!h.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ ok: false, error: "type" }, 415);
  try {
    const env = { ...serverEnv(), KV: serverKv() };
    const result = await handleLoginRequest(
      {
        db: getDb(),
        env,
        // Without x-forwarded-for (never on Vercel) `next dev` uses one local bucket.
        ip: clientIp(h) ?? (process.env.NODE_ENV === "development" ? "local" : null),
        // The link in the e-mail comes from the Host header only (the host routes requests by it), never from Origin or
        // x-forwarded-host, which a client can set; a Host that is not in the allow-list gives SITE_URL.
        siteUrl: linkBase(hostOrigin(h), env.SITE_URL),
        host: h.get("host"),
        now: new Date(),
        // The e-mail goes out after the response (next/server after()), so the answer is as quick for a refused address.
        later: (task) => after(() => task().catch((e) => logFailure("[auth] login e-mail failed", e))),
      },
      await request.json().catch(() => null),
    );
    return json(result.body, result.status);
  } catch (e) {
    logFailure("[auth] login request failed", e); // never the message: it holds query parameters (the e-mail)
    return json({ ok: false, error: "server" }, 500);
  }
}

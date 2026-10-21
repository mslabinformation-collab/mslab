import type { NextResponse } from "next/server";
import { PREVIEW_COOKIE, PREVIEW_SECRET_MIN, PREVIEW_TTL_S, previewCookieOptions, previewKey, signPreview } from "@/lib/preview-cookie";
import { gateOn } from "@/lib/site-gate";
import { serverEnv } from "./env";
import { logFailure, logNote } from "./log";

// The admins' preview cookie of the coming-soon gate (lib/preview-cookie.ts, lib/site-gate.ts) on an answer: set at sign-in
// (api/auth/verify), by "Vaata kodulehte" (api/admin/preview; the top line, and on a phone the menu's footer) and by the draft preview's „Eelvaade ↗“
// (api/admin/eelvaade, previewPath below), cleared at logout (api/auth/logout).

/** "No usable PREVIEW_SECRET" is noted once per instance, not at every sign-in. */
let notedNoKey = false;

/**
 * Adds a fresh preview cookie (30 days, as the session) to `res`. Without a usable PREVIEW_SECRET (unset, blank or shorter
 * than 32 characters: previewKey) there is none to give: noted once when the gate is on or the secret is too short, and the
 * answer goes on as it is. Never throws: signing in must not fail over it.
 */
export async function setPreviewCookie(res: NextResponse): Promise<void> {
  try {
    const env = serverEnv();
    const key = previewKey(env.PREVIEW_SECRET);
    if (!key) {
      if (!notedNoKey && (gateOn(env.SITE_GATE) || env.PREVIEW_SECRET)) {
        notedNoKey = true;
        logNote(`[gate] PREVIEW_SECRET is not set or shorter than ${PREVIEW_SECRET_MIN} characters: no preview cookie is given, so admins see the coming-soon page too`);
      }
      return;
    }
    res.cookies.set(PREVIEW_COOKIE, await signPreview(key), { ...previewCookieOptions, maxAge: PREVIEW_TTL_S });
  } catch (e) {
    logFailure("[gate] the preview cookie was not set", e);
  }
}

/** The longest `tee` the draft preview follows (a page's path with its query); a longer one goes to the home page. */
const PREVIEW_PATH_MAX = 2048;

/**
 * A parsed path that would read as another site, or as a path the router could take for another one: it starts with `//` (taken as `//host` by
 * whatever resolves it next), or has a `\` (a browser reads it as `/`), as it is or once percent-decoded (`/%2F…`, `%5C`). One that does not
 * decode counts as one too.
 */
function offSitePath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return [pathname, decoded].some((p) => p.startsWith("//") || p.includes("\\"));
}

/**
 * Where the draft preview (api/admin/eelvaade) sends the admin: `tee` when it is a path of this site, else "/".
 * - Before parsing: one `/` first, then not a second `/` or a `\`; no `\` or control character anywhere (a browser reads `\` as `/` and drops tabs
 *   and line breaks, which could make `//other.site`).
 * - After parsing: still on `origin`, and the path is not `//…` nor a `\` once decoded (offSitePath). The parser takes dot segments out, `%2e`
 *   included, so `/.//evil.example`, `/a/..//evil.example` or `/%2e//evil.example` become `//evil.example`: the check must look at what is
 *   returned, not only at what came in (fix round 1 of the review).
 * Absolute URLs are refused even when they name this site: the link is built from a path. The answer is the parsed path with its query and
 * fragment. The route checks the redirect it builds from it once more (same origin, or "/").
 */
export function previewPath(tee: string | null, origin: string): string {
  if (!tee || tee.length > PREVIEW_PATH_MAX || tee[0] !== "/" || tee[1] === "/" || tee.includes("\\")) return "/";
  for (let i = 0; i < tee.length; i++) {
    const code = tee.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return "/";
  }
  try {
    const url = new URL(tee, origin);
    if (url.origin !== origin || offSitePath(url.pathname)) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}

/** Clears the preview cookie on `res` (logout). */
export function clearPreviewCookie(res: NextResponse): void {
  res.cookies.set(PREVIEW_COOKIE, "", { ...previewCookieOptions, maxAge: 0 });
}

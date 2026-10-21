import type { NextResponse } from "next/server";
import { PREVIEW_COOKIE, PREVIEW_SECRET_MIN, PREVIEW_TTL_S, previewCookieOptions, previewKey, signPreview } from "@/lib/preview-cookie";
import { gateOn } from "@/lib/site-gate";
import { serverEnv } from "./env";
import { logFailure, logNote } from "./log";

// The admins' preview cookie of the coming-soon gate (lib/preview-cookie.ts, lib/site-gate.ts) on an answer: set at sign-in
// (api/auth/verify) and by "Vaata kodulehte" (api/admin/preview; the top line, and on a phone the menu's footer), cleared at logout (api/auth/logout).

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

/** Clears the preview cookie on `res` (logout). */
export function clearPreviewCookie(res: NextResponse): void {
  res.cookies.set(PREVIEW_COOKIE, "", { ...previewCookieOptions, maxAge: 0 });
}

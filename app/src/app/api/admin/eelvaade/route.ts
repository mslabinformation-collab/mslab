import { draftMode } from "next/headers";
import { NextResponse } from "next/server";
import { withAdmin } from "@/server/auth";
import { previewPath, setPreviewCookie } from "@/server/preview";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/eelvaade?tee=<path> — the draft layer's „Eelvaade ↗“ (admin UX pass, spec C3; README §1.8): a signed-in admin's preview of the
 * unpublished changes on the public page itself. It turns on Next's draft mode (its own cookie, `__prerender_bypass`, for this browser session),
 * in which the public pages read the drafts over live data and are rendered for her alone, never cached; it gives her the coming-soon gate's
 * preview cookie too (as api/admin/preview does), and sends her (303) to `tee`. A `tee` that is not a path of this site goes to the home page
 * (server/preview.ts previewPath): the link can never lead to another site.
 *
 * `?lopeta=1` (with or without `tee`) ends draft mode: the cookie is cleared, and she goes to `tee` or the home page as a visitor sees it. Draft
 * mode also ends when the browser is closed.
 *
 * Signed-in admins only (401 JSON otherwise): a visitor never gets draft mode. A GET, so the link works as a link (target _blank); from another
 * site it only turns on, or off, the admin's own preview. Never kept (`no-store`).
 */
export const GET = withAdmin(async (request) => {
  const url = new URL(request.url);
  const leave = url.searchParams.get("lopeta") === "1";
  const draft = await draftMode();
  if (leave) draft.disable();
  else draft.enable();
  // the second guard: the redirect itself must stay on this site, whatever previewPath let through
  const target = new URL(previewPath(url.searchParams.get("tee"), url.origin), url.origin);
  const res = NextResponse.redirect(target.origin === url.origin ? target : new URL("/", url.origin), 303);
  res.headers.set("cache-control", "no-store");
  if (!leave) await setPreviewCookie(res);
  return res;
});

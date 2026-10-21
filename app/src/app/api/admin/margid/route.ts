import { menuOf } from "@/components/admin/menu";
import { getDb } from "@/db/client";
import { adminCounts } from "@/db/queries/admin";
import { withAdmin } from "@/server/auth";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };

/**
 * GET /api/admin/margid — the admin menu's badges (admin UX pass B6), for the sidebar: the (panel) layout does not render again when the visitor moves
 * between pages, so the sidebar asks for them again after a client-side move and when the window comes back. 200
 * `{ ok: true, badges, hrefs, total, today }` is menu-state.ts MenuState: only the entries that have a badge, the filtered addresses their rows
 * open, the phone's sum and the card of today's session. The same numbers and the same function (menu.ts menuOf) as the shell's first paint.
 * Signed-in admins only (withAdmin: 401 otherwise); private and never kept; 500 `server` (logged, no data).
 */
export const GET = withAdmin(async (_request, _ctx, { email }) => {
  try {
    return Response.json({ ok: true, ...menuOf(await adminCounts(getDb(), email, new Date())) }, { headers });
  } catch (e) {
    logFailure("[admin] the menu's badges could not be read", e);
    return Response.json({ ok: false, error: "server" }, { status: 500, headers });
  }
});

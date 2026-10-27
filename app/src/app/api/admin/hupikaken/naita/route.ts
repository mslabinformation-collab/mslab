import { z } from "zod";
import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { logFailure } from "@/server/log";
import { switchPopup } from "@/server/site-drafts";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const switchBody = z.strictObject({ on: z.boolean(), version: z.string().max(200) });

/**
 * POST /api/admin/hupikaken/naita — Hüpikaken's „Lehel näidatakse“, instant (admin UX pass piece 4b, Task 3; S4-26; Review Focus 3): `{ on, version }`,
 * the version the screen read (server/site-drafts.ts readPopupSwitch, or the last press's answer: an undo sends that). It acts on the live row only
 * (switchPopup): on needs the live popup's title and picture; the offer's drafts never block it. 200 with the answer: `{ ok: true, version, stamp }`
 * (the row's new version, the database's clock after the commit: server/read-stamp.ts, null when it cannot be read), or refused, nothing changed:
 * `{ ok: false, missing }` (`Puudub: …` under the switch, e.g. `["pilt"]`) or `{ ok: false, error: "changed", stamp }` (another tab changed the
 * popup: „Hüpikakent muudeti vahepeal. Vaata see üle.“). 400 `{ ok: false, error: "body" }` for another body; 500 `{ ok: false, error: "server" }`,
 * logged. Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin(async (request) => {
  let body: z.infer<typeof switchBody>;
  try {
    const parsed = switchBody.safeParse(await request.json());
    if (!parsed.success) return json({ ok: false, error: "body" }, 400);
    body = parsed.data;
  } catch {
    return json({ ok: false, error: "body" }, 400);
  }
  try {
    return json(await switchPopup(getDb(), body.on, body.version, new Date()), 200);
  } catch (e) {
    logFailure("[admin] the popup: the switch failed", e);
    return json({ ok: false, error: "server" }, 500);
  }
});

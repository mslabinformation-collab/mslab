import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { createCertificateDesign } from "@/server/certificate-designs";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/tunnistuse-kujundus — „Lisa kujundus“ in Seaded → Tunnistus → „Kujundused“ (2026-11-11 certificate designs, spec §5.1): the one
 * explicit create of a design, light and without a photo, last, named „Uus kujundus“ (or „Uus kujundus {n}“; server/certificate-designs.ts
 * createCertificateDesign); its row then autosaves on /api/admin/tunnistuse-kujundus/<id>. 201 `{ ok: true, id }`; 500 `{ ok: false, error:
 * "server" }`, logged. Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin(async () => {
  try {
    const { id } = await createCertificateDesign(getDb());
    console.info(`[certificate] design ${id}: created`);
    return json({ ok: true, id }, 201);
  } catch (e) {
    logFailure("[certificate] a new design failed", e);
    return json({ ok: false, error: "server" }, 500);
  }
});

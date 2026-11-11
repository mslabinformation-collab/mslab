import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { DESIGN_PATCH, deleteCertificateDesign, readCertificateDesign, writeCertificateDesign } from "@/server/certificate-designs";
import { logFailure } from "@/server/log";
import { mediaStore } from "@/server/media-store";

export const dynamic = "force-dynamic";
/** A hung database or store call must not hold the function for the plan's default 300 s (R2 is given 10 s: server/r2.ts). */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const save = autosaveHandler({
  schema: DESIGN_PATCH,
  // (only its 404: the write reads the design again under its lock)
  read: (id) => readCertificateDesign(getDb(), id),
  write: (id, patch, version) => writeCertificateDesign(getDb(), id, patch, version, mediaStore()),
});

/**
 * POST /api/admin/tunnistuse-kujundus/<id> — a design row of Seaded → Tunnistus → „Kujundused“, autosaved (2026-11-11 certificate designs, spec
 * §5.1): `{ version, patch: { name?, tone?, backgroundKey? } }` from the row's version ("k:<hash>" of the three), answered by autosaveHandler
 * (server/autosave-route.ts: 200 the new version, 409 the stored fields, 400 by field — name required | tooLong | taken, tone invalid,
 * backgroundKey image —, 404 no such design). Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const id = parseRowId((await ctx.params).id);
  return id === null ? json({ ok: false, error: "notFound" }, 404) : save(request, id, admin);
});

/**
 * DELETE /api/admin/tunnistuse-kujundus/<id> — „Kustuta“ of a design (spec §5.1; server/certificate-designs.ts deleteCertificateDesign): 200 `{ ok:
 * true }`; 409 `{ ok: false, error: "inUse", courses }` while courses use it (live or in a draft; the first design also for an e-course with no
 * pick), 409 `{ ok: false, error: "last" }` for the last design; 404 `{ ok: false, error: "notFound" }` for none (deleted already); 500 `server`,
 * logged. Issued certificates keep their copy of its look. Signed-in admins only, a cross-site DELETE is 403 (withAdmin).
 */
export const DELETE = withAdmin<Ctx>(async (_request, ctx) => {
  const id = parseRowId((await ctx.params).id);
  if (id === null) return json({ ok: false, error: "notFound" }, 404);
  try {
    const done = await deleteCertificateDesign(getDb(), id);
    if (done.ok) {
      console.info(`[certificate] design ${id}: deleted`);
      return json({ ok: true }, 200);
    }
    if (done.error === "gone") return json({ ok: false, error: "notFound" }, 404);
    return json(done, 409);
  } catch (e) {
    logFailure(`[certificate] design ${id}: the delete failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

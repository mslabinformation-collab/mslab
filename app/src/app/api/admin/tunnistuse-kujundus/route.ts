import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { createCertificateDesign } from "@/server/certificate-designs";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The body: none (an empty POST) or `{ name? }`, the add row's name; anything else is no body this route takes. */
async function typedName(req: Request): Promise<{ ok: true; name: string | undefined } | { ok: false; field: boolean }> {
  const raw = await req.text().catch(() => "");
  if (raw.trim() === "") return { ok: true, name: undefined };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, field: false };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, field: false };
  const name = (body as { name?: unknown }).name;
  if (name === undefined) return { ok: true, name: undefined };
  return typeof name === "string" ? { ok: true, name } : { ok: false, field: true };
}

/**
 * POST /api/admin/tunnistuse-kujundus — „Lisa kujundus +“ in Seaded → Tunnistus → „Kujundused“ (2026-11-11 certificate designs, spec §5.1; the
 * dashed add row of the UX pass, 11.11 board 1): the one explicit create of a design, light and without a photo, last, named as the add row's
 * `{ name }` says (checked as a row's name) or, with none, „Uus kujundus“ (or „Uus kujundus {n}“; server/certificate-designs.ts
 * createCertificateDesign); its row then autosaves on /api/admin/tunnistuse-kujundus/<id>. 201 `{ ok: true, id }`; 400 `{ ok: false, error:
 * "invalid", fields: { name } }` for a name refused (required | tooLong | taken, or "invalid" for one that is no text) and `{ ok: false, error:
 * "invalid" }` for a body that is no object; 500 `{ ok: false, error: "server" }`, logged. Signed-in admins only, a cross-site POST is 403
 * (withAdmin).
 */
export const POST = withAdmin(async (req: Request) => {
  const typed = await typedName(req);
  if (!typed.ok) return json(typed.field ? { ok: false, error: "invalid", fields: { name: "invalid" } } : { ok: false, error: "invalid" }, 400);
  try {
    const made = await createCertificateDesign(getDb(), typed.name);
    if (!made.ok) return json({ ok: false, error: "invalid", fields: { name: made.error } }, 400);
    console.info(`[certificate] design ${made.id}: created`);
    return json({ ok: true, id: made.id }, 201);
  } catch (e) {
    logFailure("[certificate] a new design failed", e);
    return json({ ok: false, error: "server" }, 500);
  }
});

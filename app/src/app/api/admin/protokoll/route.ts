import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { handleSave } from "@/server/protocols";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

/**
 * POST /api/admin/protokoll — the protocol screen's autosave (phase protocols, spec §4): signed-in admins only, a cross-site POST is 403
 * (withAdmin). The body and the answers are server/protocols.ts handleSave's. /api/admin passes the coming-soon gate.
 */
export const POST = withAdmin(async (request) => handleSave(getDb(), request, new Date()));

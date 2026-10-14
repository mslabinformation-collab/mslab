import { getDb } from "@/db/client";
import { handleVerdict } from "@/server/assessment";
import { withAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

/**
 * POST /api/admin/hinnang — one verdict tap of Maria's assessment screen ("Kinnitatud" / "Paranda", phase e-course completion, spec §5.3, R2):
 * signed-in admins only, a cross-site POST is 403 (withAdmin). The body and the answers are server/assessment.ts handleVerdict's. /api/admin
 * passes the coming-soon gate.
 */
export const POST = withAdmin(async (request) => handleVerdict(getDb(), request, new Date()));

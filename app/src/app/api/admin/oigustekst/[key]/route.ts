import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { isLegalKey, LEGAL_IDS, LEGAL_KEYS, legalPatch, readLegal, writeLegalDraft, type LegalKey, type LegalPatch } from "@/server/legal-drafts";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ key: string }> };

/** One save handler per text: the patch's schema, the read and the write of its draft (server/legal-drafts.ts). A text is always there: never 404. */
const handlers = Object.fromEntries(
  LEGAL_KEYS.map((key) => [
    key,
    autosaveHandler<LegalPatch>({
      schema: legalPatch,
      read: () => readLegal(getDb(), key),
      write: (_id, patch, version, admin) => writeLegalDraft(getDb(), key, patch, version, admin),
    }),
  ]),
) as Record<LegalKey, ReturnType<typeof autosaveHandler>>;

const notFound = () => Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/oigustekst/<key> — a legal text's autosave into its draft (admin UX pass piece 3b, Task 5; README B4; ruling R-d): `{ version, patch }`
 * for privacy | terms | course_terms | contract_contact (the title, the text or both, in both languages), answered by autosaveHandler
 * (server/autosave-route.ts: 200 the draft's new version, 409 what is stored, 400 by field, 404 for a name that is no legal text). Nothing live is
 * written: „Avalda …“ is …/avalda. Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const { key } = await ctx.params;
  return isLegalKey(key) ? handlers[key](request, LEGAL_IDS[key], admin) : notFound();
});

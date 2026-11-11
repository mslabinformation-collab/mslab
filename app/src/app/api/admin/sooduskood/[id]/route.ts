import { getDb } from "@/db/client";
import { parseRowId } from "@/lib/row-id";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { CODE_PATCH, readCode, writeCode } from "@/server/discount-code-admin";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

const save = autosaveHandler<Record<string, unknown>>({
  schema: CODE_PATCH,
  // (only its 404: the write reads the code again under its lock)
  read: (id) => readCode(getDb(), id),
  // (the write revalidates the public pages once after its commit, for the welcome row only)
  write: (id, patch, version) => writeCode(getDb(), id, patch, version, new Date()),
});

/**
 * POST /api/admin/sooduskood/<id> — a discount code's fields, autosaved (F1 Task 13; the Sooduskoodid drawer): `{ version, patch: { code?, kind?, percent?,
 * amount?, scope?, courseIds?, startsOn?, endsOn?, maxUses?, audience?, oncePerPerson?, daysAfterSignup?, note? } }` from the code's version ("k:<hash>"),
 * answered by autosaveHandler (server/autosave-route.ts: 200 the new version, 409 the stored fields, 400 by field — each field's check over the stored row
 * merged with the patch (R16), the ceiling (R18), `codeUsed`, `codeTaken:<id>` decided under the code's lock —, 404 no such code). The switch „Aktiivne“ is
 * not a field here: it has its own instant action. Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const id = parseRowId((await ctx.params).id);
  return id === null ? Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } }) : save(request, id, admin);
});

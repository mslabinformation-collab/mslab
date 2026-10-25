import { z } from "zod";
import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { isLegalKey, publishLegal } from "@/server/legal-drafts";
import { logFailure } from "@/server/log";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ key: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const publishBody = z.object({ version: z.string().max(200) });

/**
 * POST /api/admin/oigustekst/<key>/avalda — „Avalda uus leping“ / „Avalda uus tekst“ of a legal text (admin UX pass piece 3b, Task 5; README B4, spec
 * C6): `{ version }`, the version the card's screen holds after its flush. The draft goes live through the text's existing writer (server/legal-drafts.ts
 * publishLegal: a new contract version exactly as a save made one, the pages revalidated). 200 `{ ok: true, version, value, live, changed }`: the text
 * as stored now; 409 `{ ok: false, error: "changed", version, value, live, changed }`: the text changed meanwhile, as stored now (P-11); 400
 * `{ ok: false, error: "invalid", fields }` by field, or `{ error: "body" }` for a body that is no publish; 404 for a name that is no legal text;
 * 500 `{ ok: false, error: "server" }`, logged. Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx) => {
  const { key } = await ctx.params;
  if (!isLegalKey(key)) return json({ ok: false, error: "notFound" }, 404);
  let body: z.infer<typeof publishBody>;
  try {
    const parsed = publishBody.safeParse(await request.json());
    if (!parsed.success) return json({ ok: false, error: "body" }, 400);
    body = parsed.data;
  } catch {
    return json({ ok: false, error: "body" }, 400);
  }
  try {
    const answer = await publishLegal(getDb(), key, body.version, new Date());
    if (answer.ok) return json({ ok: true, ...answer.state }, 200);
    if (answer.error === "changed") return json({ ok: false, error: "changed", ...answer.state }, 409);
    return json({ ok: false, error: "invalid", fields: answer.fields }, 400);
  } catch (e) {
    logFailure(`[legal] ${key}: the publish failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
});

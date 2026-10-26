import { z } from "zod";
import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { hasSitePart, isSiteEntity, SITE_ENTITY_ID, writeSitePart } from "@/server/site-drafts";

export const dynamic = "force-dynamic";
/** A hung database call must not hold the function for the plan's default 300 s. */
export const maxDuration = 30;

type Ctx = { params: Promise<{ entity: string; id: string; part: string }> };

/** The patch's shape: some fields by name. Which fields a part has, and their types and limits, are writeSitePart's (the part's schema and loose check). */
const patchSchema = z.record(z.string(), z.unknown());

/** The handler's `read` only says whether the part is there (its 404); the write reads the part itself, under the entity's lock. */
const FOUND = { version: "", value: null };

const notFound = () => Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/sisu/<entity>/0/osa/<part> — a site editor card's autosave into its part's draft (admin UX pass piece 4a, Task 1; README B2;
 * rulings R-a … R-d): `{ version, patch }` for Avaleht ("home": slides, statement, teaser, faq), Koolitaja ("trainer": trainer, bio, works,
 * center_story, trainer_journey) or Praktika ("practice": a package's code), from the part's version ("l:<hash>", or "d:<draft row id>.<n>"),
 * answered by autosaveHandler (server/autosave-route.ts: 200 the draft's new version, 409 what is stored, 400 by field, 404 for an entity, an id
 * other than 0 or a part that is none). Nothing live is written: „Avalda muudatused“ is …/avalda. Signed-in admins only, a cross-site POST is 403
 * (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const { entity, id, part } = await ctx.params;
  if (!isSiteEntity(entity) || id !== String(SITE_ENTITY_ID)) return notFound();
  const save = autosaveHandler<Record<string, unknown>>({
    schema: patchSchema,
    read: async () => ((await hasSitePart(getDb(), entity, part)) ? FOUND : null),
    write: (_id, patch, version, by) => writeSitePart(getDb(), entity, part, patch, version, by.email, new Date()),
  });
  return save(request, SITE_ENTITY_ID, admin);
});

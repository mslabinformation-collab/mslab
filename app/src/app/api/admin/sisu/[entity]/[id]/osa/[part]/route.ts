import { z } from "zod";
import { getDb } from "@/db/client";
import { withAdmin } from "@/server/auth";
import { autosaveHandler } from "@/server/autosave-route";
import { hasSitePart, parseSiteTarget, siteRowOf, writeSitePart } from "@/server/site-drafts";

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
 * POST /api/admin/sisu/<entity>/<id>/osa/<part> — a site editor card's autosave into its part's draft (admin UX pass piece 4a, Task 1; README B2;
 * rulings R-a … R-d): `{ version, patch }` for Avaleht ("home/0": slides, statement, teaser, faq), Koolitaja ("trainer/0": trainer, bio, works,
 * center_story, trainer_journey), Praktika ("practice/0": a package's code) or a post ("post/<the post's id>": its part `post`, piece 4b R-a; a post
 * that is not published saves straight to its row), from the part's version ("l:<hash>", or "d:<draft row id>.<n>"), answered by autosaveHandler
 * (server/autosave-route.ts: 200 the new version, 409 what is stored, 400 by field, 404 for an entity, an id or a part that is none: server/site-
 * drafts.ts parseSiteTarget). Nothing public is written: „Avalda muudatused“ is …/avalda. Signed-in admins only, a cross-site POST is 403 (withAdmin).
 */
export const POST = withAdmin<Ctx>(async (request, ctx, admin) => {
  const { entity, id, part } = await ctx.params;
  const target = parseSiteTarget(entity, id);
  if (!target) return notFound();
  const save = autosaveHandler<Record<string, unknown>>({
    schema: patchSchema,
    read: async () => ((await hasSitePart(getDb(), target, part)) ? FOUND : null),
    write: (_id, patch, version, by) => writeSitePart(getDb(), target, part, patch, version, by.email, new Date()),
  });
  return save(request, siteRowOf(target).id, admin);
});

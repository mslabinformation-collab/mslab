import { z, type ZodType } from "zod";
import type { SaveAnswer } from "@/domain/autosave";
import { logFailure } from "./log";

// The autosave routes' one contract (admin UX pass, spec C1; README §1.3, B1): an editor's form part is saved by a route handler, not a server
// action, so the page put away can send with keepalive and an ended session answers 401 (withAdmin) instead of a redirect. The route parses its
// id and calls the handler this helper makes, inside withAdmin:
//
//   const save = autosaveHandler({ schema, read, write });
//   export const POST = withAdmin(async (request, ctx: { params: Promise<{ id: string }> }, admin) => {
//     const id = parseRowId((await ctx.params).id);
//     return id === null ? Response.json({ ok: false, error: "notFound" }, { status: 404, headers: { "cache-control": "no-store" } }) : save(request, id, admin);
//   });
//
// The request is a POST of `{ version, patch }`; the answers (the engine's, components/admin/autosave/engine.ts):
// - 200 `{ ok: true, version, savedAt }`;
// - 409 `{ ok: false, error: "conflict", version, value }`: what is stored, which the screen shows („Taasta minu tekst“ saves over it);
// - 400 `{ ok: false, error: "invalid", fields }`: the field codes of the patch's schema (its messages) or of `write`; the screen holds those
//   fields back and saves the rest; 400 `{ ok: false, error: "body" }` for a body that is not a save;
// - 404 `{ ok: false, error: "notFound" }`: `read` found no row (gone);
// - 413 `{ ok: false, error: "size" }`: a body over AUTOSAVE_MAX_BYTES;
// - 500 `{ ok: false, error: "server" }`, logged without the text;
// - 401 and 403 come from withAdmin.
// Every answer is `cache-control: no-store`. The version check is `write`'s: a save from another version is answered with the stored value, and
// recognising a lost answer of its own is the engine's job (it remembers what it sent).

/** The biggest save body taken, in bytes: a part at its limits (a legal text of 30 000 characters per language, Cyrillic two bytes each) fits. */
export const AUTOSAVE_MAX_BYTES = 1_000_000;

const json = (body: unknown, status: number): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const saveBody = z.object({ version: z.string(), patch: z.record(z.string(), z.unknown()) });

/**
 * The schema's issues as one code per field (its first), or null when an issue names no field (not a patch of fields). Also a part's own check of
 * its whole value (server/course-parts.ts writeCoursePart).
 */
export function fieldCodes(issues: readonly z.core.$ZodIssue[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const names = issue.code === "unrecognized_keys" ? issue.keys : typeof issue.path[0] === "string" ? [issue.path[0]] : [];
    if (names.length === 0) return null;
    for (const n of names) if (!(n in out)) out[n] = issue.message;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function answer(a: SaveAnswer): Response {
  if (a.ok) return json({ ok: true, version: a.version, savedAt: a.savedAt }, 200);
  if (a.error === "conflict") return json({ ok: false, error: "conflict", version: a.version, value: a.value }, 409);
  return json({ ok: false, error: "invalid", fields: a.fields }, 400);
}

/**
 * A form part's save handler (see the top of the file): `schema` checks the patch, `read` says whether the row is there (null: 404), `write`
 * stores the patch from `version` and answers. Not a route itself: a route calls it inside withAdmin.
 */
export function autosaveHandler<P>(o: {
  schema: ZodType<P>;
  read: (id: number) => Promise<{ version: string; value: unknown } | null>;
  write: (id: number, patch: P, version: string, admin: { email: string }) => Promise<SaveAnswer>;
}): (request: Request, id: number, admin: { email: string }) => Promise<Response> {
  return async (request, id, admin) => {
    if (Number(request.headers.get("content-length") ?? "0") > AUTOSAVE_MAX_BYTES) return json({ ok: false, error: "size" }, 413);
    let value: unknown;
    try {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > AUTOSAVE_MAX_BYTES) return json({ ok: false, error: "size" }, 413);
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json({ ok: false, error: "body" }, 400);
    }
    const body = saveBody.safeParse(value);
    if (!body.success) return json({ ok: false, error: "body" }, 400);
    const patch = o.schema.safeParse(body.data.patch);
    if (!patch.success) {
      const fields = fieldCodes(patch.error.issues);
      return fields ? json({ ok: false, error: "invalid", fields }, 400) : json({ ok: false, error: "body" }, 400);
    }
    try {
      if ((await o.read(id)) === null) return json({ ok: false, error: "notFound" }, 404);
      return answer(await o.write(id, patch.data, body.data.version, admin));
    } catch (e) {
      logFailure(`[autosave] ${new URL(request.url).pathname}: the save of ${id} failed`, e);
      return json({ ok: false, error: "server" }, 500);
    }
  };
}

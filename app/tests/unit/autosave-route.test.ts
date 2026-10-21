import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { SaveAnswer } from "@/domain/autosave";
import { AUTOSAVE_MAX_BYTES, autosaveHandler } from "@/server/autosave-route";

// The autosave routes' helper (admin UX pass, spec C1; README §1.3): what a route that wraps it in withAdmin answers to a save of `{ version, patch }`.
// The answers are the engine's contract (components/admin/autosave/engine.ts): 200 the new version, 409 the stored value, 400 the field codes,
// 404 gone, 413 too big, and none of them is ever cached.

const admin = { email: "maria@example.test" };
const schema = z.object({ title: z.string().max(5, "tooLong"), body: z.string() }).partial().strict();
type Patch = z.infer<typeof schema>;

const post = (body: unknown) =>
  new Request("http://localhost/api/admin/salvesta/test/7", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

function setup(answer: SaveAnswer | Error, row: { version: string; value: unknown } | null = { version: "v1", value: { title: "Vana", body: "" } }) {
  const read = vi.fn<(id: number) => Promise<{ version: string; value: unknown } | null>>(async () => row);
  const write = vi.fn<(id: number, patch: Patch, version: string, admin: { email: string }) => Promise<SaveAnswer>>(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { read, write, handle: autosaveHandler<Patch>({ schema, read, write }) };
}

async function answerOf(res: Response) {
  return { status: res.status, cache: res.headers.get("cache-control"), body: await res.json() };
}

describe("autosaveHandler", () => {
  test("200 with the new version; 409 with the stored value; 400 with field codes; 413 over the size limit", async () => {
    const saved = setup({ ok: true, version: "v2", savedAt: "2026-10-21T08:00:00.000Z" });
    expect(await answerOf(await saved.handle(post({ version: "v1", patch: { title: "Uus" } }), 7, admin))).toEqual({
      status: 200,
      cache: "no-store",
      body: { ok: true, version: "v2", savedAt: "2026-10-21T08:00:00.000Z" },
    });
    expect(saved.read).toHaveBeenCalledWith(7);
    expect(saved.write).toHaveBeenCalledWith(7, { title: "Uus" }, "v1", admin);

    const conflict = setup({ ok: false, error: "conflict", version: "v3", value: { title: "Teine", body: "" } });
    expect(await answerOf(await conflict.handle(post({ version: "v1", patch: { title: "Uus" } }), 7, admin))).toEqual({
      status: 409,
      cache: "no-store",
      body: { ok: false, error: "conflict", version: "v3", value: { title: "Teine", body: "" } },
    });

    // the patch's own check: each field's code, nothing written
    const checked = setup({ ok: true, version: "v2", savedAt: "2026-10-21T08:00:00.000Z" });
    expect(await answerOf(await checked.handle(post({ version: "v1", patch: { title: "Liiga pikk", body: 5 } }), 7, admin))).toEqual({
      status: 400,
      cache: "no-store",
      body: { ok: false, error: "invalid", fields: { title: "tooLong", body: expect.any(String) } },
    });
    // a field the patch does not have is named too (the engine holds it back and saves the rest)
    expect((await answerOf(await checked.handle(post({ version: "v1", patch: { title: "Uus", other: "x" } }), 7, admin))).body).toMatchObject({ error: "invalid", fields: { other: expect.any(String) } });
    expect(checked.write).not.toHaveBeenCalled();

    // the writer's own check
    const refused = setup({ ok: false, error: "invalid", fields: { body: "text" } });
    expect(await answerOf(await refused.handle(post({ version: "v1", patch: { body: "\u0000" } }), 7, admin))).toEqual({
      status: 400,
      cache: "no-store",
      body: { ok: false, error: "invalid", fields: { body: "text" } },
    });

    // over 1 MB (in bytes: two a letter here) is refused before anything is read
    const big = setup({ ok: true, version: "v2", savedAt: "2026-10-21T08:00:00.000Z" });
    const body = JSON.stringify({ version: "v1", patch: { body: "õ".repeat(AUTOSAVE_MAX_BYTES / 2) } });
    expect(body.length).toBeLessThan(AUTOSAVE_MAX_BYTES); // (characters: under; bytes: over)
    expect(await answerOf(await big.handle(post(body), 7, admin))).toEqual({ status: 413, cache: "no-store", body: { ok: false, error: "size" } });
    expect(big.read).not.toHaveBeenCalled();
    expect(big.write).not.toHaveBeenCalled();
    // just under the limit is taken
    const under = JSON.stringify({ version: "v1", patch: { body: "" } });
    const fits = JSON.stringify({ version: "v1", patch: { body: "a".repeat(AUTOSAVE_MAX_BYTES - under.length) } });
    expect((await big.handle(post(fits), 7, admin)).status).toBe(200);
  });

  test("404 when the row is gone; 400 for a body that is not a save; a failed write is a 500; never cached", async () => {
    const gone = setup({ ok: true, version: "v2", savedAt: "2026-10-21T08:00:00.000Z" }, null);
    expect(await answerOf(await gone.handle(post({ version: "v1", patch: { title: "Uus" } }), 7, admin))).toEqual({ status: 404, cache: "no-store", body: { ok: false, error: "notFound" } });
    expect(gone.write).not.toHaveBeenCalled();

    const h = setup({ ok: true, version: "v2", savedAt: "2026-10-21T08:00:00.000Z" });
    for (const bad of ["{", "null", JSON.stringify({ patch: { title: "Uus" } }), JSON.stringify({ version: 1, patch: {} }), JSON.stringify({ version: "v1", patch: [] })]) {
      expect(await answerOf(await h.handle(post(bad), 7, admin))).toEqual({ status: 400, cache: "no-store", body: { ok: false, error: "body" } });
    }
    expect(h.write).not.toHaveBeenCalled();

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = setup(new Error("connection lost"));
    expect(await answerOf(await broken.handle(post({ version: "v1", patch: { title: "Uus" } }), 7, admin))).toEqual({ status: 500, cache: "no-store", body: { ok: false, error: "server" } });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { settings } from "@/db/schema";
import { createSession } from "@/server/auth";
import { sendTelegram } from "@/server/notify";
import { makeTestDb } from "./helpers";

// /api/admin/testplan (phase 4, piece 1, spec §5): the plan and everybody's answers for the signed-in admins (GET), and their saves (PUT), a Viga
// sent on to Telegram after the answer. The database is PGlite, the session cookie (next/headers) is faked, `after` collects the work that
// runs after the answer and Telegram is a mock; the plan is a small fixture.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined, later: [] as (() => unknown)[] }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => void state.later.push(task),
}));
vi.mock("@/server/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notify")>()),
  sendTelegram: vi.fn(async () => true),
}));
const FIXTURE = vi.hoisted(() => {
  const item = (id: string, who: string, title: string) => ({
    id, area: "avalik", who, device: "any", title, steps: ["Tee seda."], expect: ["Näed seda."], why: "Sest.", risk: "med", writes: false,
  });
  return {
    version: 1,
    marked: "2026-10-16T00:00:00.000Z",
    areas: [{ id: "avalik", name: "Avalik leht" }],
    items: [item("maria-1", "maria", "Avaleht telefonis"), item("maria-2", "maria", "Kursuse leht"), item("dim-1", "dim", "Maksed")],
  };
});
vi.mock("@/data/testplan.json", () => ({ default: FIXTURE }));

import { GET, PUT } from "@/app/api/admin/testplan/route";

const ORIGIN = "https://mslab.ee";
const URL_ = `${ORIGIN}/api/admin/testplan`;
const MARIA = "maria@example.test";
const DIM = "dim@example.test";

let db: Db;
beforeAll(async () => {
  db = await makeTestDb();
});
beforeEach(async () => {
  state.db = db;
  state.cookie = undefined;
  state.later = [];
  await db.delete(settings);
  vi.stubEnv("ADMIN_EMAILS", `${MARIA},${DIM}`);
  vi.stubEnv("ADMIN_NAMES", `${MARIA}=Maria Sosnina,${DIM}=Dim`);
  vi.stubEnv("SITE_URL", "https://site.example.test");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(sendTelegram).mockReset();
  vi.mocked(sendTelegram).mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const signIn = async (email = MARIA) => {
  state.cookie = await createSession(db, email);
};
const put = (body: unknown, headers: Record<string, string> = {}) =>
  PUT(new Request(URL_, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }), undefined);
const get = () => GET(new Request(URL_), undefined);
/** Runs what the route handed to `after` (the Telegram sends). */
const runLater = async () => {
  const tasks = state.later.splice(0);
  for (const task of tasks) await task();
};
const stored = async () => (await db.select().from(settings))[0]?.value as { answers: Record<string, { status: string; note: string; by: string; pinged?: string; notePinged?: boolean }> } | undefined;

describe("without a session, or from another site", () => {
  test("GET and PUT: 401 JSON, nothing stored", async () => {
    for (const res of [await get(), await put({ answers: { "maria-1": { status: "ok", note: "" } } })]) {
      expect([res.status, await res.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
    }
    expect(await stored()).toBeUndefined();
  });

  test("a PUT that names another site as its origin: 403, nothing stored, nothing sent", async () => {
    await signIn();
    const res = await put({ answers: { "maria-1": { status: "bad", note: "" } } }, { origin: "https://evil.example" });
    expect([res.status, await res.json()]).toEqual([403, { ok: false, error: "forbidden" }]);
    expect(await stored()).toBeUndefined();
    expect(state.later).toEqual([]);
  });
});

describe("GET", () => {
  test("{ ok, plan, answers, auto, you }, never cached", async () => {
    await signIn();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, plan: FIXTURE, answers: {}, auto: {}, you: { name: "Maria", tester: "maria" } });
  });

  test("everybody's answers as the page gets them: with the answerer's first name, never an address", async () => {
    await signIn();
    await put({ answers: { "maria-1": { status: "ok", note: "hea" } } });
    state.cookie = await createSession(db, DIM);
    await put({ answers: { "dim-1": { status: "skip", note: "" } } });
    const res = await get();
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      answers: {
        "maria-1": { status: "ok", note: "hea", byName: "Maria" },
        "dim-1": { status: "skip", note: "", byName: "Dim" },
      },
      you: { name: "Dim", tester: "dim" },
    });
    expect(text).not.toContain("@");
    expect(text).not.toContain('"by"');
  });

  test("an admin who is neither Maria nor Dim: no name, no tester (the page shows every check as Kõik)", async () => {
    vi.stubEnv("ADMIN_EMAILS", `${MARIA},${DIM},kati@example.test`);
    await signIn("kati@example.test");
    expect(((await (await get()).json()) as { you: unknown }).you).toEqual({ name: "", tester: null });
  });
});

// Dim 25.10: a third tester, „Automaattest“ (its address in ADMIN_EMAILS, `<address>=Automaattest` in ADMIN_NAMES), whose answers stay apart.
describe("Automaattest", () => {
  const AUTO = "auto@example.test";
  beforeEach(() => {
    vi.stubEnv("ADMIN_EMAILS", `${MARIA},${DIM},${AUTO}`);
    vi.stubEnv("ADMIN_NAMES", `${MARIA}=Maria Sosnina,${DIM}=Dim,${AUTO}=Automaattest`);
  });

  test("its PUT is stored in `auto` and comes back as its own answers; Maria's answers and her GET are as before, with its answers apart in `auto`", async () => {
    await signIn(MARIA);
    await put({ answers: { "maria-1": { status: "ok", note: "" } } });
    await signIn(AUTO);
    expect(((await (await get()).json()) as { you: unknown }).you).toEqual({ name: "Automaattest", tester: "auto" });
    const res = await put({ answers: { "maria-1": { status: "skip", note: "" }, "dim-1": { status: "ok", note: "" } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      answers: { "maria-1": { status: "skip", byName: "Automaattest" }, "dim-1": { status: "ok", byName: "Automaattest" } },
    });
    const row = (await stored()) as unknown as { answers: Record<string, { status: string; by: string }>; auto: Record<string, { status: string; by: string }> };
    expect(row.answers).toEqual({ "maria-1": expect.objectContaining({ status: "ok", by: MARIA }) });
    expect(row.auto).toEqual({ "maria-1": expect.objectContaining({ status: "skip", by: AUTO }), "dim-1": expect.objectContaining({ status: "ok", by: AUTO }) });

    await signIn(MARIA);
    const text = await (await get()).text();
    expect(JSON.parse(text)).toMatchObject({
      answers: { "maria-1": { status: "ok", byName: "Maria" } },
      auto: { "maria-1": { status: "skip", byName: "Automaattest" }, "dim-1": { status: "ok", byName: "Automaattest" } },
      you: { name: "Maria", tester: "maria" },
    });
    expect(Object.keys((JSON.parse(text) as { answers: object }).answers)).toEqual(["maria-1"]);
    expect(text).not.toContain("@");
  });

  test("its Viga is sent to Telegram as Automaattest's; its OK with a note sends nothing", async () => {
    await signIn(AUTO);
    await put({ answers: { "maria-1": { status: "ok", note: "korras" } } });
    expect(state.later).toEqual([]);
    await put({ answers: { "maria-2": { status: "bad", note: "pilt puudub" } } });
    await runLater();
    expect(vi.mocked(sendTelegram).mock.calls.map((c) => c[1])).toEqual(["Testimine — Viga: Kursuse leht (Automaattest)\npilt puudub\nhttps://site.example.test/admin/testimine#maria-2"]);
  });
});

describe("PUT", () => {
  const ok = { answers: { "maria-1": { status: "ok", note: "" } } };

  test("a body over 128 KB: 413 tooLarge, nothing stored (by its text, and by its declared length)", async () => {
    await signIn();
    const big = JSON.stringify({ answers: { "maria-1": { status: "ok", note: "x".repeat(129 * 1024) } } });
    expect(Buffer.byteLength(big)).toBeGreaterThan(128 * 1024);
    const res = await put(big);
    expect([res.status, await res.json()]).toEqual([413, { ok: false, error: "tooLarge" }]);
    const declared = await put(ok, { "content-length": String(129 * 1024) });
    expect([declared.status, await declared.json()]).toEqual([413, { ok: false, error: "tooLarge" }]);
    expect(await stored()).toBeUndefined();
  });

  test("a body of no declared length (sent in chunks) over 128 KB: 413 tooLarge, and it is read no further than the cap", async () => {
    await signIn();
    const CHUNK = 64 * 1024;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 8 * 1024 * 1024) return controller.close();
        pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
      },
    });
    const request = new Request(URL_, { method: "PUT", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    const res = await PUT(request, undefined);
    expect([res.status, await res.json()]).toEqual([413, { ok: false, error: "tooLarge" }]);
    expect(pulled).toBeLessThan(1024 * 1024); // (of 8 MB on offer)
    expect(await stored()).toBeUndefined();
  });

  test("a body of exactly 128 KB is read", async () => {
    await signIn();
    const pad = (n: number) => JSON.stringify({ answers: { "maria-1": { status: "ok", note: "" } }, pad: "x".repeat(n) });
    const fixed = Buffer.byteLength(pad(0));
    const exact = pad(128 * 1024 - fixed);
    expect(Buffer.byteLength(exact)).toBe(128 * 1024);
    expect((await put(exact)).status).toBe(200);
  });

  test.each([
    { name: "answers a list", body: { answers: [] } },
    { name: "a status that is none of ok, bad, skip", body: { answers: { "maria-1": { status: "maybe", note: "" } } } },
    { name: "no answers", body: {} },
    { name: "JSON that is a list", body: [] },
    { name: "text that is no JSON", body: "{ not json" },
    { name: "an empty body", body: "" },
  ])("400 invalid, nothing stored: $name", async ({ body }) => {
    await signIn();
    const res = await put(body);
    expect([res.status, await res.json()]).toEqual([400, { ok: false, error: "invalid" }]);
    expect(await stored()).toBeUndefined();
    expect(state.later).toEqual([]);
  });

  test("an answer is stored by the session's e-mail and comes back merged, in the page's form, never cached", async () => {
    await signIn(DIM);
    await put({ answers: { "dim-1": { status: "ok", note: "" } } });
    state.cookie = await createSession(db, MARIA);
    const res = await put({ answers: { "maria-1": { status: "ok", note: "  hea  " } } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      answers: { "maria-1": { status: "ok", note: "hea", byName: "Maria" }, "dim-1": { status: "ok", note: "", byName: "Dim" } },
    });
    expect(text).not.toContain("@");
    expect((await stored())?.answers["maria-1"]).toMatchObject({ by: MARIA, note: "hea" });
    expect(state.later).toHaveLength(1); // the first note on an OK is a message (Dim 22.10); Dim's OK without a note is none
  });

  test("an OK or a Jäta vahele without a note: stored, no message, nothing scheduled", async () => {
    await signIn();
    const res = await put({ answers: { "maria-1": { status: "ok", note: "" }, "maria-2": { status: "skip", note: "  " } } });
    expect(res.status).toBe(200);
    expect(state.later).toEqual([]);
  });

  test("a Viga: stored, and after the answer Telegram is sent the text with the check's title, the answerer's first name and a link to #<id>", async () => {
    await signIn();
    const res = await put({ answers: { "maria-1": { status: "bad", note: "nupp ei tööta" } } });
    expect(res.status).toBe(200);
    expect(await stored()).toMatchObject({ answers: { "maria-1": { status: "bad", note: "nupp ei tööta", by: MARIA } } });
    expect(sendTelegram).not.toHaveBeenCalled(); // not before the answer
    expect(state.later).toHaveLength(1);
    await runLater();
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const [env, text] = vi.mocked(sendTelegram).mock.calls[0];
    expect(text).toBe("Testimine — Viga: Avaleht telefonis (Maria)\nnupp ei tööta\nhttps://site.example.test/admin/testimine#maria-1");
    expect(text).not.toContain("@");
    expect(env).toMatchObject({ SITE_URL: "https://site.example.test" });
    // the record that it was announced went in with the answer
    expect((await stored())?.answers["maria-1"]).toMatchObject({ notePinged: true });
    expect((await stored())?.answers["maria-1"].pinged).toEqual(expect.any(String));
  });

  test("the link is built on the address the admin works on when it is one of ours", async () => {
    await signIn();
    await put({ answers: { "maria-1": { status: "bad", note: "" } } }, { origin: ORIGIN });
    await runLater();
    expect(vi.mocked(sendTelegram).mock.calls[0][1]).toBe(
      "Testimine — Viga: Avaleht telefonis (Maria)\n(märkust veel pole)\nhttps://mslab.ee/admin/testimine#maria-1",
    );
  });

  test("the note of that Viga is one more message, once; further edits send nothing", async () => {
    await signIn();
    for (const note of ["", "esimene märkus", "teine märkus"]) {
      await put({ answers: { "maria-1": { status: "bad", note } } });
      await runLater();
    }
    const texts = vi.mocked(sendTelegram).mock.calls.map(([, text]) => text);
    expect(texts).toEqual([
      "Testimine — Viga: Avaleht telefonis (Maria)\n(märkust veel pole)\nhttps://site.example.test/admin/testimine#maria-1",
      "Testimine — Märkus: Avaleht telefonis (Maria) · Viga\nesimene märkus\nhttps://site.example.test/admin/testimine#maria-1",
    ]);
  });

  test("a Viga pressed on an OK with a note: the first message says there is no note yet, and the note typed next goes as the second", async () => {
    await signIn();
    for (const [status, note] of [["ok", "Tahvlis korras"], ["bad", "Tahvlis korras"], ["bad", "Nupp ei tööta"]]) {
      await put({ answers: { "maria-1": { status, note } } });
      await runLater();
    }
    expect(vi.mocked(sendTelegram).mock.calls.map(([, text]) => text)).toEqual([
      "Testimine — Märkus: Avaleht telefonis (Maria) · OK\nTahvlis korras\nhttps://site.example.test/admin/testimine#maria-1", // (the OK's own first note, Dim 22.10)
      "Testimine — Viga: Avaleht telefonis (Maria)\n(märkust veel pole)\nhttps://site.example.test/admin/testimine#maria-1",
      "Testimine — Märkus: Avaleht telefonis (Maria) · Viga\nNupp ei tööta\nhttps://site.example.test/admin/testimine#maria-1",
    ]);
  });

  // Dim 22.10: every answer has a note box, and the first note on any answer is a message in the same format, with the answer shown.
  test("the first note on an OK is one message, once; the note typed on a Jäta vahele too", async () => {
    await signIn();
    for (const [id, status, note] of [
      ["maria-1", "ok", ""],
      ["maria-1", "ok", "Telefonis korras"],
      ["maria-1", "ok", "Telefonis korras, tahvlis ka"],
      ["maria-2", "skip", ""],
      ["maria-2", "skip", "Hiljem"],
    ]) {
      await put({ answers: { [id]: { status, note } } });
      await runLater();
    }
    expect(vi.mocked(sendTelegram).mock.calls.map(([, text]) => text)).toEqual([
      "Testimine — Märkus: Avaleht telefonis (Maria) · OK\nTelefonis korras\nhttps://site.example.test/admin/testimine#maria-1",
      "Testimine — Märkus: Kursuse leht (Maria) · Jäta vahele\nHiljem\nhttps://site.example.test/admin/testimine#maria-2",
    ]);
  });

  test("several Vead in one save: one message each, in the order sent", async () => {
    await signIn();
    await put({ answers: { "dim-1": { status: "bad", note: "a" }, "maria-1": { status: "bad", note: "b" }, "maria-2": { status: "ok", note: "" } } });
    await runLater();
    expect(vi.mocked(sendTelegram).mock.calls.map(([, text]) => text.split("\n")[0])).toEqual([
      "Testimine — Viga: Maksed (Maria)",
      "Testimine — Viga: Avaleht telefonis (Maria)",
    ]);
  });

  test("a send that fails (false, or an error) is logged with the check's id, never changes the answer, and the other messages still go", async () => {
    await signIn();
    vi.mocked(sendTelegram).mockResolvedValueOnce(false).mockRejectedValueOnce(Object.assign(new Error("secret bot token 123:abc"), { name: "FetchError" }));
    const res = await put({ answers: { "maria-1": { status: "bad", note: "a" }, "maria-2": { status: "bad", note: "b" }, "dim-1": { status: "bad", note: "c" } } });
    expect(res.status).toBe(200);
    await runLater();
    expect(sendTelegram).toHaveBeenCalledTimes(3);
    const logged = vi.mocked(console.error).mock.calls.flat().map(String);
    expect(logged).toEqual(["[testplan] a Telegram message failed (check maria-1)", "[testplan] a Telegram message failed (check maria-2): FetchError"]);
    expect(logged.join("\n")).not.toContain("secret");
    expect(Object.keys((await stored())?.answers ?? {}).sort()).toEqual(["dim-1", "maria-1", "maria-2"]);
  });

  test("the log of a save holds counts only", async () => {
    await signIn();
    await put({ answers: { "maria-1": { status: "bad", note: "hirmus saladus" } } });
    await runLater();
    const logged = [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls].flat().map(String).join("\n");
    expect(logged).toContain("[testplan] saved 1 answers, 1 messages");
    expect(logged).not.toContain("saladus");
    expect(logged).not.toContain("@");
  });
});

describe("a database that fails on the answers", () => {
  // (a database that is down altogether fails the session lookup first, which is withAdmin's: a plain error, not this route's 503)
  const boom = () => new Error("connect ECONNREFUSED postgres://user:secret@db/mslab");
  /** The real database, except that the answers' query fails: the read (the second `select`, after the session's) or the save's transaction. */
  const failing = (what: "select" | "transaction"): Db => {
    let selects = 0;
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select" && what === "select" && ++selects > 1) throw boom();
        if (prop === "transaction" && what === "transaction") throw boom();
        return Reflect.get(target, prop, receiver);
      },
    });
  };

  test("GET: 503 unavailable, with the plan so that the page can still show it; no answers", async () => {
    await signIn();
    state.db = failing("select");
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: false, error: "unavailable", plan: FIXTURE, answers: null, you: { name: "Maria", tester: "maria" } });
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).not.toContain("secret");
  });

  test("PUT: 503 unavailable, nothing sent, the failure logged without its message", async () => {
    await signIn();
    state.db = failing("transaction");
    const res = await put({ answers: { "maria-1": { status: "bad", note: "" } } });
    expect([res.status, await res.json()]).toEqual([503, { ok: false, error: "unavailable" }]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.later).toEqual([]);
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).toContain("[testplan]");
    expect(logged).not.toContain("secret");
  });
});

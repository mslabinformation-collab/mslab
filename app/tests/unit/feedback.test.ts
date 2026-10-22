import { afterEach, describe, expect, test, vi } from "vitest";
import {
  commentPlace,
  createComment,
  FEEDBACK_RATE_LIMIT,
  isAdminPath,
  isSitePath,
  listComments,
  MAX_BYTES,
  newId,
  placeLink,
  readBody,
  setDone,
  type Comment,
  type FeedbackEnv,
  type FeedbackKv,
} from "@/server/feedback";
import { DEV_REVIEW_KEY, keyMatches, reviewKey } from "@/server/review-key";
import { fakeKv, stubFetch } from "../fakes";

// The review comment API (src/server/feedback.ts): the old review Worker's contract (retired 03.10.2026) inside the app.

const ORIGIN = "https://mslab.example";
const KEY = "test-admin-key-0123456789";
const NOW = new Date("2026-10-02T08:00:00.000Z");

/** fakeKv plus list() (paged, like KV: `limit` keys per page), and a switch that makes every put fail. */
function kv(initial: Record<string, string> = {}, limit = 1000) {
  const base = fakeKv(initial);
  let failPuts = false;
  const store: FeedbackKv & { store: Map<string, string>; ttl: Map<string, number | undefined>; failPuts(on: boolean): void } = {
    store: base.store,
    ttl: base.ttl,
    get: base.get,
    async put(key, value, opts) {
      if (failPuts) throw new Error("KV put failed: fb:… holds a name");
      return base.put(key, value, opts);
    },
    async list({ prefix, cursor }) {
      const names = [...base.store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const keys = names.slice(start, start + limit).map((name) => ({ name }));
      const end = start + keys.length;
      return end < names.length ? { keys, list_complete: false, cursor: String(end) } : { keys, list_complete: true };
    },
    failPuts(on) {
      failPuts = on;
    },
  };
  return store;
}

const env = (k = kv(), extra: Partial<FeedbackEnv> = {}): FeedbackEnv => ({
  KV: k,
  MAIL_FROM: "MS LAB <info@send.example>",
  MARIA_EMAIL: "maria@example.com",
  SITE_URL: ORIGIN,
  ...extra,
});

const post = (e: FeedbackEnv, body: unknown, ip: string | null = "203.0.113.7") =>
  createComment({ env: e, origin: ORIGIN, ip, now: NOW }, typeof body === "string" ? body : JSON.stringify(body));

const records = (k: ReturnType<typeof kv>) => [...k.store].filter(([key]) => key.startsWith("fb:")).map(([, v]) => JSON.parse(v) as Comment);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/feedback", () => {
  test("stores the old review Worker's record under fb:<at>:<id> and id:<id>", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const k = kv();
    const r = await post(env(k), {
      dir: "d",
      route: "#/koolitused",
      title: "Koolitused",
      device: "desk",
      width: 1440.4,
      name: " Maria ",
      mood: "change",
      text: "  Suurem pealkiri  ",
      el: { label: "Koolitused", snippet: "Kõik koolitused", sel: "body > main:nth-of-type(1)", y: 120.6, h: 80 },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, stored: true, telegram: false });
    const id = r.body.id as string;
    expect(id).toMatch(/^[a-z0-9]{14}$/);
    const key = `fb:${NOW.toISOString()}:${id}`;
    expect(k.store.get(`id:${id}`)).toBe(key);
    expect(JSON.parse(k.store.get(key)!)).toEqual({
      id,
      at: NOW.toISOString(),
      name: "Maria",
      dir: "d",
      route: "#/koolitused",
      title: "Koolitused",
      device: "desk",
      width: 1440,
      mood: "change",
      text: "Suurem pealkiri",
      el: { label: "Koolitused", snippet: "Kõik koolitused", sel: "body > main:nth-of-type(1)", y: 121, h: 80 },
      done: false,
    });
  });

  test("a main-site comment keeps its page path; anything that is not a same-site path is dropped", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const k = kv();
    await post(env(k), { dir: "site", route: "/koolitused/kulmumeister", text: "a" });
    for (const route of ["//evil.example/x", "@evil.example", "https://evil.example", "#/x", "/a b", "/x?y=1", "/\\evil.example"]) await post(env(k), { dir: "site", route, text: route });
    const site = records(k);
    expect(site.find((r) => r.text === "a")?.route).toBe("/koolitused/kulmumeister");
    expect(site.filter((r) => r.text !== "a").map((r) => r.route)).toEqual(new Array(7).fill(undefined));
  });

  // Dim 22.10: the comment bubble is on the admin's pages too, and its comments say "admin"
  test("an admin comment keeps its /admin page path; anything that is not an /admin path is dropped", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const k = kv();
    await post(env(k), { dir: "admin", route: "/admin/koolitused/3", text: "a" });
    await post(env(k), { dir: "admin", route: "/admin", text: "b" });
    for (const route of ["/koolitused", "/administrator", "//admin", "/admin?x=1", "/admin/a b", "https://evil.example/admin", "#/admin", "/\\admin"])
      await post(env(k), { dir: "admin", route, text: route });
    const all = records(k);
    expect(all.find((r) => r.text === "a")).toMatchObject({ dir: "admin", route: "/admin/koolitused/3" });
    expect(all.find((r) => r.text === "b")).toMatchObject({ dir: "admin", route: "/admin" });
    const dropped = all.filter((r) => r.text !== "a" && r.text !== "b");
    expect(dropped).toHaveLength(8);
    for (const r of dropped) {
      expect(r.dir, r.text).toBe("admin");
      expect(r.route, r.text).toBeUndefined();
    }
  });

  test("unknown direction, device and mood fall back as before; long fields are cut", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const k = kv();
    await post(env(k), { dir: "toString", device: "watch", mood: "__proto__", name: "n".repeat(100), text: "t".repeat(5000), el: "x" });
    const [rec] = records(k);
    expect(rec).toMatchObject({ dir: "hub", name: "n".repeat(60), el: {} });
    expect(rec.device).toBeUndefined();
    expect(rec.mood).toBeUndefined();
    expect(rec.text).toHaveLength(4000);
  });

  test("no body, not JSON, not an object or no text → 400; nothing stored", async () => {
    const k = kv();
    for (const body of ["", "{", "null", "[1]", '"text"', JSON.stringify({ text: "   " }), JSON.stringify({ name: "x" })]) {
      const r = await post(env(k), body);
      expect(r.status, body).toBe(400);
      expect(r.body.ok).toBe(false);
    }
    expect(k.store.size).toBe(0);
  });

  test("a body over the limit → 413", async () => {
    expect((await createComment({ env: env(), origin: ORIGIN, ip: "x", now: NOW }, null)).status).toBe(413);
  });

  test("honeypot: success answer, nothing stored, nothing sent", async () => {
    const f = stubFetch();
    const k = kv();
    const r = await post(env(k, { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" }), { text: "spam", website: "http://spam" });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(k.store.size).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  test(`${FEEDBACK_RATE_LIMIT} comments per 10 minutes per visitor, then 429; another visitor is not affected`, async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const k = kv();
    for (let i = 0; i < FEEDBACK_RATE_LIMIT; i++) expect((await post(env(k), { text: `c${i}` }, "2001:db8:1:2::1")).status).toBe(200);
    expect(await post(env(k), { text: "one more" }, "2001:db8:1:2::1")).toEqual({ status: 429, body: { ok: false, error: "rate" } });
    expect(k.ttl.get("rl:feedback:2001:db8:1:2::1")).toBe(600);
    expect((await post(env(k), { text: "other" }, "198.51.100.1")).status).toBe(200);
    expect(records(k)).toHaveLength(FEEDBACK_RATE_LIMIT + 1);
  });

  test("Telegram gets the comment with its 'Näita kohta' link (main site: the page itself)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const f = stubFetch(() => Response.json({ ok: true }));
    const r = await post(env(kv(), { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" }), {
      dir: "site",
      route: "/koolitused",
      title: "Koolitused",
      device: "mob",
      width: 390,
      name: "Maria",
      mood: "good",
      text: "Ilus!",
      el: { label: "Kõik koolitused", snippet: "Kõik koolitused" },
    });
    expect(r.body).toMatchObject({ ok: true, stored: true, telegram: true });
    expect(f.calls).toHaveLength(1);
    const msg = (f.calls[0].body as { text: string }).text;
    expect(msg).toBe(
      "💬 Maria — kommentaar\nPõhileht · Koolitused\nSeade: telefon 390px\nHinnang: Meeldib\nKoht: Kõik koolitused\n\nIlus!\n\n" +
        `Näita kohta: ${ORIGIN}/koolitused?fb=${r.body.id}`,
    );
  });

  test("Telegram names an admin page's comment 'Haldus' and links to that admin page", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const f = stubFetch(() => Response.json({ ok: true }));
    const r = await post(env(kv(), { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" }), {
      dir: "admin",
      route: "/admin/koolitused",
      title: "Koolitused",
      device: "desk",
      width: 1280,
      name: "Maria",
      text: "Nupp võiks olla suurem",
    });
    expect(r.body).toMatchObject({ ok: true, stored: true, telegram: true });
    expect((f.calls[0].body as { text: string }).text).toBe(
      "💬 Maria — kommentaar\nHaldus · Koolitused\nSeade: arvuti 1280px\n\nNupp võiks olla suurem\n\n" + `Näita kohta: ${ORIGIN}/admin/koolitused?fb=${r.body.id}`,
    );
  });

  test("storage failing but Telegram working → 200 stored:false; both failing → 502; the log has no comment data", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const k = kv();
    k.failPuts(true);
    stubFetch(() => Response.json({ ok: true }));
    const ok = await post(env(k, { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" }), { text: "Privaatne tekst", name: "Maria" }, null);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, stored: false, telegram: true });
    const bad = await post(env(k), { text: "Privaatne tekst", name: "Maria" }, null);
    expect(bad).toEqual({ status: 502, body: { ok: false } });
    const logged = [...error.mock.calls, ...vi.mocked(console.info).mock.calls].flat().join(" ");
    expect(logged).not.toMatch(/Privaatne|Maria|holds a name/);
  });
});

describe("links ('Näita kohta')", () => {
  test("hub, prototype and main-site comments", () => {
    expect(placeLink(ORIGIN, { id: "abc123", dir: "hub" })).toBe(`${ORIGIN}/guide/?fb=abc123`);
    expect(placeLink(ORIGIN, { id: "abc123", dir: "d", device: "mob", route: "#/koolitused" })).toBe(
      `${ORIGIN}/guide/?fb=abc123#vaade=d&seade=mob&leht=%23%2Fkoolitused`,
    );
    expect(placeLink(ORIGIN, { id: "abc123", dir: "c" })).toBe(`${ORIGIN}/guide/?fb=abc123#vaade=c&seade=desk`);
    expect(placeLink(ORIGIN, { id: "abc123", dir: "site", route: "/ru/koolitused" })).toBe(`${ORIGIN}/ru/koolitused?fb=abc123`);
    expect(placeLink(ORIGIN, { id: "abc123", dir: "site" })).toBe(`${ORIGIN}/?fb=abc123`);
    expect(placeLink(ORIGIN, { id: "abc123", dir: "site", route: "//evil.example" })).toBe(`${ORIGIN}/?fb=abc123`);
  });

  test("admin comments link to the admin page itself, and never leave /admin", () => {
    expect(placeLink(ORIGIN, { id: "abc123", dir: "admin", route: "/admin/koolitused/3" })).toBe(`${ORIGIN}/admin/koolitused/3?fb=abc123`);
    expect(placeLink(ORIGIN, { id: "abc123", dir: "admin", route: "/admin" })).toBe(`${ORIGIN}/admin?fb=abc123`);
    expect(placeLink(ORIGIN, { id: "abc123", dir: "admin" })).toBe(`${ORIGIN}/admin?fb=abc123`);
    for (const route of ["//evil.example", "/koolitused", "https://evil.example/admin", "#/koolitused"])
      expect(placeLink(ORIGIN, { id: "abc123", dir: "admin", route }), route).toBe(`${ORIGIN}/admin?fb=abc123`);
  });

  test("isAdminPath", () => {
    for (const p of ["/admin", "/admin/", "/admin/koolitused", "/admin/koolitused/3", "/admin/login"]) expect(isAdminPath(p), p).toBe(true);
    for (const p of ["", "admin", "/", "/koolitused", "/administrator", "/admin.php", "/ru/admin", "//admin", "/admin?x", "/admin#x", "/admin/a b", undefined, 1]) expect(isAdminPath(p), String(p)).toBe(false);
  });

  test("isSitePath", () => {
    for (const p of ["/", "/koolitused", "/ru/koolitused/", "/koolitused/%C3%B5"]) expect(isSitePath(p), p).toBe(true);
    for (const p of ["", "koolitused", "//x", "/\\x", "/x y", "/x?y", "/x#y", "http://x", undefined, 1]) expect(isSitePath(p), String(p)).toBe(false);
  });

  test("ids look like the old review Worker's", () => {
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(/^[a-z0-9]{14}$/);
  });
});

describe("GET /api/feedback/:id (the place for ?fb=)", () => {
  test("answers the place and text without a key; unknown or malformed id → 404", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const k = kv();
    const { body } = await post(env(k), { dir: "site", route: "/koolitused", name: "Maria", device: "desk", text: "Siin", el: { label: "L", snippet: "S", sel: "#x", y: 5, h: 6 } });
    expect(await commentPlace(k, body.id as string)).toEqual({
      status: 200,
      body: { ok: true, dir: "site", route: "/koolitused", device: "desk", text: "Siin", name: "Maria", el: { label: "L", sel: "#x", y: 5, h: 6 } },
    });
    expect((await commentPlace(k, "zzzzzzzzzzzzzz")).status).toBe(404);
    expect((await commentPlace(k, "../x")).status).toBe(404);
  });
});

describe("GET /api/feedback and PATCH /api/feedback/:id (x-key)", () => {
  const seed = () => {
    const recs: Comment[] = [
      { id: "aaaaaaaaaaaaaa", at: "2026-09-30T10:00:00.000Z", dir: "d", route: "#/", device: "mob", text: "vana", el: {}, done: false },
      { id: "bbbbbbbbbbbbbb", at: "2026-10-01T10:00:00.000Z", dir: "site", route: "/praktika", text: "uus", el: {}, done: false },
      { id: "cccccccccccccc", at: "2026-09-29T10:00:00.000Z", dir: "hub", text: "vanim", el: {}, done: true },
    ];
    const init: Record<string, string> = { "tg:chat": "42", "rl:feedback:x": "1" };
    for (const r of recs) {
      init[`fb:${r.at}:${r.id}`] = JSON.stringify(r);
      init[`id:${r.id}`] = `fb:${r.at}:${r.id}`;
    }
    return kv(init, 2); // two keys per page: the list must follow the cursor
  };

  test("lists every comment newest first with its link", async () => {
    const r = await listComments(seed(), ORIGIN, KEY, KEY);
    expect(r.status).toBe(200);
    const items = r.body.items as (Comment & { link: string })[];
    expect(items.map((x) => x.id)).toEqual(["bbbbbbbbbbbbbb", "aaaaaaaaaaaaaa", "cccccccccccccc"]);
    expect(items.map((x) => x.link)).toEqual([
      `${ORIGIN}/praktika?fb=bbbbbbbbbbbbbb`,
      `${ORIGIN}/guide/?fb=aaaaaaaaaaaaaa#vaade=d&seade=mob&leht=%23%2F`,
      `${ORIGIN}/guide/?fb=cccccccccccccc`,
    ]);
  });

  test("without the right key → 401 (missing, wrong, a prefix, or no key configured at all)", async () => {
    for (const given of [null, "", "wrong", KEY.slice(0, -1), KEY + "x"]) expect((await listComments(seed(), ORIGIN, given, KEY)).status, String(given)).toBe(401);
    expect((await listComments(seed(), ORIGIN, "", "")).status).toBe(401);
    expect((await setDone(seed(), "aaaaaaaaaaaaaa", "", "", '{"done":true}')).status).toBe(401);
    expect((await setDone(seed(), "aaaaaaaaaaaaaa", "wrong", KEY, '{"done":true}')).status).toBe(401);
  });

  test("PATCH marks a comment done and open again", async () => {
    const k = seed();
    expect(await setDone(k, "aaaaaaaaaaaaaa", KEY, KEY, '{"done":true}')).toEqual({ status: 200, body: { ok: true } });
    expect(JSON.parse(k.store.get("fb:2026-09-30T10:00:00.000Z:aaaaaaaaaaaaaa")!).done).toBe(true);
    await setDone(k, "aaaaaaaaaaaaaa", KEY, KEY, '{"done":false}');
    expect(JSON.parse(k.store.get("fb:2026-09-30T10:00:00.000Z:aaaaaaaaaaaaaa")!)).toMatchObject({ done: false, text: "vana" });
  });

  test("PATCH: unknown id → 404; a body without a boolean done → 400; too long → 413", async () => {
    const k = seed();
    expect((await setDone(k, "zzzzzzzzzzzzzz", KEY, KEY, '{"done":true}')).status).toBe(404);
    for (const body of ["", "{}", '{"done":"yes"}', "[true]", "nope"]) expect((await setDone(k, "aaaaaaaaaaaaaa", KEY, KEY, body)).status, body).toBe(400);
    expect((await setDone(k, "aaaaaaaaaaaaaa", KEY, KEY, null)).status).toBe(413);
  });
});

describe("request body", () => {
  test("reads up to the limit; a longer body (declared or streamed) is refused", async () => {
    expect(await readBody(new Request("http://x", { method: "POST", body: "hello" }), 10)).toBe("hello");
    expect(await readBody(new Request("http://x", { method: "POST" }), 10)).toBe("");
    expect(await readBody(new Request("http://x", { method: "POST", body: "x".repeat(MAX_BYTES + 1) }), MAX_BYTES)).toBeNull();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("12345"));
        c.enqueue(new TextEncoder().encode("67890"));
        c.enqueue(new TextEncoder().encode("x"));
        c.close();
      },
    });
    expect(await readBody(new Request("http://x", { method: "POST", body: stream, duplex: "half" } as RequestInit), 10)).toBeNull();
    // multi-byte characters count as bytes, and are decoded whole across chunks
    expect(await readBody(new Request("http://x", { method: "POST", body: "õõõ" }), 6)).toBe("õõõ");
    expect(await readBody(new Request("http://x", { method: "POST", body: "õõõõ" }), 6)).toBeNull();
  });
});

describe("list key", () => {
  test("ADMIN_KEY when it is set", () => {
    expect(reviewKey("secret", { dev: true, host: "localhost:3000" })).toBe("secret");
    expect(reviewKey("secret", { dev: false, host: "mslab.example" })).toBe("secret");
  });

  test("without ADMIN_KEY: the local development key on this machine only; otherwise nothing is accepted", () => {
    expect(reviewKey(undefined, { dev: true, host: "localhost:3000" })).toBe(DEV_REVIEW_KEY);
    expect(reviewKey("", { dev: true, host: "127.0.0.1:3000" })).toBe(DEV_REVIEW_KEY);
    expect(reviewKey(undefined, { dev: false, host: "localhost:3000" })).toBe("");
    expect(reviewKey(undefined, { dev: true, host: "mslab-x.vercel.app" })).toBe("");
    expect(reviewKey(undefined, { dev: true, host: null })).toBe("");
  });

  test("keyMatches compares whole keys; an empty expected key never matches", async () => {
    expect(await keyMatches(KEY, KEY)).toBe(true);
    expect(await keyMatches(KEY.toUpperCase(), KEY)).toBe(false);
    expect(await keyMatches("", "")).toBe(false);
    expect(await keyMatches(null, KEY)).toBe(false);
  });
});

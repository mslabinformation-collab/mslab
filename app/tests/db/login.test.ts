import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { authTokens } from "@/db/schema";
import { LOGIN_TOKEN_CAP, consumeLoginToken, createLoginToken, issueLoginToken } from "@/server/auth";
import { handleLoginRequest, verifyUrl, type LoginDeps, type LoginEnv } from "@/server/login";
import { RATE_LIMIT } from "@/server/ratelimit";
import { sha256 } from "@/server/token";
import { fakeKv, stubFetch } from "../fakes";
import { makeTestDb } from "./helpers";

// POST /api/auth/request without Next.js: PGlite database, in-memory KV, stubbed fetch for Resend. The login link itself
// (GET /api/auth/verify) runs on the same database for the way back after signing in (B19).
// The second allowed address is a stand-in: no test asks for a link for a real address other than Dim's
// (tests/unit/test-addresses.test.ts). A local Host (the default here) gets a devLink and no e-mail; the tests about
// the e-mail use a non-local Host.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import { GET as verify } from "@/app/api/auth/verify/route";

const NOW = new Date("2026-10-01T10:00:00Z");
const OTHER_ADMIN = "second.admin@example.com";
const ALLOW = `admin@example.test,${OTHER_ADMIN}`;
const SITE_HOST = "mslab.example";

let db: Db;
beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
});
beforeEach(async () => {
  await db.delete(authTokens);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Dependencies with a fresh KV; `flush()` awaits the e-mail work that production runs after the response. */
function setup(opts: { key?: boolean; ip?: string | null; kv?: ReturnType<typeof fakeKv>; siteUrl?: string; host?: string | null; now?: Date } = {}) {
  const kv = opts.kv ?? fakeKv();
  const env: LoginEnv = {
    KV: kv,
    MAIL_FROM: "MS LAB <info@send.example>",
    MARIA_EMAIL: "maria@example.com",
    SITE_URL: "https://mslab.example",
    ADMIN_EMAILS: ALLOW,
    ...(opts.key === false ? {} : { RESEND_API_KEY: "re_test" }),
  };
  const tasks: (() => Promise<unknown>)[] = [];
  const deps: LoginDeps = {
    db,
    env,
    ip: opts.ip === undefined ? "203.0.113.1" : opts.ip,
    siteUrl: opts.siteUrl ?? "https://mslab.example",
    host: opts.host === undefined ? "localhost:3000" : opts.host,
    now: opts.now ?? NOW,
    later: (task) => void tasks.push(task),
  };
  return { deps, kv, flush: () => Promise.all(tasks.splice(0).map((task) => task())) };
}

function resend(respond: () => Response = () => Response.json({ id: "email_1" })) {
  const f = stubFetch(respond);
  const mails = () => f.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as { from: string; to: string; subject: string; text: string });
  return { mails, calls: f.calls };
}

const tokens = () => db.select().from(authTokens);
const tokenOf = (link: string) => new URL(link).searchParams.get("t")!;

describe("allowed address", () => {
  test("a token is stored and the link is e-mailed after the response", async () => {
    const { mails } = resend();
    const { deps, flush } = setup({ host: SITE_HOST });
    const res = await handleLoginRequest(deps, { email: " Admin@Example.TEST " });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await tokens()).toHaveLength(1);
    expect(mails()).toHaveLength(0); // sent after the response
    await flush();
    const [mail] = mails();
    expect(mail).toMatchObject({ from: "MS LAB <info@send.example>", to: "admin@example.test", subject: "MS LAB — sisselogimislink" });
    expect(mail.text).toContain("https://mslab.example/api/auth/verify?t=");
    expect(mail.text).toContain("15 minutit");
    expect(mail.text).toContain("ainult ühe korra");
    // the e-mailed link is the one that signs in, once
    const raw = mail.text.match(/\/api\/auth\/verify\?t=([A-Za-z0-9_-]+)/)![1];
    expect(await consumeLoginToken(db, raw, NOW)).toBe("admin@example.test");
    expect(await consumeLoginToken(db, raw, NOW)).toBeNull();
  });

  test("the link starts with the site address given to the handler", async () => {
    resend();
    const { deps } = setup({ siteUrl: "https://mslab.diipsolutions.eu" });
    const res = await handleLoginRequest(deps, { email: "admin@example.test" });
    expect(res.status === 200 && res.body.ok && res.body.devLink?.startsWith("https://mslab.diipsolutions.eu/api/auth/verify?t=")).toBe(true);
  });

  test("a failing e-mail provider does not change the answer", async () => {
    const { mails } = resend(() => Response.json({ name: "application_error", message: "admin@example.test is not allowed" }, { status: 422 }));
    const { deps, flush } = setup({ host: SITE_HOST });
    const res = await handleLoginRequest(deps, { email: "admin@example.test" });
    expect(res.status).toBe(200);
    await flush();
    expect(mails()).toHaveLength(1);
    // no address, token or provider message in the logs
    const logged = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.info).mock.calls].flat().join("\n");
    expect(logged).not.toMatch(/admin@|example\.test/);
    expect(logged).not.toContain(mails()[0].text.match(/\?t=([A-Za-z0-9_-]+)/)![1]);
  });

  test("without RESEND_API_KEY (local development) nothing is sent", async () => {
    const { mails } = resend();
    const { deps, flush } = setup({ key: false, host: SITE_HOST });
    expect((await handleLoginRequest(deps, { email: "admin@example.test" })).status).toBe(200);
    await flush();
    expect(mails()).toHaveLength(0);
  });
});

describe("no account enumeration", () => {
  test("an address outside the allow-list gets the same answer, no token and no e-mail", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { mails } = resend();
    const { deps, flush } = setup();
    const allowed = await handleLoginRequest(deps, { email: "admin@example.test" });
    await db.delete(authTokens);
    const refused = await handleLoginRequest(deps, { email: "someone@example.com" });
    await flush();
    expect(refused).toEqual(allowed);
    expect(refused).toEqual({ status: 200, body: { ok: true } });
    expect(await tokens()).toHaveLength(0);
    expect(mails().map((m) => m.to)).toEqual(["admin@example.test"]); // only the allowed address got a mail
  });

  test("the rate limit counts allowed and not allowed addresses alike", async () => {
    resend();
    const { deps } = setup();
    // (x@example.com 3 times, the allowed address twice: both within the per-address limit of B20)
    for (let i = 0; i < RATE_LIMIT; i++) expect((await handleLoginRequest(deps, { email: i % 2 ? "admin@example.test" : "x@example.com" })).status).toBe(200);
    // B20: the per-IP limit is checked first and keeps its own answer, `rate`, for both (the per-address one answers `address`)
    expect(await handleLoginRequest(deps, { email: "admin@example.test" })).toEqual({ status: 429, body: { ok: false, error: "rate" } });
    expect(await handleLoginRequest(deps, { email: "x@example.com" })).toEqual({ status: 429, body: { ok: false, error: "rate" } });
  });

  test("B20, Review Focus 4: four requests for an unknown and four for an allowed address give the same answers in the same order", async () => {
    vi.stubEnv("NODE_ENV", "production"); // no devLink: the answers are then byte-for-byte alike
    resend();
    const kv = fakeKv();
    const four = async (email: string, ip: string) => {
      const answers = [];
      for (let i = 0; i < 4; i++) answers.push(await handleLoginRequest(setup({ kv, ip }).deps, { email })); // one IP each: under its limit of 5
      return answers;
    };
    const unknown = await four("someone@example.com", "198.51.100.20");
    const allowed = await four("admin@example.test", "198.51.100.21");
    const ok = { status: 200, body: { ok: true } };
    expect(unknown).toEqual([ok, ok, ok, { status: 429, body: { ok: false, error: "address" } }]);
    expect(allowed).toEqual(unknown);
    expect(await tokens()).toHaveLength(3); // and only the allowed address got links
  });

  test("a failing database is an error only for the allowed address (the handler throws, the route answers 500)", async () => {
    resend();
    const broken = setup();
    broken.deps.db = {
      delete: () => {
        throw new Error("db down");
      },
    } as unknown as Db;
    await expect(handleLoginRequest(broken.deps, { email: "admin@example.test" })).rejects.toThrow();
    expect((await handleLoginRequest(broken.deps, { email: "other@example.com" })).status).toBe(200);
  });
});

// B20 (admin UX pass piece 4c, ruling R-g): 3 requests per typed address in 10 minutes, counted in KV for every address, allowed or not; the
// 4th says so (429 `address`, „Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.“) instead of claiming a link was sent. Behind it the
// token cap of issueLoginToken stays (3 unused links per address), for a request the KV count misses.
describe("per-address limit (B20) and the token cap behind it", () => {
  const MIN = 60_000;
  const ADDRESS = { status: 429, body: { ok: false, error: "address" } };

  test("B20: the 4th request within 10 minutes is refused with 429 `address`: no token and no mail", async () => {
    vi.stubEnv("NODE_ENV", "production"); // the answers are then byte-for-byte alike
    const { mails } = resend();
    const { deps, flush } = setup();
    const answers = [];
    for (let i = 0; i < LOGIN_TOKEN_CAP + 1; i++) answers.push(await handleLoginRequest(deps, { email: "admin@example.test" }));
    await flush();
    expect(answers).toEqual([...Array.from({ length: LOGIN_TOKEN_CAP }, () => ({ status: 200, body: { ok: true } })), ADDRESS]);
    expect(await tokens()).toHaveLength(LOGIN_TOKEN_CAP);
    expect(mails()).toHaveLength(LOGIN_TOKEN_CAP);
    expect(LOGIN_TOKEN_CAP).toBe(3);
  });

  test("the refused request has no devLink either (nothing exists to link to)", async () => {
    resend();
    const { deps } = setup();
    for (let i = 0; i < LOGIN_TOKEN_CAP; i++) await handleLoginRequest(deps, { email: "admin@example.test" });
    expect(await handleLoginRequest(deps, { email: "admin@example.test" })).toEqual(ADDRESS);
  });

  test("it holds across IPs (the per-IP limit is not what protects an inbox), and other addresses are not affected", async () => {
    const { mails } = resend();
    const kv = fakeKv();
    const flushes = [];
    const answers = [];
    for (let i = 0; i < 6; i++) {
      const s = setup({ kv, ip: `198.51.100.${i}`, host: SITE_HOST });
      answers.push((await handleLoginRequest(s.deps, { email: "admin@example.test" })).status);
      flushes.push(s.flush());
    }
    const other = setup({ kv, ip: "198.51.100.99", host: SITE_HOST });
    expect((await handleLoginRequest(other.deps, { email: OTHER_ADMIN })).status).toBe(200);
    await Promise.all([...flushes, other.flush()]);
    expect(answers).toEqual([200, 200, 200, 429, 429, 429]);
    expect(mails().filter((m) => m.to === "admin@example.test")).toHaveLength(LOGIN_TOKEN_CAP);
    expect(mails().filter((m) => m.to === OTHER_ADMIN)).toHaveLength(1);
  });

  test("the address is counted as the login normalises it: spaces and capitals are the same address", async () => {
    resend();
    const kv = fakeKv();
    for (const email of ["admin@example.test", " Admin@Example.TEST ", "ADMIN@EXAMPLE.TEST"]) expect((await handleLoginRequest(setup({ kv }).deps, { email })).status).toBe(200);
    expect(await handleLoginRequest(setup({ kv, ip: "198.51.100.30" }).deps, { email: "admin@example.TEST" })).toEqual(ADDRESS);
  });

  test("the KV holds the SHA-256 of the address, never the address itself, for 10 minutes", async () => {
    resend();
    const { deps, kv } = setup();
    await handleLoginRequest(deps, { email: " Someone@Example.com " });
    const key = `rl:login-addr:${await sha256("someone@example.com")}`;
    expect(kv.store.get(key)).toBe("1");
    expect(kv.ttl.get(key)).toBe(600);
    expect([...kv.store.keys(), ...kv.store.values()].join("\n")).not.toMatch(/someone|example\.com/i);
  });

  test("a burst of simultaneous requests for one address takes exactly 3 slots", async () => {
    resend();
    const kv = fakeKv();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => handleLoginRequest(setup({ kv, ip: `203.0.113.${i}` }).deps, { email: "admin@example.test" })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(LOGIN_TOKEN_CAP);
    expect(results.filter((r) => r.status === 429 && r.body.error === "address")).toHaveLength(8 - LOGIN_TOKEN_CAP);
    expect(await tokens()).toHaveLength(LOGIN_TOKEN_CAP);
  });

  test("the token cap still holds when the count is missed (each request its own KV here, as when KV fails open): a burst cannot slip past it", async () => {
    resend();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => handleLoginRequest(setup({ ip: `203.0.113.${i}` }).deps, { email: "admin@example.test" })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await tokens()).toHaveLength(LOGIN_TOKEN_CAP);
  });

  test("tokens issued more than 10 minutes ago and used ones do not count", async () => {
    resend();
    const old = new Date(NOW.getTime() - 11 * MIN); // still alive for 4 more minutes, but not "within the last 10 minutes"
    for (let i = 0; i < LOGIN_TOKEN_CAP; i++) expect(await issueLoginToken(db, "admin@example.test", old)).not.toBeNull();
    const first = await handleLoginRequest(setup().deps, { email: "admin@example.test" });
    expect(first.status === 200 && "devLink" in first.body).toBe(true);
    // used: sign in with each of two fresh links, then two more can be requested
    for (let i = 0; i < 2; i++) {
      const r = await handleLoginRequest(setup().deps, { email: "admin@example.test" });
      if (!(r.status === 200 && r.body.ok && r.body.devLink)) throw new Error("expected a link");
      expect(await consumeLoginToken(db, tokenOf(r.body.devLink), NOW)).toBe("admin@example.test");
    }
    expect(await handleLoginRequest(setup().deps, { email: "admin@example.test" })).toMatchObject({ body: { devLink: expect.any(String) } });
  });
});

describe("devLink", () => {
  test("a link handed back as devLink is never e-mailed, even when RESEND_API_KEY is set", async () => {
    const { mails, calls } = resend();
    const { deps, flush } = setup(); // a local Host, a non-production build, and a key
    const res = await handleLoginRequest(deps, { email: "admin@example.test" });
    expect(res.status === 200 && res.body.ok && typeof res.body.devLink === "string").toBe(true);
    expect(await flush()).toHaveLength(0); // no e-mail work was even scheduled
    expect(mails()).toHaveLength(0);
    expect(calls).toHaveLength(0);
    // the same request to the site's own address: e-mailed, no devLink
    const site = setup({ host: SITE_HOST });
    expect(await handleLoginRequest(site.deps, { email: "admin@example.test" })).toEqual({ status: 200, body: { ok: true } });
    await site.flush();
    expect(mails().map((m) => m.to)).toEqual(["admin@example.test"]);
  });

  test("is returned outside production (tests and local development) and works as a login link", async () => {
    resend();
    const { deps } = setup();
    const res = await handleLoginRequest(deps, { email: "admin@example.test" });
    if (!(res.status === 200 && res.body.ok)) throw new Error("expected ok");
    expect(res.body.devLink).toBe(verifyUrl("https://mslab.example", tokenOf(res.body.devLink!)));
    expect(await consumeLoginToken(db, tokenOf(res.body.devLink!), NOW)).toBe("admin@example.test");
  });

  test("is never returned in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    resend();
    const { deps } = setup();
    const res = await handleLoginRequest(deps, { email: "admin@example.test" });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(JSON.stringify(res)).not.toMatch(/devLink|verify|http/);
    expect(await tokens()).toHaveLength(1); // the token itself is stored and e-mailed
  });

  test("is returned only for a local Host: not for a preview or staging address even in a non-production build", async () => {
    resend();
    for (const host of ["localhost:3000", "127.0.0.1:3001", "localhost"]) {
      const res = await handleLoginRequest(setup({ host }).deps, { email: "admin@example.test" });
      expect(res.status === 200 && "devLink" in res.body, host).toBe(true);
      await db.delete(authTokens);
    }
    for (const host of ["mslab-x.vercel.app", "mslab.example", "localhost.evil.example", "evil.example:3000", "", null]) {
      const res = await handleLoginRequest(setup({ host }).deps, { email: "admin@example.test" });
      expect(res, String(host)).toEqual({ status: 200, body: { ok: true } });
      await db.delete(authTokens);
    }
  });

  test("production + a local Host: still never", async () => {
    vi.stubEnv("NODE_ENV", "production");
    resend();
    expect(await handleLoginRequest(setup({ host: "localhost:3000" }).deps, { email: "admin@example.test" })).toEqual({ status: 200, body: { ok: true } });
  });

  test("is not returned for an address outside the allow-list either", async () => {
    resend();
    const { deps } = setup();
    expect(await handleLoginRequest(deps, { email: "someone@example.com" })).toEqual({ status: 200, body: { ok: true } });
  });
});

// B19 (admin UX pass piece 4c, ruling R-f): the admin page she opened signed out travels as `tagasi` in the request, then as `&tagasi=` in the
// mailed link, and the link lands her there. Both steps check it (lib/admin-return.ts); a bad one is dropped without a word (the landing is /admin).
describe("the way back after signing in (B19)", () => {
  const ORIGIN = "https://mslab.example";
  const linkOf = (res: Awaited<ReturnType<typeof handleLoginRequest>>) => {
    if (!(res.status === 200 && res.body.ok && res.body.devLink)) throw new Error("expected a devLink");
    return new URL(res.body.devLink);
  };
  /** Opens a login link (GET /api/auth/verify) and returns where its 303 goes: path, query and fragment. */
  const open = async (link: string) => {
    const res = await verify(new Request(link));
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin).toBe(ORIGIN);
    return to.pathname + to.search + to.hash;
  };
  beforeEach(() => vi.stubEnv("ADMIN_EMAILS", ALLOW));
  // the link is opened by the route, which reads the real clock: the tokens are issued now
  const now = () => new Date();

  test("the mailed link carries &tagasi=, URL-encoded with its #fragment, and opening it lands there", async () => {
    const { mails } = resend();
    const { deps, flush } = setup({ host: SITE_HOST, now: now() });
    await handleLoginRequest(deps, { email: "admin@example.test", tagasi: "/admin/kalender?id=3#x" });
    await flush();
    const link = mails()[0].text.match(/https:\/\/\S+/)![0];
    expect(link).toMatch(/^https:\/\/mslab\.example\/api\/auth\/verify\?t=[A-Za-z0-9_-]+&tagasi=%2Fadmin%2Fkalender%3Fid%3D3%23x$/);
    expect(await open(link)).toBe("/admin/kalender?id=3#x");
  });

  test("the devLink is the same link", async () => {
    resend();
    const link = linkOf(await handleLoginRequest(setup({ now: now() }).deps, { email: "admin@example.test", tagasi: "/admin/testimine#kirjad-halduse-link" }));
    expect(link.searchParams.get("tagasi")).toBe("/admin/testimine#kirjad-halduse-link");
    expect(await open(link.href)).toBe("/admin/testimine#kirjad-halduse-link");
  });

  test("no tagasi, the panel's front page and anything that is not an admin page of this site: no &tagasi=, the link lands on /admin, never a 400", async () => {
    resend();
    for (const tagasi of [undefined, "/admin", "//evil", "/\\evil", "%2F%2Fevil", "/admin/login", "/adminx", "https://other/admin", "/admin/kalen\tder", "/admin/x\n", `/admin/${"k".repeat(294)}`, 42, { path: "/admin/kalender" }, null]) {
      const res = await handleLoginRequest(setup({ now: now() }).deps, { email: "admin@example.test", tagasi });
      const link = linkOf(res);
      expect(link.searchParams.has("tagasi"), JSON.stringify(tagasi)).toBe(false);
      expect(await open(link.href), JSON.stringify(tagasi)).toBe("/admin");
    }
  });

  test("the link checks its tagasi again: one forged into it lands on /admin", async () => {
    for (const tagasi of ["//evil.example", "/\\evil.example", "%2F%2Fevil", "/admin/%2F%2Fevil", "/admin/login", "/adminx", "https://evil.example/admin", "/admin/kalen\tder", `/admin/${"k".repeat(294)}`]) {
      const token = await createLoginToken(db, "admin@example.test");
      expect(await open(`${ORIGIN}/api/auth/verify?t=${token}&tagasi=${encodeURIComponent(tagasi)}`), tagasi).toBe("/admin");
    }
    // a good one forged in is a page of the admin all the same
    const token = await createLoginToken(db, "admin@example.test");
    expect(await open(`${ORIGIN}/api/auth/verify?t=${token}&tagasi=${encodeURIComponent("/admin/maksed")}`)).toBe("/admin/maksed");
  });

  test("a link that does not work keeps its notice and goes nowhere else", async () => {
    expect(await open(`${ORIGIN}/api/auth/verify?t=${"A".repeat(43)}&tagasi=${encodeURIComponent("/admin/kalender")}`)).toBe("/admin/login?viga=link");
  });
});

describe("validation", () => {
  test.each([[{}], [{ email: "" }], [{ email: "no-at-sign" }], [{ email: 42 }], [{ email: "a".repeat(200) + "@example.com" }], [null], ["admin@example.test"], [[]]])(
    "%j is refused with 400 and nothing stored",
    async (input) => {
      const { deps, kv } = setup();
      expect(await handleLoginRequest(deps, input)).toEqual({ status: 400, body: { ok: false, error: "email" } });
      expect(await tokens()).toHaveLength(0);
      expect(kv.store.size).toBe(0); // an invalid request does not use up the rate limit
    },
  );
});

describe("rate limit", () => {
  test("5 requests per 10 minutes per IP, then 429; another IP is not affected", async () => {
    resend();
    const { deps, kv } = setup({ ip: "198.51.100.7" });
    // five addresses, so that none of them reaches its own limit of 3 (B20)
    const addresses = ["admin@example.test", OTHER_ADMIN, "x1@example.com", "x2@example.com", "admin@example.test"];
    for (const email of addresses) expect((await handleLoginRequest(deps, { email })).status).toBe(200);
    expect(await handleLoginRequest(deps, { email: "admin@example.test" })).toEqual({ status: 429, body: { ok: false, error: "rate" } });
    expect(await tokens()).toHaveLength(3); // the two allowed addresses' links; the refused 6th created none
    expect(kv.ttl.get("rl:login:198.51.100.7")).toBe(600);
    const other = setup({ kv, ip: "198.51.100.8" });
    expect((await handleLoginRequest(other.deps, { email: "admin@example.test" })).status).toBe(200);
  });

  test("a request without an IP address is not limited per IP (the per-address limit of B20 still counts)", async () => {
    resend();
    const { deps, kv } = setup({ ip: null });
    for (let i = 0; i < RATE_LIMIT + 2; i++) expect((await handleLoginRequest(deps, { email: `someone${i}@example.com` })).status).toBe(200);
    expect([...kv.store.keys()].filter((k) => k.startsWith("rl:login:"))).toEqual([]);
    for (let i = 0; i < 2; i++) await handleLoginRequest(deps, { email: "someone0@example.com" });
    expect(await handleLoginRequest(deps, { email: "someone0@example.com" })).toEqual({ status: 429, body: { ok: false, error: "address" } });
  });

  test("when KV is unavailable the admins can still sign in (both limits fail open; the token cap stays)", async () => {
    resend();
    const down = () => Promise.reject(new Error("KV down"));
    const kv = { ...fakeKv(), get: down, put: down, reserve: down };
    const { deps } = setup({ kv });
    for (let i = 0; i < LOGIN_TOKEN_CAP + 1; i++) expect((await handleLoginRequest(deps, { email: "admin@example.test" })).status).toBe(200);
    expect(await tokens()).toHaveLength(LOGIN_TOKEN_CAP);
  });
});

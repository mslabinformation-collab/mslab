import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import {
  clientFavourites, clientLoginTokens, clients, clientSessions, courseAccess, courses, courseSessions, mailQuota, pages, registrations, requests, settings,
  subscribers, termsAcceptances,
} from "@/db/schema";
import { clearedCookies, handleAccountApi, sessionCookies, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS, LOGIN_MAIL_DAILY_CAP } from "@/server/client-auth";
import { sha256 } from "@/server/token";
import { formatEUR } from "@/domain/money";
import { formatDayMonth } from "@/i18n/format";
import { fakeKv, stubFetch } from "../fakes";
import { addModules, makeTestDb } from "./helpers";

// The client account's API without Next.js (sign-in, then the data endpoints at the end): PGlite database, in-memory KV (the rate-limit store), stubbed fetch
// for Resend. `later` collects what production runs after the response (the e-mail); `flush()` awaits it.
// EMAIL is a sample address (`@example.test`: never mailed outside development); MAILED is a stand-in for a real one.

const NOW = new Date("2026-10-02T10:00:00Z");
const SITE = "https://mslab.example";
const EMAIL = "kati@example.test";
const MAILED = "kati@example.com";

let db: Db;
beforeAll(async () => {
  db = await makeTestDb();
});
beforeEach(async () => {
  await db.delete(clientLoginTokens);
  await db.delete(clientSessions);
  // what the data endpoints leave: records first (they point at courses and clients), then the clients (cascade: hearts, access, terms)
  for (const table of [termsAcceptances, clientFavourites, courseAccess, registrations, requests, subscribers]) await db.delete(table);
  await db.delete(clients);
  for (const table of [courseSessions, courses, settings, pages]) await db.delete(table);
  await db.delete(mailQuota);
  for (const method of ["info", "error", "log", "warn"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Setup = { dev?: boolean; key?: boolean; kv?: ReturnType<typeof fakeKv>; now?: Date };

function setup(opts: Setup = {}) {
  const kv = opts.kv ?? fakeKv();
  const tasks: (() => Promise<unknown>)[] = [];
  const deps: AccountDeps = {
    db,
    env: {
      KV: kv, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE,
      ...(opts.key === false ? {} : { RESEND_API_KEY: "re_test" }),
    },
    now: opts.now ?? NOW,
    siteUrl: SITE,
    later: (task) => void tasks.push(task),
    dev: opts.dev ?? true,
  };
  return { deps, kv, queued: () => tasks.length, flush: () => Promise.all(tasks.splice(0).map((task) => task())) };
}

type Call = { body?: unknown; method?: string; cookie?: string; headers?: Record<string, string>; ip?: string | null };

/** One request to the router; `ip` is the visitor's address (x-forwarded-for), null for none. */
async function call(deps: AccountDeps, path: string, o: Call = {}): Promise<Response> {
  const headers = new Headers(o.headers);
  if (o.cookie) headers.set("cookie", o.cookie);
  const ip = o.ip === undefined ? "203.0.113.1" : o.ip;
  if (ip) headers.set("x-forwarded-for", ip);
  const res = await handleAccountApi(
    new Request(`${SITE}/api/konto${path}`, {
      method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    }),
    deps,
  );
  return res!;
}

/** The raw session id in a Set-Cookie list, as the Cookie header a browser would send back. */
const sessionCookie = (res: Response): string | undefined => {
  const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-mslab_client=") && !c.includes("Max-Age=0"));
  return line?.split(";")[0];
};
const rawOf = (cookie: string) => cookie.slice("__Host-mslab_client=".length);

/** Login in development, then the code from the answer: the Cookie header of the new session. */
async function signIn(deps: AccountDeps, email = EMAIL, ip?: string): Promise<string> {
  const login = await (await call(deps, "/login", { body: { email, locale: "et" }, ip })).json();
  const res = await call(deps, "/code", { body: { email, code: login.devCode }, ip });
  expect(res.status).toBe(200);
  return sessionCookie(res)!;
}

const tokens = () => db.select().from(clientLoginTokens);
const sessions = () => db.select().from(clientSessions);
const quota = () => db.select().from(mailQuota);
const tokenOf = (link: string) => new URL(link).searchParams.get("t")!;
/** The router path of a link (with its whole query: t and l). */
const pathOf = (link: string) => {
  const u = new URL(link);
  return u.pathname.slice("/api/konto".length) + u.search;
};

/** Resend as the stub fetch sees it: the e-mails sent. */
function resend(respond: () => Response = () => Response.json({ id: "email_1" })) {
  const f = stubFetch(respond);
  return { mails: () => f.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as { from: string; to: string; subject: string; text: string; html?: string }), calls: f.calls };
}
const codeOf = (mail: { text: string }) => mail.text.split("\n").find((l) => /^\d{6}$/.test(l))!;

describe("login in development", () => {
  test("the code and the link come back in the answer, a token row is stored, nothing is mailed or counted", async () => {
    const { mails } = resend();
    const { deps, queued, flush } = setup({ dev: true }); // a RESEND_API_KEY is set: still no mail
    const res = await call(deps, "/login", { body: { email: EMAIL, locale: "et" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, devCode: expect.stringMatching(/^\d{6}$/), devLink: expect.stringContaining(`${SITE}/api/konto/verify?t=`) });
    const rows = await tokens();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: EMAIL, attempts: 0, usedAt: null, expiresAt: new Date(NOW.getTime() + 30 * 60_000) });
    expect(rows[0].hash).toBe(await sha256(tokenOf(body.devLink)));
    expect(queued()).toBe(0);
    await flush();
    expect(mails()).toHaveLength(0);
    expect(await quota()).toEqual([]);
  });

  test("the address is trimmed and lower-cased", async () => {
    const { deps } = setup();
    expect((await call(deps, "/login", { body: { email: " Kati@Example.TEST " } })).status).toBe(200);
    expect((await tokens()).map((t) => t.email)).toEqual([EMAIL]);
  });

  test("the code logs in, once: two cookies, and /me answers for them", async () => {
    const { deps } = setup();
    const { devCode } = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    const res = await call(deps, "/code", { body: { email: EMAIL.toUpperCase(), code: devCode } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, locale: "et" });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    const cookie = sessionCookie(res)!;
    expect(cookies).toEqual(sessionCookies(rawOf(cookie)));
    // only the hash of the session id is stored
    const [session] = await sessions();
    expect(session.idHash).toBe(await sha256(rawOf(cookie)));
    expect(session.expiresAt).toEqual(new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS));

    const me = await call(deps, "/me", { cookie: `other=1; ${cookie}; mslab_in=1` });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ ok: true, email: EMAIL, name: "" });
    expect(me.headers.getSetCookie()).toEqual([]);

    expect((await call(deps, "/code", { body: { email: EMAIL, code: devCode } })).status).toBe(400); // used up
  });

  test("a code typed with a space (\"123 456\") is the same code", async () => {
    const { deps } = setup();
    const { devCode } = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    const res = await call(deps, "/code", { body: { email: EMAIL, code: ` ${devCode.slice(0, 3)} ${devCode.slice(3)} ` } });
    expect(res.status).toBe(200);
  });

  test("a failing rate limit store lets the login through, and logs no address", async () => {
    const kv = fakeKv();
    kv.get = async () => { throw new Error(`store down for ${EMAIL}`); };
    const { deps } = setup({ kv });
    const res = await call(deps, "/login", { body: { email: EMAIL } });
    expect(res.status).toBe(200);
    expect((await res.json()).devCode).toMatch(/^\d{6}$/);
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).toContain("[account] rate limit unavailable, allowing");
    expect(logged).not.toMatch(/kati|example\.test/);
  });
});

describe("login outside development", () => {
  test("a mailed address gets the same plain answer and the e-mail goes out after the response, counted once", async () => {
    const { mails } = resend();
    const { deps, queued, flush } = setup({ dev: false });
    const res = await call(deps, "/login", { body: { email: MAILED, locale: "et" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true }); // no devCode, no devLink
    expect(await tokens()).toHaveLength(1);
    expect(queued()).toBe(1);
    expect(mails()).toHaveLength(0); // sent after the response
    expect((await quota())[0]).toMatchObject({ day: "2026-10-02", sent: 1 });
    await flush();
    const [mail] = mails();
    expect(mail).toMatchObject({ from: "MS LAB <info@send.example>", to: MAILED });
    const code = codeOf(mail);
    expect(mail.subject).toBe(`${code} — MS LAB sisselogimiskood`);
    expect(mail.text).toContain(`${SITE}/api/konto/verify?t=`);
    // the HTML body goes out with it: the same code, and the same link behind the button
    expect(mail.html).toContain(`>${code}</div>`);
    expect(mail.html).toContain(">Logi sisse</a>");
    expect(mail.html).toContain(`href="${mail.text.match(/https:\/\/\S+/)![0]}"`);
    // the e-mailed code and the e-mailed link each sign in (the first one used wins)
    const link = new URL(mail.text.match(/https:\/\/\S+/)![0]);
    const signedIn = await call(deps, `${link.pathname.slice("/api/konto".length)}${link.search}`);
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe(`${SITE}/konto#sisse`);
    expect((await call(deps, "/code", { body: { email: MAILED, code } })).status).toBe(400); // the token is used
  });

  test("the e-mailed code signs in", async () => {
    const { mails } = resend();
    const { deps, flush } = setup({ dev: false });
    await call(deps, "/login", { body: { email: MAILED } });
    await flush();
    const res = await call(deps, "/code", { body: { email: MAILED, code: codeOf(mails()[0]) } });
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeDefined();
  });

  test("Russian: the page language, or the client's own language when the address has an account", async () => {
    const { mails } = resend();
    const { deps, flush } = setup({ dev: false });
    await call(deps, "/login", { body: { email: MAILED, locale: "ru" } });
    await flush();
    expect(mails()[0].subject).toMatch(/^\d{6} — код входа MS LAB$/);
    expect(mails()[0].text).toContain("Код и ссылка действуют 30 минут.");

    await db.insert(clients).values({ email: "olga@example.com", locale: "ru" });
    await db.insert(clients).values({ email: "mari@example.com", locale: "et" });
    await call(deps, "/login", { body: { email: "olga@example.com", locale: "et" } }); // an account in Russian wins over the page
    await call(deps, "/login", { body: { email: "mari@example.com", locale: "ru" } }); // and one in Estonian too
    await flush();
    expect(mails().slice(1).map((m) => m.subject.replace(/^\d{6}/, "N"))).toEqual(["N — код входа MS LAB", "N — MS LAB sisselogimiskood"]);
  });

  test("a missing or unknown language is Estonian", async () => {
    const { mails } = resend();
    const { deps, flush } = setup({ dev: false });
    for (const body of [{ email: "a@example.com" }, { email: "b@example.com", locale: "fr" }, { email: "c@example.com", locale: 7 }])
      await call(deps, "/login", { body });
    await flush();
    expect(mails().map((m) => m.subject.replace(/^\d{6}/, "N"))).toEqual(Array(3).fill("N — MS LAB sisselogimiskood"));
  });

  test("a sample address (@example.test) gets { ok: true } and a login row, but no mail and no count against the daily cap", async () => {
    const { mails } = resend();
    const { deps, queued, flush } = setup({ dev: false });
    const res = await call(deps, "/login", { body: { email: "Kati@Example.TEST" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await tokens()).toHaveLength(1);
    expect(queued()).toBe(0);
    await flush();
    expect(mails()).toHaveLength(0);
    expect(await quota()).toEqual([]);
  });

  test("the daily cap reached: the same answer, a login row, no mail queued, and a note in the log without the address", async () => {
    const { mails } = resend();
    await db.insert(mailQuota).values({ day: "2026-10-02", sent: LOGIN_MAIL_DAILY_CAP });
    const { deps, queued, flush } = setup({ dev: false });
    const res = await call(deps, "/login", { body: { email: MAILED } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await tokens()).toHaveLength(1);
    expect(queued()).toBe(0);
    await flush();
    expect(mails()).toHaveLength(0);
    expect((await quota())[0].sent).toBe(LOGIN_MAIL_DAILY_CAP); // not counted past the cap
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).toContain("[account] daily login mail cap reached");
    expect(logged).not.toMatch(/kati|example\.com/);
  });

  test("an address with 3 live logins already: the same answer, no fourth login, no fourth mail", async () => {
    const { mails } = resend();
    const { deps, flush } = setup({ dev: false });
    const answers = [];
    for (let i = 0; i < 4; i++) answers.push(await (await call(deps, "/login", { body: { email: MAILED } })).json());
    await flush();
    expect(answers).toEqual(Array(4).fill({ ok: true }));
    expect(await tokens()).toHaveLength(3);
    expect(mails()).toHaveLength(3);
    expect((await quota())[0].sent).toBe(3);
  });

  test("a failing e-mail provider does not change the answer", async () => {
    const { mails } = resend(() => Response.json({ name: "validation_error", message: `${MAILED} is not allowed` }, { status: 422 }));
    const { deps, flush } = setup({ dev: false });
    const res = await call(deps, "/login", { body: { email: MAILED } });
    expect(await res.json()).toEqual({ ok: true });
    await flush();
    expect(mails()).toHaveLength(1);
  });

  test("without RESEND_API_KEY nothing is sent", async () => {
    const { mails } = resend();
    const { deps, flush } = setup({ dev: false, key: false });
    expect((await call(deps, "/login", { body: { email: MAILED } })).status).toBe(200);
    await flush();
    expect(mails()).toHaveLength(0);
  });
});

describe("rate limits", () => {
  test("login: 10 per 10 minutes per address of the visitor, then 429 { error: \"rate\" } and no login row", async () => {
    const { deps, kv } = setup();
    for (let i = 0; i < 10; i++) expect((await call(deps, "/login", { body: { email: `s${i}@example.test` }, ip: "203.0.113.7" })).status).toBe(200);
    const res = await call(deps, "/login", { body: { email: "s10@example.test" }, ip: "203.0.113.7" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "rate" });
    expect(await tokens()).toHaveLength(10);
    expect(kv.store.get("rl:client-login:203.0.113.7")).toBe("10");
    expect(kv.ttl.get("rl:client-login:203.0.113.7")).toBe(600);
    // another visitor is not affected
    expect((await call(deps, "/login", { body: { email: "s11@example.test" }, ip: "203.0.113.8" })).status).toBe(200);
  });

  test("requests that are not well-formed are not counted", async () => {
    const { deps, kv } = setup();
    for (let i = 0; i < 12; i++) await call(deps, "/login", { body: { email: "nope" }, ip: "203.0.113.7" });
    expect(kv.store.size).toBe(0);
    expect((await call(deps, "/login", { body: { email: EMAIL }, ip: "203.0.113.7" })).status).toBe(200);
  });

  test("every address of an IPv6 /64 shares one bucket", async () => {
    const { deps, kv } = setup();
    await call(deps, "/login", { body: { email: EMAIL }, ip: "2001:db8:1:2:aaaa:bbbb:cccc:dddd" });
    await call(deps, "/login", { body: { email: EMAIL }, ip: "2001:db8:1:2:1111:2222:3333:4444" });
    expect(kv.store.get("rl:client-login:2001:db8:1:2::/64")).toBe("2");
  });

  test("code: 20 per 10 minutes per visitor (its own bucket), then 429 { error: \"rate\" }", async () => {
    const { deps, kv } = setup();
    for (let i = 0; i < 20; i++) expect((await call(deps, "/code", { body: { email: EMAIL, code: "000000" }, ip: "203.0.113.7" })).status).toBe(400);
    const res = await call(deps, "/code", { body: { email: EMAIL, code: "000000" }, ip: "203.0.113.7" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "rate" });
    expect(kv.store.get("rl:client-code:203.0.113.7")).toBe("20");
    expect(kv.store.has("rl:client-login:203.0.113.7")).toBe(false);
  });

  test("no visitor address: development uses one local bucket, production does not limit (and writes nothing)", async () => {
    const dev = setup({ dev: true });
    await call(dev.deps, "/login", { body: { email: EMAIL }, ip: null });
    expect(dev.kv.store.get("rl:client-login:local")).toBe("1");
    const prod = setup({ dev: false });
    for (let i = 0; i < 12; i++) expect((await call(prod.deps, "/login", { body: { email: EMAIL }, ip: null })).status).toBe(200);
    expect(prod.kv.store.size).toBe(0);
  });
});

describe("wrong and missing codes", () => {
  test("a wrong code is 400 { error: \"code\" }; five wrong tries end the login even for the right code", async () => {
    const { deps } = setup();
    const { devCode } = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    const wrong = devCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const res = await call(deps, "/code", { body: { email: EMAIL, code: wrong } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "code" });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    const res = await call(deps, "/code", { body: { email: EMAIL, code: devCode } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "expired" });
    expect(await sessions()).toEqual([]);
  });

  test("no live login for the address (unknown address, expired, used): 400 { error: \"expired\" }", async () => {
    const { deps } = setup();
    const unknown = await call(deps, "/code", { body: { email: "nobody@example.test", code: "123456" } });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ ok: false, error: "expired" });

    const { devCode } = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    const later = setup({ now: new Date(NOW.getTime() + 30 * 60_000 + 1) }).deps;
    const res = await call(later, "/code", { body: { email: EMAIL, code: devCode } });
    expect(await res.json()).toEqual({ ok: false, error: "expired" });
  });

  test("the code of an address does not work for another address", async () => {
    const { deps } = setup();
    const { devCode } = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    await call(deps, "/login", { body: { email: "other@example.test" } });
    const res = await call(deps, "/code", { body: { email: "other@example.test", code: devCode } });
    expect(res.status).toBe(400);
    expect(sessionCookie(res)).toBeUndefined();
  });
});

describe("one device", () => {
  test("a second login ends the first session: its /me says 401 { reason: \"replaced\" } and clears the hint cookie", async () => {
    const { deps } = setup();
    const first = await signIn(deps);
    expect((await call(deps, "/me", { cookie: first })).status).toBe(200);
    const second = await signIn(deps, EMAIL, "198.51.100.9"); // another device
    expect(second).not.toBe(first);

    const old = await call(deps, "/me", { cookie: first });
    expect(old.status).toBe(401);
    expect(await old.json()).toEqual({ ok: false, reason: "replaced" });
    expect(old.headers.getSetCookie()).toEqual([clearedCookies()[1]]);
    const now = await call(deps, "/me", { cookie: second });
    expect(now.status).toBe(200);
    expect(await now.json()).toMatchObject({ ok: true, email: EMAIL });
    expect(await db.select().from(clients)).toHaveLength(1);
  });

  test("the link also ends the other session", async () => {
    const { deps } = setup();
    const first = await signIn(deps);
    const { devLink } = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    const verified = await call(deps, `/verify?t=${tokenOf(devLink)}`);
    expect(verified.status).toBe(303);
    expect((await call(deps, "/me", { cookie: first })).status).toBe(401);
    expect((await call(deps, "/me", { cookie: sessionCookie(verified)! })).status).toBe(200);
  });
});

describe("verify", () => {
  test("a bad token goes to /konto/sisene#viga=link: absolute address, no cookies, no Referer sent on", async () => {
    const { deps } = setup();
    for (const path of ["/verify?t=" + "A".repeat(43), "/verify?t=nope", "/verify?t=", "/verify"]) {
      const res = await call(deps, path);
      expect(res.status, path).toBe(303);
      expect(res.headers.get("location"), path).toBe(`${SITE}/konto/sisene#viga=link`);
      expect(res.headers.getSetCookie(), path).toEqual([]);
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  test("a prefetch leaves a good token unused; the click then signs in, once", async () => {
    const { deps } = setup();
    const { devLink } = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    const t = tokenOf(devLink);
    for (const headers of [{ "sec-purpose": "prefetch" }, { purpose: "prefetch" }, { "sec-purpose": "prefetch;prerender" }] as Record<string, string>[]) {
      const res = await call(deps, `/verify?t=${t}`, { headers });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${SITE}/konto/sisene`);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect((await tokens())[0].usedAt).toBeNull();
    expect(await sessions()).toEqual([]);

    const res = await call(deps, `/verify?t=${t}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${SITE}/konto#sisse`);
    expect(res.headers.getSetCookie()).toEqual(sessionCookies(rawOf(sessionCookie(res)!)));
    expect((await call(deps, "/me", { cookie: sessionCookie(res)! })).status).toBe(200);

    const again = await call(deps, `/verify?t=${t}`);
    expect(again.headers.get("location")).toBe(`${SITE}/konto/sisene#viga=link`);
  });

  test("a client who uses Russian lands on /ru/konto", async () => {
    const { deps } = setup();
    await db.insert(clients).values({ email: EMAIL, locale: "ru" });
    const { devLink } = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    const res = await call(deps, `/verify?t=${tokenOf(devLink)}`);
    expect(res.headers.get("location")).toBe(`${SITE}/ru/konto#sisse`);
    const code = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    expect(await (await call(deps, "/code", { body: { email: EMAIL, code: code.devCode } })).json()).toEqual({ ok: true, locale: "ru" });
  });

  test("one login, one use: the code kills the link and the link kills the code", async () => {
    const { deps } = setup();
    const a = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    expect((await call(deps, "/code", { body: { email: EMAIL, code: a.devCode } })).status).toBe(200);
    expect((await call(deps, `/verify?t=${tokenOf(a.devLink)}`)).headers.get("location")).toBe(`${SITE}/konto/sisene#viga=link`);

    const b = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    expect((await call(deps, `/verify?t=${tokenOf(b.devLink)}`)).headers.get("location")).toBe(`${SITE}/konto#sisse`);
    expect((await call(deps, "/code", { body: { email: EMAIL, code: b.devCode } })).status).toBe(400);
  });

  test("an expired link goes to #viga=link; a HEAD request does not use the token", async () => {
    const { deps } = setup();
    const { devLink } = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    expect((await call(deps, `/verify?t=${tokenOf(devLink)}`, { method: "HEAD" })).status).toBe(404);
    expect((await tokens())[0].usedAt).toBeNull();
    const later = setup({ now: new Date(NOW.getTime() + 30 * 60_000 + 1) }).deps;
    expect((await call(later, `/verify?t=${tokenOf(devLink)}`)).headers.get("location")).toBe(`${SITE}/konto/sisene#viga=link`);
  });

  test("a first login creates the client once", async () => {
    const { deps } = setup();
    await signIn(deps);
    await signIn(deps);
    expect(await db.select().from(clients)).toHaveLength(1);
  });
});

describe("the login page's language (fix round 1)", () => {
  const localeOf = async (email: string) => (await db.select({ locale: clients.locale }).from(clients).where(eq(clients.email, email)))[0]?.locale;

  test("a first login through the link asked from the Russian page makes a Russian account and opens /ru/konto", async () => {
    const { deps } = setup();
    const { devLink } = await (await call(deps, "/login", { body: { email: EMAIL, locale: "ru" } })).json();
    expect(devLink).toBe(`${SITE}/api/konto/verify?t=${tokenOf(devLink)}&l=ru`);
    const res = await call(deps, pathOf(devLink));
    expect(res.headers.get("location")).toBe(`${SITE}/ru/konto#sisse`);
    expect(await localeOf(EMAIL)).toBe("ru");
  });

  test("a first login with the code on the Russian page makes a Russian account", async () => {
    const { deps } = setup();
    const { devCode } = await (await call(deps, "/login", { body: { email: EMAIL, locale: "ru" } })).json();
    expect(await (await call(deps, "/code", { body: { email: EMAIL, code: devCode, locale: "ru" } })).json()).toEqual({ ok: true, locale: "ru" });
    expect(await localeOf(EMAIL)).toBe("ru");
  });

  test("an existing Estonian account keeps its language from the Russian page, by link and by code", async () => {
    const { deps } = setup();
    await db.insert(clients).values({ email: EMAIL, locale: "et" });
    const a = await (await call(deps, "/login", { body: { email: EMAIL, locale: "ru" } })).json();
    expect((await call(deps, pathOf(a.devLink))).headers.get("location")).toBe(`${SITE}/konto#sisse`);
    const b = await (await call(deps, "/login", { body: { email: EMAIL, locale: "ru" } })).json();
    expect(await (await call(deps, "/code", { body: { email: EMAIL, code: b.devCode, locale: "ru" } })).json()).toEqual({ ok: true, locale: "et" });
    expect(await localeOf(EMAIL)).toBe("et");
  });

  test("a used, unknown or expired link from the Russian page opens the Russian login page", async () => {
    const { deps } = setup();
    expect((await call(deps, `/verify?t=${"A".repeat(43)}&l=ru`)).headers.get("location")).toBe(`${SITE}/ru/konto/sisene#viga=link`);
    const { devLink } = await (await call(deps, "/login", { body: { email: EMAIL, locale: "ru" } })).json();
    expect((await call(deps, pathOf(devLink))).headers.get("location")).toBe(`${SITE}/ru/konto#sisse`);
    expect((await call(deps, pathOf(devLink))).headers.get("location")).toBe(`${SITE}/ru/konto/sisene#viga=link`); // used
    const old = await (await call(deps, "/login", { body: { email: EMAIL, locale: "ru" } })).json();
    const later = setup({ now: new Date(NOW.getTime() + 30 * 60_000 + 1) }).deps;
    expect((await call(later, pathOf(old.devLink))).headers.get("location")).toBe(`${SITE}/ru/konto/sisene#viga=link`); // expired
  });

  test("anything but et or ru is no language: Estonian pages and an Estonian account, as before", async () => {
    const { deps } = setup();
    expect((await call(deps, `/verify?t=${"A".repeat(43)}&l=fr`)).headers.get("location")).toBe(`${SITE}/konto/sisene#viga=link`);
    const a = await (await call(deps, "/login", { body: { email: EMAIL, locale: "fr" } })).json();
    expect(a.devLink).toBe(`${SITE}/api/konto/verify?t=${tokenOf(a.devLink)}`); // no l
    expect((await call(deps, `/verify?t=${tokenOf(a.devLink)}&l=xx`)).headers.get("location")).toBe(`${SITE}/konto#sisse`);
    expect(await localeOf(EMAIL)).toBe("et");
    const other = "mari@example.test";
    const b = await (await call(deps, "/login", { body: { email: other } })).json();
    expect(await (await call(deps, "/code", { body: { email: other, code: b.devCode, locale: 7 } })).json()).toEqual({ ok: true, locale: "et" });
  });

  test("the e-mailed link carries the page's language; the e-mail's own language stays the account's", async () => {
    const { mails } = resend();
    const { deps, flush } = setup({ dev: false });
    await call(deps, "/login", { body: { email: MAILED, locale: "ru" } });
    await db.insert(clients).values({ email: "olga@example.com", locale: "ru" });
    await call(deps, "/login", { body: { email: "olga@example.com", locale: "et" } }); // a Russian account, asked from the Estonian page
    await flush();
    const [newcomer, olga] = mails();
    const linkOf = (mail: { text: string }) => mail.text.match(/https:\/\/\S+/)![0];
    expect(newcomer.subject).toMatch(/код входа/);
    expect(linkOf(newcomer)).toMatch(/\/api\/konto\/verify\?t=[\w-]+&l=ru$/);
    expect(newcomer.html).toContain(`href="${linkOf(newcomer).replace("&", "&amp;")}"`);
    expect(olga.subject).toMatch(/код входа/);
    expect(linkOf(olga)).toMatch(/\/api\/konto\/verify\?t=[\w-]+$/);
    // the newcomer's link makes a Russian account
    expect((await call(deps, pathOf(linkOf(newcomer)))).headers.get("location")).toBe(`${SITE}/ru/konto#sisse`);
    expect(await localeOf(MAILED)).toBe("ru");
  });
});

describe("logout and me", () => {
  test("logout ends this session (reason logout) and clears both cookies; /me then says so", async () => {
    const { deps } = setup();
    const cookie = await signIn(deps);
    const res = await call(deps, "/logout", { method: "POST", cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.getSetCookie()).toEqual(clearedCookies());
    expect((await sessions())[0]).toMatchObject({ endReason: "logout" });
    const me = await call(deps, "/me", { cookie });
    expect(me.status).toBe(401);
    expect(await me.json()).toEqual({ ok: false, reason: "logout" });
  });

  test("logout is cross-site protected and leaves the session alone", async () => {
    const { deps } = setup();
    const cookie = await signIn(deps);
    const res = await call(deps, "/logout", { method: "POST", cookie, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect((await call(deps, "/me", { cookie })).status).toBe(200);
  });

  test("logout with a cookie that is not a session still answers ok", async () => {
    const { deps } = setup();
    const res = await call(deps, "/logout", { method: "POST", cookie: `__Host-mslab_client=${"B".repeat(43)}` });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(clearedCookies());
  });

  test("a session unused for 180 days is 401 { reason: \"expired\" }", async () => {
    const { deps } = setup();
    const cookie = await signIn(deps);
    const old = setup({ now: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS + 1000) }).deps;
    const res = await call(old, "/me", { cookie });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "expired" });
  });

  test("the cookies are sent again when the session is renewed (at most once a day), so they outlive the first 180 days", async () => {
    const day = 86_400_000;
    const at = (days: number, extraMs = 0) => setup({ now: new Date(NOW.getTime() + days * day + extraMs) }).deps;
    const cookie = await signIn(setup().deps);
    const raw = rawOf(cookie);

    const hour = await call(at(0, 3_600_000), "/me", { cookie });
    expect(hour.status).toBe(200);
    expect(hour.headers.getSetCookie()).toEqual([]); // not renewed within the first day

    const d100 = await call(at(100), "/me", { cookie });
    expect(d100.status).toBe(200);
    expect(d100.headers.getSetCookie()).toEqual(sessionCookies(raw)); // both cookies, 180 days from now
    expect((await sessions())[0].expiresAt).toEqual(new Date(NOW.getTime() + 280 * day));

    const same = await call(at(100, 3_600_000), "/me", { cookie });
    expect(same.status).toBe(200);
    expect(same.headers.getSetCookie()).toEqual([]); // the same day: nothing to renew

    const d181 = await call(at(181), "/me", { cookie }); // past the first 180 days: alive because day 100 renewed it
    expect(d181.status).toBe(200);
    expect(await d181.json()).toMatchObject({ ok: true, email: EMAIL });
    expect(d181.headers.getSetCookie()).toEqual(sessionCookies(raw));
  });

  test("an unknown session id is 401 { reason: \"none\" }", async () => {
    const { deps } = setup();
    const res = await call(deps, "/me", { cookie: `__Host-mslab_client=${"C".repeat(43)}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "none" });
    expect(res.headers.getSetCookie()).toEqual([clearedCookies()[1]]);
  });

  test("/me gives the name from the account", async () => {
    const { deps } = setup();
    const cookie = await signIn(deps);
    await db.update(clients).set({ name: "Kati Tamm" }).where(eq(clients.email, EMAIL));
    expect(await (await call(deps, "/me", { cookie })).json()).toEqual({ ok: true, email: EMAIL, name: "Kati Tamm" });
  });
});

describe("no account enumeration", () => {
  test("a known and an unknown address get the same answer", async () => {
    resend();
    const { deps } = setup({ dev: false });
    await db.insert(clients).values({ email: MAILED });
    const known = await call(deps, "/login", { body: { email: MAILED } });
    const unknown = await call(deps, "/login", { body: { email: "nobody@example.com" } });
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  });
});

describe("logs hold no personal data", () => {
  test("a whole sign-in with a failing provider, a failing store, a wrong code and the cap: no address, code, token or cookie", async () => {
    const f = resend(() => Response.json({ name: "validation_error", message: `${MAILED} is not allowed` }, { status: 422 }));
    const kv = fakeKv();
    const down = Object.assign(new Error(`down ${MAILED}`), { code: "ECONNRESET" });
    const { deps, flush } = setup({ dev: false, kv });
    await call(deps, "/login", { body: { email: MAILED } });
    await flush();
    const mail = f.mails()[0];
    const code = codeOf(mail);
    const token = mail.text.match(/\?t=([A-Za-z0-9_-]+)/)![1];
    kv.get = async () => { throw down; };
    await call(deps, "/code", { body: { email: MAILED, code: code === "000000" ? "111111" : "000000" } });
    const cookie = sessionCookie(await call(deps, "/code", { body: { email: MAILED, code } }))!;
    await call(deps, `/verify?t=${token}`);
    await call(deps, "/me", { cookie });
    await call(deps, "/logout", { method: "POST", cookie });
    await db.update(mailQuota).set({ sent: LOGIN_MAIL_DAILY_CAP });
    await call(deps, "/login", { body: { email: "other@example.com" } });

    const logged = (["info", "error", "log", "warn"] as const).flatMap((m) => vi.mocked(console[m]).mock.calls).flat().join("\n");
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of [MAILED, "kati", "other@example", code, token, rawOf(cookie)]) expect(logged).not.toContain(secret);
  });
});

// ---------- the data endpoints (dashboard, e-course, favourites, profile, newsletter, change requests, terms, deletion) ----------

const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

type Seeded = Awaited<ReturnType<typeof seedCourses>>;
let seeded: Seeded;

/** A published contact course with a session in 30 days, a published e-course (with two modules) and an unpublished e-course. */
async function seedCourses() {
  const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };
  const [lami] = await db.insert(courses).values({ ...base, slug: "kulmude-lami", type: "contact", title: { et: "Kulmude lamineerimine" }, published: true, priceGroup: 35000 }).returning();
  const [online] = await db.insert(courses).values({
    ...base, slug: "veebikursus", type: "e_learning", title: { et: "Veebikursus" }, published: true, price: 9500,
  }).returning();
  await addModules(db, online.id, [{ et: "Sissejuhatus" }, { et: "Praktika" }]);
  const [hidden] = await db.insert(courses).values({ ...base, slug: "peidus-kursus", type: "e_learning", title: { et: "Peidus" }, published: false, price: 100 }).returning();
  const [session] = await db.insert(courseSessions).values({ courseId: lami.id, startsAt: at(30), city: "Pärnu", venue: "Salong" }).returning();
  return { lami, online, hidden, session };
}

/** Signs in (development: the code comes back in the answer) and gives the client row, the cookie and the deps. */
async function account(opts: Setup & { email?: string } = {}) {
  const s = setup(opts);
  const email = opts.email ?? EMAIL;
  const cookie = await signIn(s.deps, email);
  const [client] = await db.select().from(clients).where(eq(clients.email, email));
  return { ...s, cookie, client };
}

const register = async (clientId: number | null, over: Partial<typeof registrations.$inferInsert> = {}) =>
  (await db.insert(registrations).values({
    courseId: seeded.lami.id, courseSessionId: seeded.session.id, kind: "group", name: "Kati Tamm", email: EMAIL, phone: "+3725551234", paymentChoice: "full", clientId, ...over,
  }).returning())[0];

const grantAccess = async (clientId: number, courseId: number, over: Partial<typeof courseAccess.$inferInsert> = {}) =>
  (await db.insert(courseAccess).values({ clientId, courseId, grantedBy: "admin@example.test", grantedAt: at(-1), expiresAt: at(180), ...over }).returning())[0];

const send = (deps: AccountDeps, method: string, path: string, cookie: string | undefined, body?: unknown) => call(deps, path, { method, cookie, body });

/** A request whose body is sent as it is (a string that may not be JSON). */
async function rawCall(deps: AccountDeps, method: string, path: string, cookie: string | undefined, rawBody: string): Promise<Response> {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.1" });
  if (cookie) headers.set("cookie", cookie);
  return (await handleAccountApi(new Request(`${SITE}/api/konto${path}`, { method, headers, body: rawBody }), deps))!;
}

describe("GET /api/konto: the dashboard", () => {
  beforeEach(async () => {
    seeded = await seedCourses();
  });

  test("the session's client: profile, cards, favourites and the prepayment instructions; private and uncached", async () => {
    const { deps, cookie, client } = await account();
    const reg = await register(client.id);
    await db.insert(clientFavourites).values({ clientId: client.id, courseId: seeded.online.id });
    await db.insert(settings).values({ key: "prepayment", value: { receiver: "MS LAB OÜ", iban: "EE00 0000", bank: "Pank", referencePrefix: "MS" } });
    const res = await call(deps, "", { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await res.json()).toEqual({
      client: { email: EMAIL, name: "", phone: "", locale: "et", newsletter: false, passwordSetAt: null },
      cards: [
        {
          kind: "contact", registrationId: reg.id, course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine" } },
          session: { startsAt: seeded.session.startsAt.toISOString(), city: "Pärnu", venue: "Salong", cancelled: false },
          status: "awaiting_prepayment", paymentChoice: "full", priceCents: 35000, paidCents: 0, createdAt: reg.createdAt.toISOString(),
          contract: null, contractRequested: false,
        },
      ],
      favourites: ["veebikursus"],
      prepayment: { receiver: "MS LAB OÜ", iban: "EE00 0000", bank: "Pank", referencePrefix: "MS" },
      resume: null,
    });
    expect((await call(deps, "/", { cookie })).status).toBe(200); // the trailing slash is the same endpoint
  });

  test("what was booked with this address before the first login is already there, and nobody else's is", async () => {
    await register(null); // the same address, before there was an account
    await register(null, { email: "mari@example.test", name: "Mari" });
    const { deps, cookie } = await account();
    const { cards } = await (await call(deps, "", { cookie })).json();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "contact", status: "awaiting_prepayment" });
  });

  test("without a session, after logout, and once another device has signed in: 401 with the reason, the hint cookie cleared", async () => {
    const { deps, cookie } = await account();
    const none = await call(deps, "", {});
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ ok: false, reason: "none" });
    expect(none.headers.getSetCookie()).toEqual([clearedCookies()[1]]);
    const other = await signIn(deps); // a second device
    const replaced = await call(deps, "", { cookie });
    expect(replaced.status).toBe(401);
    expect(await replaced.json()).toEqual({ ok: false, reason: "replaced" });
    expect(replaced.headers.getSetCookie()).toEqual([clearedCookies()[1]]);
    await call(deps, "/logout", { method: "POST", cookie: other });
    expect(await (await call(deps, "", { cookie: other })).json()).toEqual({ ok: false, reason: "logout" });
  });
});

describe("GET /api/konto/kursus/:slug: an e-course", () => {
  beforeEach(async () => {
    seeded = await seedCourses();
    await db.insert(pages).values({ key: "course_terms", title: { et: "Tingimused" }, body: { et: "Ligipääs on isiklik." } });
  });
  /** A signed-in account with a name (an account with none gives hers at the gate, ruling R19: tests/db/contracts-flows.test.ts). */
  const named = async () => {
    const a = await account();
    await db.update(clients).set({ name: "Kati Tamm" }).where(eq(clients.id, a.client.id));
    return a;
  };
  /** The gate's contract of the stored text, on both pages (client-data.ts GateTerms; no Russian text: the Estonian one). */
  const GATE = { text: { et: { title: "Tingimused", body: "Ligipääs on isiklik." }, ru: { title: "Tingimused", body: "Ligipääs on isiklik." } }, askName: null };

  test("with access: the view, with the terms still to accept; without it, or for another client's access, or an unknown course: 404", async () => {
    const { deps, cookie, client } = await named();
    const mari = (await db.insert(clients).values({ email: "mari@example.test" }).returning())[0];
    for (const slug of ["veebikursus", "peidus-kursus", "olematu", "kulmude-lami"]) {
      const res = await call(deps, `/kursus/${slug}`, { cookie });
      expect(res.status, slug).toBe(404);
      expect(await res.json()).toEqual({ ok: false });
    }
    await grantAccess(mari.id, seeded.online.id);
    expect((await call(deps, "/kursus/veebikursus", { cookie })).status).toBe(404); // Mari's access is Mari's
    await grantAccess(client.id, seeded.online.id);
    const res = await call(deps, "/kursus/veebikursus", { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      course: {
        slug: "veebikursus",
        title: { et: "Veebikursus" },
        modules: [{ id: expect.any(Number), title: { et: "Sissejuhatus" }, lessons: [] }, { id: expect.any(Number), title: { et: "Praktika" }, lessons: [] }],
      },
      access: { expiresAt: at(180).toISOString() },
      terms: { version: "1", accepted: false, ...GATE },
      progress: { done: 0, total: 0, next: null },
      completion: { lessons: { done: 0, total: 0, state: "done" }, test: null, practical: null, completedAt: null, protocolSent: false, certificate: null, certificateName: "" },
    });
  });

  test("active access to a course that was unpublished since stays: the card, the view and the acceptance", async () => {
    const { deps, cookie, client } = await named();
    await grantAccess(client.id, seeded.hidden.id);
    const view = await call(deps, "/kursus/peidus-kursus", { cookie });
    expect(view.status).toBe(200);
    const { terms } = await view.json();
    expect(terms).toEqual({ version: "1", accepted: false, ...GATE });
    expect((await call(deps, "/tingimused", { cookie, body: { slug: "peidus-kursus", version: terms.version } })).status).toBe(200);
    expect((await (await call(deps, "/kursus/peidus-kursus", { cookie })).json()).terms.accepted).toBe(true);
    const { cards } = await (await call(deps, "", { cookie })).json();
    expect(cards.map((c: { kind: string; course?: { slug: string } }) => c.kind === "ecourse" && c.course?.slug)).toEqual(["peidus-kursus"]);
  });

  test("no terms text stored: the view has nothing to accept, and an acceptance is refused as a changed version (nothing stored), so the page loads again", async () => {
    const { deps, cookie, client } = await named();
    await grantAccess(client.id, seeded.online.id);
    await db.delete(pages);
    const view = await (await call(deps, "/kursus/veebikursus", { cookie })).json();
    expect(view.terms).toEqual({ version: "1", accepted: true, text: null });
    const res = await call(deps, "/tingimused", { cookie, body: { slug: "veebikursus", version: view.terms.version } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "version" });
    expect(await db.select().from(termsAcceptances)).toEqual([]);
  });

  test("access that has ended is a 404; a slug that is not decodable or cannot be one is a 404, not a 500", async () => {
    const { deps, cookie, client } = await named();
    await grantAccess(client.id, seeded.online.id, { expiresAt: at(-1) });
    expect((await call(deps, "/kursus/veebikursus", { cookie })).status).toBe(404);
    for (const raw of ["%E0%A4%A", "%00", "a%00b", "%01", "x".repeat(300), "a%2Fb"]) {
      const res = await call(deps, `/kursus/${raw}`, { cookie });
      expect(res.status, raw).toBe(404);
      expect(await res.json(), raw).toEqual({ ok: false });
    }
  });

  test("the terms: the page sends back the version it showed; accepting stores it, the view then has none to accept; a changed version asks again", async () => {
    const { deps, cookie, client } = await named();
    await grantAccess(client.id, seeded.online.id);
    const shown = (await (await call(deps, "/kursus/veebikursus", { cookie })).json()).terms;
    expect(shown.version).toBe("1");
    const accept = await call(deps, "/tingimused", { cookie, body: { slug: "veebikursus", version: shown.version } });
    expect(accept.status).toBe(200);
    expect(await accept.json()).toEqual({ ok: true });
    expect(await db.select().from(termsAcceptances)).toEqual([{ clientId: client.id, courseId: seeded.online.id, termsVersion: "1", acceptedAt: NOW }]);
    expect((await (await call(deps, "/kursus/veebikursus", { cookie })).json()).terms).toEqual({ version: "1", accepted: true, text: null });
    await db.insert(settings).values({ key: "courseTermsVersion", value: "2026-10-02T09:00:00.000Z" });
    expect((await (await call(deps, "/kursus/veebikursus", { cookie })).json()).terms).toMatchObject({ version: "2026-10-02T09:00:00.000Z", accepted: false });
  });

  test("a version that is not the current one: 409 { error: \"version\" }, nothing stored; the current one, after reloading, is accepted", async () => {
    const { deps, cookie, client } = await named();
    await grantAccess(client.id, seeded.online.id);
    const seen = (await (await call(deps, "/kursus/veebikursus", { cookie })).json()).terms.version; // the page is open with the old text
    await db.insert(settings).values({ key: "courseTermsVersion", value: "2026-10-02T09:00:00.000Z" }); // the admin saves new terms
    const stale = await call(deps, "/tingimused", { cookie, body: { slug: "veebikursus", version: seen } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ ok: false, error: "version" });
    expect(stale.headers.get("cache-control")).toBe("private, no-store");
    expect(await db.select().from(termsAcceptances)).toEqual([]);
    const current = (await (await call(deps, "/kursus/veebikursus", { cookie })).json()).terms.version;
    expect((await call(deps, "/tingimused", { cookie, body: { slug: "veebikursus", version: current } })).status).toBe(200);
    expect((await db.select().from(termsAcceptances)).map((t) => t.termsVersion)).toEqual(["2026-10-02T09:00:00.000Z"]);
  });

  test("accepting terms needs active access: another client's access, none, ended, unknown: 404 { error: \"slug\" }, before the version is looked at", async () => {
    const { deps, cookie, client } = await named();
    const mari = (await db.insert(clients).values({ email: "mari@example.test" }).returning())[0];
    await grantAccess(mari.id, seeded.online.id);
    await grantAccess(client.id, seeded.hidden.id, { expiresAt: at(-1) });
    for (const slug of ["veebikursus", "peidus-kursus", "olematu", "kulmude-lami"]) {
      for (const version of ["1", "not the current one"]) {
        const res = await call(deps, "/tingimused", { cookie, body: { slug, version } });
        expect(res.status, slug).toBe(404);
        expect(await res.json()).toEqual({ ok: false, error: "slug" });
      }
    }
    expect(await db.select().from(termsAcceptances)).toEqual([]);
  });

  test("a body without a version, or with one that is not a string of at most 64 characters: 400 { error: \"version\" }", async () => {
    const { deps, cookie, client } = await named();
    await grantAccess(client.id, seeded.online.id);
    for (const version of [undefined, null, 1, ["1"], "", "v".repeat(65), "a\u0000b"]) {
      const res = await call(deps, "/tingimused", { cookie, body: { slug: "veebikursus", version } });
      expect(res.status, JSON.stringify(version)).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "version" });
    }
    expect((await call(deps, "/tingimused", { cookie, body: { slug: "veebikursus", version: "1" } })).status).toBe(200);
    expect(await db.select().from(termsAcceptances)).toHaveLength(1);
  });
});

describe("favourites", () => {
  beforeEach(async () => {
    seeded = await seedCourses();
  });

  test("POST /lemmikud hearts and un-hearts; POST /lemmikud/merge adds the browser's list, ignoring what is unknown or unpublished", async () => {
    const { deps, cookie } = await account();
    const heart = await call(deps, "/lemmikud", { cookie, body: { slug: "kulmude-lami", on: true } });
    expect(heart.status).toBe(200);
    expect(await heart.json()).toEqual({ ok: true, favourites: ["kulmude-lami"] });
    const merged = await call(deps, "/lemmikud/merge", { cookie, body: { slugs: ["veebikursus", "olematu", "peidus-kursus", "kulmude-lami", "veebikursus"] } });
    expect(merged.status).toBe(200);
    expect(await merged.json()).toEqual({ ok: true, favourites: ["veebikursus", "kulmude-lami"] });
    expect(await (await call(deps, "/lemmikud", { cookie, body: { slug: "kulmude-lami", on: false } })).json()).toEqual({ ok: true, favourites: ["veebikursus"] });
    expect((await (await call(deps, "", { cookie })).json()).favourites).toEqual(["veebikursus"]);
  });

  test("hearting a course that is not published or does not exist: 404 { error: \"slug\" }, nothing stored", async () => {
    const { deps, cookie } = await account();
    for (const slug of ["peidus-kursus", "olematu"]) {
      const res = await call(deps, "/lemmikud", { cookie, body: { slug, on: true } });
      expect(res.status, slug).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "slug" });
    }
    expect(await db.select().from(clientFavourites)).toEqual([]);
  });

  test("a merge of 100 slugs of 200 characters is accepted; 101, or one slug over 200, is 400 { error: \"slugs\" }", async () => {
    const { deps, cookie } = await account();
    const long = (i: number) => `${String(i).padStart(3, "0")}${"x".repeat(197)}`; // 200 characters
    const res = await call(deps, "/lemmikud/merge", { cookie, body: { slugs: Array.from({ length: 100 }, (_, i) => long(i)) } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, favourites: [] });
    for (const slugs of [Array.from({ length: 101 }, (_, i) => `s${i}`), ["x".repeat(201)]]) {
      const bad = await call(deps, "/lemmikud/merge", { cookie, body: { slugs } });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ ok: false, error: "slugs" });
    }
  });

  test("GET /lemmikud?l=…: the published favourites as the catalogue's cards, newest first, in the page's language; private, and the client's own", async () => {
    const { deps, cookie, client } = await account();
    const empty = await call(deps, "/lemmikud", { cookie });
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toBe("private, no-store");
    expect(await empty.json()).toEqual({ ok: true, favourites: [], cards: [] });

    // hearted: the unpublished course first (it was hidden since: not shown), then the e-course, the contact course last (the newest)
    await db.insert(clientFavourites).values([
      { clientId: client.id, courseId: seeded.hidden.id, createdAt: at(-3) },
      { clientId: client.id, courseId: seeded.online.id, createdAt: at(-2) },
      { clientId: client.id, courseId: seeded.lami.id, createdAt: at(-1) },
    ]);
    type Answer = { ok: boolean; favourites: string[]; cards: { slug: string; card: Record<string, unknown> }[] };
    const et = (await (await call(deps, "/lemmikud", { cookie })).json()) as Answer;
    expect(et.favourites).toEqual(["kulmude-lami", "veebikursus"]);
    expect(et.cards.map((c) => c.slug)).toEqual(["kulmude-lami", "veebikursus"]);
    expect(et.cards[0].card).toEqual({
      id: seeded.lami.id, type: "contact", href: "/koolitused/kulmude-lami", title: "Kulmude lamineerimine", summary: "", image: "", imageAlt: "Kulmude lamineerimine",
      badge: null, tags: ["Kontaktõpe", "Baaskoolitus"], meta: { lead: formatDayMonth(seeded.session.startsAt, "et"), text: "Pärnu" }, price: formatEUR(35000, "et"),
    });
    expect(et.cards[1].card).toMatchObject({ type: "e_learning", href: "/koolitused/veebikursus", meta: { text: "Veebis · alusta kohe" }, price: formatEUR(9500, "et") });

    const ru = (await (await call(deps, "/lemmikud?l=ru", { cookie })).json()) as Answer;
    expect(ru.cards.map((c) => c.card.href)).toEqual(["/ru/koolitused/kulmude-lami", "/ru/koolitused/veebikursus"]);
    expect(ru.cards[1].card.meta).toEqual({ text: "Онлайн · начать сразу" });
    // any other language is Estonian
    const other = (await (await call(deps, "/lemmikud?l=fi", { cookie })).json()) as Answer;
    expect(other.cards[0].card.href).toBe("/koolitused/kulmude-lami");

    // another client sees none of them
    const b = await account({ email: "mari@example.test" });
    expect(await (await call(b.deps, "/lemmikud", { cookie: b.cookie })).json()).toEqual({ ok: true, favourites: [], cards: [] });
  });

  test("a client's hearts are its own", async () => {
    const a = await account();
    const b = await account({ email: "mari@example.test" });
    await call(a.deps, "/lemmikud", { cookie: a.cookie, body: { slug: "kulmude-lami", on: true } });
    expect((await (await call(b.deps, "", { cookie: b.cookie })).json()).favourites).toEqual([]);
    expect(await (await call(b.deps, "/lemmikud", { cookie: b.cookie, body: { slug: "kulmude-lami", on: false } })).json()).toEqual({ ok: true, favourites: [] });
    expect((await (await call(a.deps, "", { cookie: a.cookie })).json()).favourites).toEqual(["kulmude-lami"]);
  });
});

describe("profile and newsletter", () => {
  test("PATCH /andmed saves name, phone and language (trimmed); /me and the dashboard show them", async () => {
    const { deps, cookie } = await account();
    const res = await call(deps, "/andmed", { method: "PATCH", cookie, body: { name: "  Kati   Tamm ", phone: " +372 555 1234 ", locale: "ru" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await (await call(deps, "/me", { cookie })).json()).toEqual({ ok: true, email: EMAIL, name: "Kati Tamm" });
    expect((await (await call(deps, "", { cookie })).json()).client).toEqual({ email: EMAIL, name: "Kati Tamm", phone: "+372 555 1234", locale: "ru", newsletter: false, passwordSetAt: null });
  });

  test("POST /uudiskiri on: a confirmed subscriber for the account's address, no mail; off deletes it", async () => {
    const f = resend();
    const { deps, cookie, client, queued, flush } = await account({ email: MAILED });
    const on = await call(deps, "/uudiskiri", { cookie, body: { on: true } });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true });
    const [sub] = await db.select().from(subscribers);
    expect(sub).toMatchObject({ email: MAILED, clientId: client.id, confirmedAt: NOW, consentAt: NOW });
    expect((await (await call(deps, "", { cookie })).json()).client.newsletter).toBe(true);
    expect(queued()).toBe(0); // the login proved the address: nothing to confirm by mail
    await flush();
    expect(f.calls).toEqual([]);
    expect(await (await call(deps, "/uudiskiri", { cookie, body: { on: false } })).json()).toEqual({ ok: true });
    expect(await db.select().from(subscribers)).toEqual([]);
    expect((await (await call(deps, "", { cookie })).json()).client.newsletter).toBe(false);
  });
});

describe("POST /muutmine: a request to cancel or change a registration", () => {
  beforeEach(async () => {
    seeded = await seedCourses();
  });

  test("stores a change_request for the admin's inbox, tells Maria after the response (reply to the client), and changes nothing else", async () => {
    const f = resend();
    const { deps, cookie, client, queued, flush } = await account();
    const reg = await register(client.id, { status: "confirmed", paidCents: 35000 });
    const res = await call(deps, "/muutmine", { cookie, body: { registrationId: reg.id, kind: "cancel", message: "  Haigestusin.  " } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await db.select().from(requests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "change_request", clientId: client.id, handled: false, payload: { registrationId: reg.id, kind: "cancel", message: "Haigestusin.", email: EMAIL } });
    expect((await db.select().from(registrations).where(eq(registrations.id, reg.id)))[0]).toEqual(reg);

    expect(queued()).toBe(1);
    expect(f.mails()).toHaveLength(0); // nothing goes out before the response is sent
    await flush();
    const [mail] = f.mails();
    expect(mail).toMatchObject({ to: "maria@example.test" });
    expect(mail.subject).toMatch(/^Soov registreering tühistada: Kulmude lamineerimine, /);
    expect(mail.text).toContain("Haigestusin.");
    expect(mail.text).toContain(`Admin: ${SITE}/admin`);
    expect(f.calls.filter((c) => c.url.includes("resend"))[0].body).toMatchObject({ reply_to: EMAIL });
  });

  test("another client's registration, one linked to nobody and one that does not exist: 404 { error: \"registration\" }; nothing stored, nobody told", async () => {
    const f = resend();
    const { deps, cookie, queued, flush } = await account();
    const mari = (await db.insert(clients).values({ email: "mari@example.test" }).returning())[0];
    const maris = await register(mari.id, { email: "mari@example.test", name: "Mari" });
    const loose = await register(null);
    for (const registrationId of [maris.id, loose.id, 987654]) {
      const res = await call(deps, "/muutmine", { cookie, body: { registrationId, kind: "cancel", message: "" } });
      expect(res.status, String(registrationId)).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "registration" });
    }
    expect(await db.select().from(requests)).toEqual([]);
    expect(queued()).toBe(0);
    await flush();
    expect(f.calls).toEqual([]);
  });

  test("a cancelled registration, a past one and one whose training was called off: 404 { error: \"registration\" }, nothing stored, nobody told", async () => {
    const f = resend();
    const { deps, cookie, client, queued, flush } = await account();
    const past = (await db.insert(courseSessions).values({ courseId: seeded.lami.id, startsAt: at(-5), city: "Tartu" }).returning())[0];
    const called = (await db.insert(courseSessions).values({ courseId: seeded.lami.id, startsAt: at(20), city: "Tartu", status: "cancelled" }).returning())[0];
    const regs = [
      await register(client.id, { status: "cancelled" }),
      await register(client.id, { status: "confirmed", courseSessionId: past.id }),
      await register(client.id, { status: "confirmed", courseSessionId: called.id }),
    ];
    for (const reg of regs) {
      const res = await call(deps, "/muutmine", { cookie, body: { registrationId: reg.id, kind: "cancel", message: "" } });
      expect(res.status, String(reg.id)).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "registration" });
    }
    expect(await db.select().from(requests)).toEqual([]);
    expect(queued()).toBe(0);
    await flush();
    expect(f.calls).toEqual([]);
  });

  test("5 an hour per client, then 429 { error: \"rate\" }: no row, no mail; a failing rate store lets it through", async () => {
    const f = resend();
    const kv = fakeKv();
    const { deps, cookie, client, queued, flush } = await account({ kv });
    const reg = await register(client.id);
    const ask = () => call(deps, "/muutmine", { cookie, body: { registrationId: reg.id, kind: "change", message: "" } });
    for (let i = 0; i < 5; i++) expect((await ask()).status).toBe(200);
    const limited = await ask();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false, error: "rate" });
    expect(await db.select().from(requests)).toHaveLength(5);
    expect(queued()).toBe(5);
    await flush();
    expect(f.mails()).toHaveLength(5);
    // the count is per client: another client is not held back
    const other = await account({ kv, email: "mari@example.test" });
    const maris = await register(other.client.id, { email: "mari@example.test" });
    expect((await call(other.deps, "/muutmine", { cookie: other.cookie, body: { registrationId: maris.id, kind: "change", message: "" } })).status).toBe(200);
    // a failing store: allowed, and the log names no address
    kv.get = async () => { throw new Error(`down ${EMAIL}`); };
    expect((await ask()).status).toBe(200);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).not.toContain("kati");
  });

  test("bad bodies: 400 with the field, before the rate limit and the database", async () => {
    const { deps, cookie, client } = await account();
    const reg = await register(client.id);
    const cases: [unknown, string][] = [
      ["not json", "body"], ["[]", "body"], ["null", "body"], [{}, "registrationId"],
      [{ registrationId: String(reg.id), kind: "cancel", message: "" }, "registrationId"],
      [{ registrationId: 0, kind: "cancel", message: "" }, "registrationId"],
      [{ registrationId: 2_147_483_648, kind: "cancel", message: "" }, "registrationId"],
      [{ registrationId: reg.id, kind: "delete", message: "" }, "kind"],
      [{ registrationId: reg.id, kind: "Cancel", message: "" }, "kind"],
      [{ registrationId: reg.id, kind: "cancel", message: 7 }, "message"],
      [{ registrationId: reg.id, kind: "cancel", message: "m".repeat(1001) }, "message"],
      [{ registrationId: reg.id, kind: "cancel", message: "a\u0000b" }, "message"],
      [{ registrationId: reg.id, kind: "cancel", message: "a\ud800" }, "message"],
    ];
    for (const [body, error] of cases) {
      const res = await rawCall(deps, "POST", "/muutmine", cookie, typeof body === "string" ? body : JSON.stringify(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json(), JSON.stringify(body)).toEqual({ ok: false, error });
    }
    expect(await db.select().from(requests)).toEqual([]);
    // a message of exactly 1000 characters is fine
    expect((await call(deps, "/muutmine", { cookie, body: { registrationId: reg.id, kind: "cancel", message: "m".repeat(1000) } })).status).toBe(200);
  });
});

describe("POST /kustuta: deleting the account", () => {
  beforeEach(async () => {
    seeded = await seedCourses();
  });

  test("deletes the client and what hangs on it, keeps the registration (unlinked, name and address as given), clears both cookies, ends the session", async () => {
    const { deps, cookie, client } = await account();
    const reg = await register(client.id);
    await grantAccess(client.id, seeded.online.id);
    await db.insert(clientFavourites).values({ clientId: client.id, courseId: seeded.lami.id });
    await db.insert(subscribers).values({ email: EMAIL, token: "t1", confirmedAt: NOW, clientId: client.id });
    const res = await call(deps, "/kustuta", { cookie, body: { confirm: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.getSetCookie()).toEqual(clearedCookies());
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await db.select().from(clients)).toEqual([]);
    expect(await sessions()).toEqual([]);
    expect(await db.select().from(courseAccess)).toEqual([]);
    expect(await db.select().from(clientFavourites)).toEqual([]);
    expect(await db.select().from(subscribers)).toEqual([]);
    expect((await db.select().from(registrations))[0]).toEqual({ ...reg, clientId: null });
    // the old cookie is nothing now
    const after = await call(deps, "/me", { cookie });
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ ok: false, reason: "none" });
  });

  test("a login code or link still waiting (\"Saada uuesti\") does not bring the account back: it is dead after the deletion", async () => {
    const { deps, cookie } = await account();
    const second = await (await call(deps, "/login", { body: { email: EMAIL } })).json(); // a second live login, as after "Saada uuesti"
    const third = await (await call(deps, "/login", { body: { email: EMAIL } })).json();
    expect(await tokens()).toHaveLength(3); // the used one and two live
    expect((await call(deps, "/kustuta", { cookie, body: { confirm: true } })).status).toBe(200);
    expect(await tokens()).toEqual([]);
    const code = await call(deps, "/code", { body: { email: EMAIL, code: second.devCode } });
    expect(code.status).toBe(400);
    expect(await code.json()).toEqual({ ok: false, error: "expired" });
    expect(code.headers.getSetCookie()).toEqual([]);
    const link = await call(deps, `/verify?t=${tokenOf(third.devLink)}`);
    expect(link.status).toBe(303);
    expect(link.headers.get("location")).toBe(`${SITE}/konto/sisene#viga=link`);
    expect(link.headers.getSetCookie()).toEqual([]);
    expect(await db.select().from(clients)).toEqual([]);
  });

  test("a renewed session's cookies are not sent: the answer clears them", async () => {
    const first = await account();
    const later = setup({ now: at(100) }).deps;
    const res = await call(later, "/kustuta", { cookie: first.cookie, body: { confirm: true } });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(clearedCookies());
  });

  test("the confirmation e-mail goes out after the response, in the client's language, to a real address only", async () => {
    const f = resend();
    const dev = await account({ email: MAILED });
    await db.update(clients).set({ locale: "ru" }).where(eq(clients.id, dev.client.id));
    const live = setup({ dev: false });
    const res = await call(live.deps, "/kustuta", { cookie: dev.cookie, body: { confirm: true } });
    expect(res.status).toBe(200);
    expect(live.queued()).toBe(1);
    expect(f.mails()).toHaveLength(0);
    await live.flush();
    const [mail] = f.mails();
    expect(mail).toMatchObject({ to: MAILED, subject: "Личный кабинет MS LAB удалён" });
    expect(mail.text).toContain("Ваши регистрации остаются у\u00a0Марии.");
    expect(mail.html).toContain("Ваши регистрации остаются у\u00a0Марии.");
  });

  test("no e-mail to a sample address, and none in development", async () => {
    const f = resend();
    const sample = await account({ email: EMAIL });
    const live = setup({ dev: false });
    expect((await call(live.deps, "/kustuta", { cookie: sample.cookie, body: { confirm: true } })).status).toBe(200);
    expect(live.queued()).toBe(0);
    const real = await account({ email: MAILED });
    const dev = setup({ dev: true });
    expect((await call(dev.deps, "/kustuta", { cookie: real.cookie, body: { confirm: true } })).status).toBe(200);
    expect(dev.queued()).toBe(0);
    await live.flush();
    await dev.flush();
    expect(f.calls).toEqual([]);
    expect(await db.select().from(clients)).toEqual([]); // both accounts are gone all the same
  });

  test("without { confirm: true }: 400 { error: \"confirm\" }, the account and the session stay", async () => {
    const { deps: devDeps, cookie, queued } = await account();
    const deps: AccountDeps = { ...devDeps, dev: false };
    for (const body of [{}, { confirm: false }, { confirm: "true" }, { confirm: 1 }, "x", []]) {
      const res = await call(deps, "/kustuta", { cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: typeof body === "object" && !Array.isArray(body) ? "confirm" : "body" });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(await db.select().from(clients)).toHaveLength(1);
    expect(queued()).toBe(0);
    expect((await call(deps, "/me", { cookie })).status).toBe(200);
  });

  test("a cross-site request is refused before anything is deleted", async () => {
    const { deps, cookie } = await account();
    const res = await call(deps, "/kustuta", { cookie, body: { confirm: true }, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(await db.select().from(clients)).toHaveLength(1);
  });
});

describe("every endpoint behind a session answers through the session", () => {
  beforeEach(async () => {
    seeded = await seedCourses();
    await db.insert(pages).values({ key: "course_terms", title: { et: "Tingimused" }, body: { et: "Ligipääs on isiklik." } });
  });

  // [method, path, the body of a request that succeeds for a client with that registration (id) and access to the e-course, the same endpoint with a body it refuses]
  type Endpoint = [string, string, (registrationId: number) => unknown, unknown];
  const ENDPOINTS: Endpoint[] = [
    ["GET", "", () => undefined, undefined],
    ["GET", "/kursus/veebikursus", () => undefined, undefined],
    ["POST", "/lemmikud", () => ({ slug: "kulmude-lami", on: true }), {}],
    ["POST", "/lemmikud/merge", () => ({ slugs: ["kulmude-lami"] }), {}],
    ["PATCH", "/andmed", () => ({ name: "Kati", phone: "", locale: "et" }), {}],
    ["POST", "/uudiskiri", () => ({ on: true }), {}],
    ["POST", "/muutmine", (id) => ({ registrationId: id, kind: "cancel", message: "" }), {}],
    // (the account has no name: it gives hers with the acceptance, ruling R19)
    ["POST", "/tingimused", () => ({ slug: "veebikursus", version: "1", name: "Kati Tamm" }), {}],
  ];
  test.each(ENDPOINTS)("%s %s at day 100 sends the renewed session's cookies, on success and on a refusal alike", async (method, path, okBody, bad) => {
    // a date still ahead on day 100 (a change request for a training that has begun is refused)
    const far = (await db.insert(courseSessions).values({ courseId: seeded.lami.id, startsAt: at(200), city: "Tartu" }).returning())[0];
    for (const [label, status] of [["success", 200], ["refusal", null]] as const) {
      for (const table of [termsAcceptances, clientFavourites, courseAccess, registrations, requests, subscribers]) await db.delete(table); // the second round starts as the first
      const first = await account();
      const reg = await register(first.client.id, { courseSessionId: far.id });
      await grantAccess(first.client.id, seeded.online.id);
      const body = label === "success" ? okBody(reg.id) : bad;
      const later = setup({ now: at(100) });
      const res = await send(later.deps, method, path, first.cookie, body);
      if (status) expect(res.status, `${method} ${path}`).toBe(status); // the success case really is one
      else expect(res.status).toBeLessThan(500);
      expect(res.headers.getSetCookie(), `${label} ${method} ${path}`).toEqual(sessionCookies(rawOf(first.cookie)));
      // the same day again: nothing to renew
      const again = await send(later.deps, method, path, first.cookie, body);
      expect(again.headers.getSetCookie()).toEqual([]);
    }
  });

  test("the dashboard renews the session in the database too (180 days from the day it was used)", async () => {
    const first = await account();
    const later = setup({ now: at(100) });
    expect((await call(later.deps, "", { cookie: first.cookie })).status).toBe(200);
    expect((await sessions())[0].expiresAt).toEqual(new Date(at(100).getTime() + CLIENT_SESSION_TTL_MS));
  });

  test.each(ENDPOINTS)("%s %s with no session: 401, the body is not even looked at, nothing is stored", async (method, path, okBody) => {
    const { deps, queued } = setup();
    const res = await send(deps, method, path, undefined, okBody(1));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "none" });
    expect(queued()).toBe(0);
  });

  test("a bad body is 400 { error: <field> } on every endpoint, never a 500, and nothing changes", async () => {
    const { deps, cookie } = await account();
    const cases: [string, string, unknown, string][] = [
      ["POST", "/lemmikud", { slug: 5, on: true }, "slug"],
      ["POST", "/lemmikud", { slug: "x", on: "yes" }, "on"],
      ["POST", "/lemmikud", "{", "body"],
      ["POST", "/lemmikud/merge", { slugs: "kulmude-lami" }, "slugs"],
      ["POST", "/lemmikud/merge", { slugs: [1] }, "slugs"],
      ["POST", "/lemmikud/merge", "null", "body"],
      ["PATCH", "/andmed", { name: "x".repeat(121), phone: "", locale: "et" }, "name"],
      ["PATCH", "/andmed", { name: "x", phone: "1".repeat(41), locale: "et" }, "phone"],
      ["PATCH", "/andmed", { name: "x", phone: "", locale: "en" }, "locale"],
      ["PATCH", "/andmed", { name: "a\u0000b", phone: "", locale: "et" }, "name"],
      ["PATCH", "/andmed", { name: 1, phone: "", locale: "et" }, "name"],
      ["PATCH", "/andmed", "[]", "body"],
      ["POST", "/uudiskiri", { on: "true" }, "on"],
      ["POST", "/uudiskiri", {}, "on"],
      ["POST", "/tingimused", { slug: "", version: "1" }, "slug"],
      ["POST", "/tingimused", { slug: "a".repeat(201), version: "1" }, "slug"],
      ["POST", "/tingimused", { slug: "veebikursus" }, "version"],
      ["POST", "/lemmikud", { slug: "x", on: true, padding: "p".repeat(5000) }, "body"], // longer than the endpoint reads
    ];
    for (const [method, path, body, error] of cases) {
      const res = await rawCall(deps, method, path, cookie, typeof body === "string" ? body : JSON.stringify(body));
      expect(res.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error });
    }
    expect((await db.select().from(clients))[0]).toMatchObject({ name: "", phone: "", locale: "et" });
    expect(await db.select().from(clientFavourites)).toEqual([]);
  });
});

describe("the data endpoints log no personal data", () => {
  beforeEach(async () => {
    seeded = await seedCourses();
  });

  test("a whole round with a failing provider and a failing store: no address, name, phone, message or session id", async () => {
    resend(() => Response.json({ name: "validation_error", message: `${MAILED} is not allowed` }, { status: 422 }));
    const kv = fakeKv();
    const { deps, cookie, client, flush } = await account({ kv, email: MAILED });
    const live: AccountDeps = { ...deps, dev: false };
    const reg = await register(client.id, { name: "Kati Tamm", phone: "+3725551234", email: MAILED });
    await call(live, "/andmed", { method: "PATCH", cookie, body: { name: "Kati Salajane", phone: "+3725559999", locale: "ru" } });
    kv.get = async () => { throw Object.assign(new Error(`down ${EMAIL} Kati Salajane`), { code: "ECONNRESET" }); };
    await call(live, "/muutmine", { cookie, body: { registrationId: reg.id, kind: "cancel", message: "Salajane sõnum" } });
    await call(live, "/uudiskiri", { cookie, body: { on: true } });
    await call(live, "/lemmikud", { cookie, body: { slug: "kulmude-lami", on: true } });
    await call(live, "/muutmine", { cookie, body: { registrationId: reg.id, kind: "cancel", message: "x".repeat(5000) } });
    await call(live, "/kustuta", { cookie, body: { confirm: true } });
    await flush();
    const logged = (["info", "error", "log", "warn"] as const).flatMap((m) => vi.mocked(console[m]).mock.calls).flat().join("\n");
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of ["kati@", "Kati", "Salajane", "+372", rawOf(cookie), "maria@example", MAILED]) expect(logged).not.toContain(secret);
  });
});

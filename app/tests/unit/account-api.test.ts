import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DELETE, HEAD, PATCH, POST } from "@/app/api/konto/[[...path]]/route";
import type { Db } from "@/db/client";
import { deletionMail, esc, loginMail, verifyLink } from "@/server/account-mail";
import { accountResponse, clearedCookies, handleAccountApi, sessionCookies, type AccountDeps } from "@/server/account-api";
import { isPrefetch } from "@/server/prefetch";
import { fakeKv } from "../fakes";

// The client account's router without a database: the answers that never need one (routing, the cross-site check, the
// cookies, the headers, bad input) and the e-mail. A database that throws on any use proves the bad-input answers come
// before it. The sign-in flows themselves are tests/db/account-api.test.ts.

const BASE = "https://mslab.example";

/** A database nobody may touch: any use throws `message`, so a test that gets its answer anyway never reached the database. */
const failingDb = (message: string) => new Proxy({}, { get: () => { throw new Error(message); } }) as unknown as Db;
const noDb = failingDb("the database was used");

function deps(over: Partial<AccountDeps> = {}): AccountDeps {
  return {
    db: noDb,
    env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: BASE },
    now: new Date("2026-10-02T10:00:00Z"),
    siteUrl: BASE,
    later: () => {},
    dev: false,
    ...over,
  };
}

const req = (path: string, init: RequestInit = {}) => new Request(`${BASE}/api/konto${path}`, init);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  req(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("routing and the cross-site check", () => {
  test("a path outside /api/konto is not ours (null), a lookalike too", async () => {
    for (const path of ["https://mslab.example/api/auth/request", "https://mslab.example/konto", "https://mslab.example/api/kontoX", "https://mslab.example/api"])
      expect(await handleAccountApi(new Request(path), deps()), path).toBeNull();
  });

  test("an unknown path or method under /api/konto answers 404 { ok: false }, with or without a session, and never reaches the database", async () => {
    const cookie = { cookie: `__Host-mslab_client=${"A".repeat(43)}` };
    const unknown = [
      req("/nothing"), req("/login"), req("/me", { method: "POST" }), req("/me", { method: "HEAD" }), req("/", { method: "HEAD" }),
      // known paths with the wrong method
      post("/", {}), req("/lemmikud/merge"), req("/andmed"), post("/andmed", {}), req("/uudiskiri"), req("/muutmine"), req("/tingimused"), req("/kustuta"),
      req("/kustuta", { method: "DELETE" }), req("/lemmikud", { method: "PATCH" }),
      req("/parool"), req("/parool", { method: "PATCH" }), req("/parool-login"),
      // the e-course path: one slug only, GET only
      post("/kursus/x", {}), req("/kursus"), req("/kursus/"), req("/kursus/x", { method: "PATCH" }), req("/Kursus/x"), req("/lemmikud/"),
      // the lesson paths: /kursus/<slug>/<lesson>[/progress | /tehtud | /fail/<file>], each with its own method
      post("/kursus/a/1", {}), req("/kursus/a/1", { method: "PATCH" }), req("/kursus/a/1/progress"), req("/kursus/a/1/tehtud"), post("/kursus/a/1/fail/2", {}),
      req("/kursus/a/1/other"), req("/kursus/a/1/fail"), req("/kursus/a/1/fail/"), req("/kursus/a/1/fail/2/3"), req("/kursus/a/1/progress/x"), req("/kursus/a/1/", { method: "GET" }),
    ];
    for (const r of unknown)
      for (const headers of [{}, cookie]) {
        const res = (await handleAccountApi(new Request(r.url, { method: r.method, headers, body: r.method === "POST" || r.method === "PATCH" ? "{}" : undefined }), deps()))!;
        expect(res.status, `${r.method} ${new URL(r.url).pathname}`).toBe(404);
        expect(await res.json()).toEqual({ ok: false });
      }
  });

  test("a cross-site POST, PATCH or DELETE is refused with 403 before anything else", async () => {
    for (const method of ["POST", "PATCH", "DELETE", "PUT"])
      for (const path of ["/login", "/code", "/logout", "/andmed", "/parool", "/parool-login", "/nothing"]) {
        const res = (await handleAccountApi(req(path, { method, headers: { origin: "https://evil.example" }, body: "{}" }), deps()))!;
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await res.json()).toEqual({ ok: false });
      }
    // an Origin that is not an address ("null": sandboxed frames) counts as another site too
    expect((await handleAccountApi(post("/login", {}, { origin: "null" }), deps()))!.status).toBe(403);
  });

  test("a same-origin POST, a POST without Origin and a cross-site GET are not refused", async () => {
    for (const r of [post("/login", {}, { origin: BASE }), post("/login", {})]) expect((await handleAccountApi(r, deps()))!.status).toBe(400);
    const res = (await handleAccountApi(req("/me", { headers: { origin: "https://evil.example" } }), deps()))!;
    expect(res.status).toBe(401); // reads are not cross-site-checked: the cookie is SameSite=Lax and the answer is not readable by other sites
  });
});

describe("the route's HEAD", () => {
  test("is refused with 405 (Allow: GET), never run as a GET that would use up a login link", async () => {
    const res = HEAD();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("");
  });

  test("DELETE (phase 2c: DELETE /parool) goes to the same router as POST and PATCH: Next.js answers 405 for a method the route does not export", () => {
    expect(DELETE).toBe(POST);
    expect(PATCH).toBe(POST);
  });
});

describe("cookies", () => {
  test("sessionCookies: the HttpOnly session cookie and the readable hint, 180 days", () => {
    expect(sessionCookies("x")).toEqual([
      "__Host-mslab_client=x; Path=/; Max-Age=15552000; HttpOnly; Secure; SameSite=Lax",
      "mslab_in=1; Path=/; Max-Age=15552000; Secure; SameSite=Lax",
    ]);
  });

  test("clearedCookies: both, expired now", () => {
    expect(clearedCookies()).toEqual([
      "__Host-mslab_client=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      "mslab_in=; Path=/; Max-Age=0; Secure; SameSite=Lax",
    ]);
  });

  test("accountResponse puts each cookie on its own Set-Cookie line", () => {
    const res = accountResponse({ ok: true }, 200, sessionCookies("abc"));
    expect(res.headers.getSetCookie()).toEqual(sessionCookies("abc"));
    expect(accountResponse({ ok: true }).headers.getSetCookie()).toEqual([]);
  });
});

describe("every answer is private and kept out of search engines", () => {
  const expectPrivate = (res: Response, what: string) => {
    expect(res.headers.get("cache-control"), what).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag"), what).toBe("noindex, nofollow");
  };

  test("accountResponse", async () => {
    for (const status of [200, 400, 401, 403, 404, 429, 500]) expectPrivate(accountResponse({ ok: false }, status), String(status));
    expect(accountResponse({ a: 1 }).headers.get("content-type")).toMatch(/^application\/json/);
  });

  test("the router: 403, 404, 400, 401, 303, 500 and the logout answer", async () => {
    const answers: [string, Response][] = [
      ["403", (await handleAccountApi(post("/login", {}, { origin: "https://evil.example" }), deps()))!],
      ["404", (await handleAccountApi(req("/nothing"), deps()))!],
      ["login 400", (await handleAccountApi(post("/login", { email: "x" }), deps()))!],
      ["code 400", (await handleAccountApi(post("/code", { email: "x" }), deps()))!],
      ["me 401", (await handleAccountApi(req("/me"), deps()))!],
      ["logout", (await handleAccountApi(post("/logout", {}), deps()))!],
      ["verify prefetch", (await handleAccountApi(req("/verify?t=x", { headers: { "sec-purpose": "prefetch" } }), deps()))!],
      ["500", (await handleAccountApi(post("/login", { email: "kati@example.test" }), deps()))!], // the database throws
    ];
    expect(answers.map(([, r]) => r.status)).toEqual([403, 404, 400, 400, 401, 200, 303, 500]);
    for (const [what, res] of answers) expectPrivate(res, what);
  });
});

describe("bad input is a 400, never a 500, and never reaches the database", () => {
  const bad: [string, unknown][] = [
    ["not JSON", "email=kati@example.test"],
    ["an empty body", ""],
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "7"],
    ["a string", '"kati@example.test"'],
    ["an object without fields", {}],
    ["an e-mail that is a number", { email: 7, code: "123456" }],
    ["an e-mail that is an object", { email: { a: 1 }, code: "123456" }],
    ["an e-mail that is a list", { email: ["kati@example.test"], code: "123456" }],
    ["no @", { email: "kati.example.test", code: "123456" }],
    ["an e-mail of 255 characters", { email: `${"a".repeat(242)}@example.test`, code: "123456" }],
    ["a body of 5000 characters", { email: "kati@example.test", code: "123456", padding: "x".repeat(5000) }],
  ];

  test.each(bad)("login: %s", async (_name, body) => {
    const res = (await handleAccountApi(post("/login", body), deps()))!;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "email" });
  });

  test.each([
    ...bad,
    ["a code that is a number", { email: "kati@example.test", code: 123456 }],
    ["a code that is a list", { email: "kati@example.test", code: ["123456"] }],
    ["no code", { email: "kati@example.test" }],
    ["five digits", { email: "kati@example.test", code: "12345" }],
    ["seven digits", { email: "kati@example.test", code: "1234567" }],
    ["letters", { email: "kati@example.test", code: "12345a" }],
    ["a code of 5000 characters", { email: "kati@example.test", code: "1".repeat(5000) }],
  ] as [string, unknown][])("code: %s", async (_name, body) => {
    const res = (await handleAccountApi(post("/code", body), deps()))!;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "code" });
  });
});

describe("the data endpoints without a session", () => {
  // Every one starts with requireClient: no cookie (or one that is not a token) is 401 before anything else, the body is not read and the database is not used.
  const endpoints: [string, string, unknown?][] = [
    ["GET", ""], ["GET", "/"], ["GET", "/kursus/kulmude-lami"], ["GET", "/kursus/%E0%A4%A"], ["GET", "/lemmikud"], ["GET", "/lemmikud?l=ru"],
    ["GET", "/kursus/kulmude-lami/1"], ["POST", "/kursus/kulmude-lami/1/progress", { watchedSec: 5 }], ["POST", "/kursus/kulmude-lami/1/tehtud", {}], ["GET", "/kursus/kulmude-lami/1/fail/2"],
    ["POST", "/lemmikud", { slug: "kulmude-lami", on: true }], ["POST", "/lemmikud/merge", { slugs: ["kulmude-lami"] }],
    ["PATCH", "/andmed", { name: "Kati", phone: "", locale: "et" }], ["POST", "/uudiskiri", { on: true }],
    ["POST", "/muutmine", { registrationId: 1, kind: "cancel", message: "" }], ["POST", "/maksa", { registrationId: 1 }], ["POST", "/tingimused", { slug: "veebikursus" }],
    ["POST", "/kustuta", { confirm: true }], ["POST", "/kustuta", "not json"],
    ["POST", "/parool", { password: "pikk-parool-2026" }], ["DELETE", "/parool"],
  ];

  test.each(endpoints)("%s %s: 401 none, the hint cookie cleared, nothing sent or used", async (method, path, body) => {
    const queued: unknown[] = [];
    for (const cookie of [undefined, "other=1", "__Host-mslab_client=", "__Host-mslab_client=short"]) {
      const res = (await handleAccountApi(
        req(path, { method, headers: cookie === undefined ? {} : { cookie }, body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body) }),
        deps({ later: (task) => void queued.push(task) }),
      ))!;
      expect(res.status, String(cookie)).toBe(401);
      expect(await res.json()).toEqual({ ok: false, reason: "none" });
      expect(res.headers.getSetCookie()).toEqual([clearedCookies()[1]]);
    }
    expect(queued).toEqual([]);
  });

  test("with a session cookie and a database that fails: a JSON 500 that names nothing (no cookie value, no value of the request)", async () => {
    const cookie = `__Host-mslab_client=${"A".repeat(43)}`;
    const res = (await handleAccountApi(
      req("/andmed", { method: "PATCH", headers: { cookie }, body: JSON.stringify({ name: "Kati Tamm", phone: "", locale: "et" }) }),
      deps({ db: failingDb(`select failed for ${cookie} Kati Tamm`) }),
    ))!;
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "server" });
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).toContain("[account] request failed");
    expect(logged).not.toMatch(/AAAA|Kati|select failed/);
  });
});

describe("failures", () => {
  test("a failing database is a JSON 500 that names no address and no value (the error's own message does, and is not logged)", async () => {
    const res = (await handleAccountApi(post("/login", { email: "kati@example.test" }), deps({ db: failingDb("insert failed for kati@example.test") })))!;
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "server" });
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).toContain("[account] request failed");
    expect(logged).not.toMatch(/kati|example\.test|insert failed/);
  });

  test("verify with a failing database goes to the login page with #viga=server, not a JSON page", async () => {
    const token = "A".repeat(43);
    const res = (await handleAccountApi(req(`/verify?t=${token}`), deps({ db: failingDb(`update failed for token ${token}`) })))!;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/konto/sisene#viga=server`);
    expect(res.headers.getSetCookie()).toEqual([]);
    // a link from the Russian page fails to the Russian login page (fix round 1)
    const ru = (await handleAccountApi(req(`/verify?t=${token}&l=ru`), deps({ db: failingDb("update failed") })))!;
    expect(ru.headers.get("location")).toBe(`${BASE}/ru/konto/sisene#viga=server`);
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n"); // the error's message holds the token; only the class is logged
    expect(logged).toContain("[account] verify failed");
    expect(logged).not.toContain(token);
    expect(logged).not.toContain("update failed");
  });
});

describe("me and logout without a session", () => {
  test("no cookie, a cookie that is not a token, or other cookies only: 401 none, hint cookie cleared, session cookie untouched", async () => {
    for (const cookie of [undefined, "", "__Host-mslab_client=", "__Host-mslab_client=short", "other=1; mslab_in=1", "x__Host-mslab_client=" + "A".repeat(43)]) {
      const res = (await handleAccountApi(req("/me", { headers: cookie === undefined ? {} : { cookie } }), deps()))!;
      expect(res.status, String(cookie)).toBe(401);
      expect(await res.json()).toEqual({ ok: false, reason: "none" });
      expect(res.headers.getSetCookie(), String(cookie)).toEqual([clearedCookies()[1]]);
    }
  });

  test("logout without a session still succeeds and clears both cookies", async () => {
    const res = (await handleAccountApi(post("/logout", {}), deps()))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.getSetCookie()).toEqual(clearedCookies());
  });
});

describe("verify", () => {
  test("a prefetch or prerender goes to the login page without touching the token; the Location is absolute, no Referer is sent on", async () => {
    for (const headers of [{ "sec-purpose": "prefetch" }, { "sec-purpose": "prefetch;prerender" }, { purpose: "prefetch" }, { "sec-purpose": "prerender" }] as Record<string, string>[]) {
      const res = (await handleAccountApi(req(`/verify?t=${"A".repeat(43)}`, { headers }), deps()))!;
      expect(res.status, JSON.stringify(headers)).toBe(303);
      expect(res.headers.get("location")).toBe(`${BASE}/konto/sisene`);
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.getSetCookie()).toEqual([]);
      const ru = (await handleAccountApi(req(`/verify?t=${"A".repeat(43)}&l=ru`, { headers }), deps()))!;
      expect(ru.headers.get("location")).toBe(`${BASE}/ru/konto/sisene`);
    }
  });

  test("isPrefetch", () => {
    expect(isPrefetch(new Headers({ "sec-purpose": "prefetch" }))).toBe(true);
    expect(isPrefetch(new Headers({ purpose: "Prefetch" }))).toBe(true);
    expect(isPrefetch(new Headers({ "sec-purpose": "prerender" }))).toBe(true);
    expect(isPrefetch(new Headers({ "sec-fetch-dest": "document" }))).toBe(false);
    expect(isPrefetch(new Headers())).toBe(false);
  });
});

describe("login e-mail", () => {
  const TOKEN = "tok-en_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const LINK = `${BASE}/api/konto/verify?t=${TOKEN}`;
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  test("verifyLink: the site address, the path, the token; a trailing slash is not doubled", () => {
    expect(verifyLink(BASE, TOKEN)).toBe(LINK);
    expect(verifyLink(`${BASE}/`, TOKEN)).toBe(LINK);
    expect(verifyLink(BASE, "a b&c")).toBe(`${BASE}/api/konto/verify?t=a%20b%26c`);
  });

  test("verifyLink: the Russian login page adds &l=ru, the Estonian one nothing (fix round 1)", () => {
    expect(verifyLink(BASE, TOKEN, "ru")).toBe(`${LINK}&l=ru`);
    expect(verifyLink(BASE, TOKEN, "et")).toBe(LINK);
  });

  test("the link carries the login page's language, which can differ from the e-mail's (an account's own language)", () => {
    const fromRussianPage = loginMail(BASE, "kati@example.test", TOKEN, "042917", "et", "ru");
    expect(fromRussianPage.subject).toBe("042917 — MS LAB sisselogimiskood"); // the account is Estonian
    expect(fromRussianPage.text.split("\n")).toContain(`${LINK}&l=ru`);
    expect(fromRussianPage.html).toContain(`href="${LINK}&amp;l=ru"`);
    expect(loginMail(BASE, "kati@example.test", TOKEN, "042917", "ru").text.split("\n")).toContain(LINK); // the page was Estonian
  });

  test("Estonian text: the code in the subject and alone on a line, the link, 30 minutes, the ignore line", () => {
    const mail = loginMail(BASE, "kati@example.test", TOKEN, "042917", "et");
    expect(mail.to).toBe("kati@example.test");
    expect(mail.subject).toBe("042917 — MS LAB sisselogimiskood");
    expect(mail.text).toBe(
      [
        "Tere!", "", "Sinu sisselogimiskood:", "", "042917", "",
        "Sisesta see kood lehel, kus alustasid sisselogimist. Või ava see link, et logida sisse:", LINK, "",
        "Kood ja link kehtivad 30 minutit.", "Kui sa ei palunud sisselogimist, võid selle kirja kustutada.", "", "MS LAB Koolituskeskus",
      ].join("\n"),
    );
  });

  test("Russian text: the same parts in Russian", () => {
    const mail = loginMail(BASE, "kati@example.test", TOKEN, "042917", "ru");
    expect(mail.subject).toBe("042917 — код входа MS LAB");
    expect(mail.text.split("\n")).toContain("042917");
    expect(mail.text).toContain(LINK);
    expect(mail.text).toMatch(/30 минут/);
    expect(mail.text).toMatch(/[А-Яа-я]/);
    expect(mail.text).not.toMatch(/\{\w+\}/);
  });

  test("the subject carries the 6 digits for every code, leading zeros kept", () => {
    for (const code of ["000000", "000123", "999999"]) {
      expect(loginMail(BASE, "kati@example.test", TOKEN, code, "et").subject).toMatch(new RegExp(`^${code} `));
      expect(loginMail(BASE, "kati@example.test", TOKEN, code, "ru").subject).toMatch(new RegExp(`^${code} `));
    }
  });

  test.each([
    ["et", "Logi sisse", "Kood ja link kehtivad 30 minutit.", "Kui sa ei palunud sisselogimist, võid selle kirja kustutada.", "Tere!"],
    ["ru", "Войти", "Код и ссылка действуют 30 минут.", "Если вы не запрашивали вход, просто удалите это письмо.", "Здравствуйте!"],
  ] as const)("%s HTML: the code large on its own line, one button to the link, the link written out, the 30 minutes and the delete line", (locale, button, valid, ignore, greeting) => {
    const html = loginMail(BASE, "kati@example.test", TOKEN, "042917", locale).html!;
    expect(html).toBeDefined();
    expect(html.startsWith(`<!doctype html><html lang="${locale}">`)).toBe(true);
    expect(html).toContain("<title>042917 — ");
    expect(html).toContain(greeting);
    expect(html).toContain(valid);
    expect(html).toContain(ignore);
    // the code: its own element, large, letter-spaced
    expect(html).toMatch(/<div style="[^"]*font:600 32px[^"]*letter-spacing:8px[^"]*">042917<\/div>/);
    // one button: an anchor to the verify URL, labelled, 48 px tall (at least 44), ink pill with white text
    const buttons = [...html.matchAll(/<a href="([^"]*)" style="([^"]*)">([^<]*)<\/a>/g)].filter((m) => m[3] === button);
    expect(buttons).toHaveLength(1);
    expect(buttons[0][1]).toBe(LINK);
    expect(buttons[0][2]).toContain("line-height:48px");
    expect(buttons[0][2]).toContain("color:#ffffff");
    expect(html).toContain('bgcolor="#222222"');
    // the raw URL below the button, small, for clients that block buttons
    expect(html).toMatch(new RegExp(`font:400 12px/1\\.5[^"]*"><a href="${escapeRe(LINK)}"[^>]*>${escapeRe(LINK)}</a>`));
    expect(html.indexOf(`>${LINK}</a>`)).toBeGreaterThan(html.indexOf(`>${button}</a>`));
    expect(html).not.toMatch(/\{\w+\}/);
  });

  test("HTML: tables and inline styles only: no images, scripts, external CSS, web fonts or URLs but the link; the site's font stack", () => {
    for (const locale of ["et", "ru"] as const) {
      const html = loginMail(BASE, "kati@example.test", TOKEN, "042917", locale).html!;
      expect(html).not.toMatch(/<(img|script|link|style|iframe|video|svg)\b/i);
      expect(html).not.toMatch(/@import|@font-face|url\(|src=/i);
      expect(html.match(/https?:\/\/[^"'<\s]+/g)!.every((u) => u === LINK)).toBe(true);
      expect(html).toContain("font:600 16px/48px Jost, Manrope, Arial, sans-serif");
    }
  });

  test("HTML: every colour is one of the site's tokens (src/styles/tokens.css)", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const tokens = new Set(css.match(/#[0-9a-f]{6}\b/gi)!.map((c) => c.toLowerCase()));
    const used = new Set(loginMail(BASE, "kati@example.test", TOKEN, "042917", "et").html!.match(/#[0-9a-f]{3,8}\b/gi)!.map((c) => c.toLowerCase()));
    expect(used.size).toBeGreaterThan(3);
    for (const colour of used) expect(tokens.has(colour), colour).toBe(true);
  });

  test("HTML: every value is escaped (the address of the link, the token, the code)", () => {
    const html = loginMail(`https://x.example/a?b=1&c="2"<i>`, "kati@example.test", `t&<>"'k`, "<b>&", "et").html!;
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("&lt;b&gt;&amp;"); // the code
    expect(html).toContain('href="https://x.example/a?b=1&amp;c=&quot;2&quot;&lt;i&gt;/api/konto/verify?t=t%26%3C%3E%22&#39;k"'); // encodeURIComponent leaves the apostrophe, the escape takes it
    // an attribute value cannot end early: every href is one quoted string without a quote or a tag in it
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(2);
    for (const href of hrefs) expect(href).not.toMatch(/["<>]/);
  });
});

describe("deletion e-mail", () => {
  test("Estonian: the account is deleted, the registrations stay with Maria; plain text and a plain HTML body", () => {
    const mail = deletionMail("kati@example.test", "et");
    expect(mail.to).toBe("kati@example.test");
    expect(mail.subject).toBe("MS LAB konto on kustutatud");
    expect(mail.text).toBe(["Tere!", "", "Sinu MS LAB konto on kustutatud.", "Sinu registreeringud jäävad Mariale alles.", "", "MS LAB Koolituskeskus"].join("\n"));
    const html = mail.html!;
    expect(html.startsWith('<!doctype html><html lang="et">')).toBe(true);
    expect(html).toContain("<title>MS LAB konto on kustutatud</title>");
    for (const line of ["Tere!", "Sinu MS LAB konto on kustutatud.", "Sinu registreeringud jäävad Mariale alles.", "MS LAB Koolituskeskus"]) expect(html).toContain(line);
  });

  test("Russian: the same lines in Russian", () => {
    const mail = deletionMail("kati@example.test", "ru");
    expect(mail.subject).toBe("Личный кабинет MS LAB удалён");
    expect(mail.text).toBe(["Здравствуйте!", "", "Ваш личный кабинет MS LAB удалён.", "Ваши регистрации остаются у\u00a0Марии.", "", "MS LAB Учебный центр"].join("\n"));
    expect(mail.html).toContain('lang="ru"');
    expect(mail.html).toContain("Ваши регистрации остаются у\u00a0Марии.");
  });

  test("the HTML has no button and no link, no resources, and only the site's colours", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const tokens = new Set(css.match(/#[0-9a-f]{6}\b/gi)!.map((c) => c.toLowerCase()));
    for (const locale of ["et", "ru"] as const) {
      const html = deletionMail("kati@example.test", locale).html!;
      expect(html).not.toMatch(/<(a|img|script|link|style|iframe|svg|button)\b/i);
      expect(html).not.toMatch(/https?:|@import|url\(|src=|href=/i);
      for (const colour of html.match(/#[0-9a-f]{3,8}\b/gi)!) expect(tokens.has(colour.toLowerCase()), colour).toBe(true);
    }
  });
});

test("esc is exported for the other mails: nothing it returns can open a tag or end an attribute", () => {
  expect(esc(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

describe("the password login without a database (phase 2c)", () => {
  test("a body that cannot be a login: the same 400 { error: 'password' } as a wrong password, private, before the database", async () => {
    for (const body of [{}, { email: "kati@example.test" }, { email: "pole-aadress", password: "pikk-parool-2026" }, { password: "pikk-parool-2026" }, "not json"]) {
      const res = (await handleAccountApi(post("/parool-login", body), deps()))!;
      expect([res.status, await res.json()], JSON.stringify(body)).toEqual([400, { ok: false, error: "password" }]);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  const IP_HEADERS = { "x-forwarded-for": "203.0.113.9" };
  const withKv = (kv: ReturnType<typeof fakeKv>) => deps({ env: { ...deps().env, KV: kv } });

  test("the IP at its limit is refused first, the right password too: 429 locked, private, before the database, and nothing is counted", async () => {
    const kv = fakeKv({ "rl:pw-ip:203.0.113.9": "20" });
    const res = (await handleAccountApi(post("/parool-login", { email: "kati@example.test", password: "pikk-parool-2026" }, IP_HEADERS), withKv(kv)))!;
    expect([res.status, await res.json()]).toEqual([429, { ok: false, error: "locked" }]);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect([...kv.store]).toEqual([["rl:pw-ip:203.0.113.9", "20"]]);
  });

  test("a body that cannot be a login takes the IP's slot like any failure (it is the count), and a store that fails lets it through", async () => {
    const kv = fakeKv();
    const res = (await handleAccountApi(post("/parool-login", { email: "kati@example.test" }, IP_HEADERS), withKv(kv)))!;
    expect(res.status).toBe(400);
    expect([...kv.store]).toEqual([["rl:pw-ip:203.0.113.9", "1"]]);
    const down = async (): Promise<never> => { throw new Error("kv down"); };
    const broken = deps({ env: { ...deps().env, KV: { get: down, put: down, reserve: down, release: down } } });
    expect((await handleAccountApi(post("/parool-login", { email: "kati@example.test" }, IP_HEADERS), broken))!.status).toBe(400);
  });
});

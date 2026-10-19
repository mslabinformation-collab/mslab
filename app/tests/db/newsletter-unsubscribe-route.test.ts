import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { subscribers } from "@/db/schema";
import { PgKv } from "@/server/kv";
import { sha256 } from "@/server/token";
import { makeTestDb } from "./helpers";

// The unsubscribe link in the welcome mail (/api/newsletter/loobu?t=…) takes two steps, so a mail gateway that opens every link of a mail
// (Mimecast, Proofpoint, some Defender setups) unsubscribes no one: GET only shows a page with one button; the button POSTs the token, and
// only that POST deletes the subscriber's row and sends the visitor home with a notice. An unknown or malformed token on POST gets the same
// answer as a real one (unsubscribing is idempotent and reveals nothing). The route runs with the database (PGlite) faked in.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import * as route from "@/app/api/newsletter/loobu/route";

const ORIGIN = "https://mslab.example";
const TOKEN = "h".repeat(43);
const TOKEN_RU = "r".repeat(43);
let db: Db;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const now = new Date("2026-10-09T10:00:00Z");
  await db.insert(subscribers).values([
    { email: "uus@example.com", locale: "et", token: TOKEN, consentAt: now, confirmedAt: now },
    { email: "uus-ru@example.com", locale: "ru", token: TOKEN_RU, consentAt: now, confirmedAt: now },
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const emails = async () => (await db.select({ email: subscribers.email }).from(subscribers)).map((r) => r.email).sort();
const BOTH = ["uus-ru@example.com", "uus@example.com"];
const link = (token: string) => `${ORIGIN}/api/newsletter/loobu?t=${token}`;
const get = (token: string, headers: Record<string, string> = {}) => route.GET(new Request(link(token), { headers }));
/** The button's POST: the form's field `t` as a browser sends it. */
const post = (token: string | null, headers: Record<string, string> = {}) =>
  route.POST(
    new Request(`${ORIGIN}/api/newsletter/loobu`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: token === null ? "" : new URLSearchParams({ t: token }).toString(),
    }),
  );
/** What Next does for HEAD: the route's HEAD, else its GET. */
const head = (request: Request) => ((route as { HEAD?: (request: Request) => Response | Promise<Response> }).HEAD ?? route.GET)(request);
const where = (res: Response) => {
  const location = res.headers.get("location");
  return location ? new URL(location, ORIGIN).pathname + new URL(location, ORIGIN).search : null;
};

test("GET shows the confirm page and deletes nothing: 200 HTML, never cached or indexed, one form that POSTs the token", async () => {
  const res = await get(TOKEN);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  expect(res.headers.get("cache-control")).toBe("no-store");
  // X-Robots-Tag and Referrer-Policy are next.config.ts's (headers() replaces a route's own): the route sets neither. It must never send
  // "no-referrer": a form posted from such a page carries "Origin: null", which the same-origin check refuses.
  expect(res.headers.get("x-robots-tag")).toBeNull();
  expect(res.headers.get("referrer-policy")).toBeNull();
  const html = await res.text();
  expect(html).toContain('<meta name="robots" content="noindex">');
  expect(html).toContain('<html lang="et">');
  expect(html).toContain("Uudiskirjast loobumine");
  expect(html).toContain("Vajuta nuppu, et MS LABi uudiskirjast loobuda.");
  expect(html).toMatch(/<form method="post" action="\/api\/newsletter\/loobu">/);
  expect(html).toContain(`<input type="hidden" name="t" value="${TOKEN}">`);
  expect(html).toMatch(/<button type="submit"[^>]*>Loobu uudiskirjast<\/button>/);
  expect(html).not.toContain("<script");
  expect(await emails()).toEqual(BOTH);
});

test("a gateway that opens the link (any number of GETs, prefetch headers or not) unsubscribes no one", async () => {
  for (const headers of [{} as Record<string, string>, { "sec-purpose": "prefetch" }, { purpose: "prefetch" }, { "sec-purpose": "prefetch;prerender" }, { "user-agent": "Mimecast" }]) {
    const res = await get(TOKEN, headers);
    expect(res.status, JSON.stringify(headers)).toBe(200);
    expect(await emails(), JSON.stringify(headers)).toEqual(BOTH);
  }
});

test("the page is in the row's language: a Russian row gets the Russian page; an unknown but well-formed token gets the Estonian page with its form", async () => {
  const ru = await (await get(TOKEN_RU)).text();
  expect(ru).toContain('<html lang="ru">');
  expect(ru).toContain("Отказ от рассылки");
  expect(ru).toContain("Нажмите кнопку, чтобы отписаться от рассылки MS LAB.");
  expect(ru).toMatch(/<button type="submit"[^>]*>Отписаться от рассылки<\/button>/);
  expect(ru).toContain(`name="t" value="${TOKEN_RU}"`);
  const unknown = await (await get("x".repeat(43))).text();
  expect(unknown).toContain('<html lang="et">');
  expect(unknown).toContain(`name="t" value="${"x".repeat(43)}"`); // the page never tells whether the token belongs to a row
  expect(await emails()).toEqual(BOTH);
});

test("a malformed or missing token: the page without a form, the lead line only, and the token is never written into it", async () => {
  for (const token of ['"><script>alert(1)</script>', "short", "' or 1=1 --", ""]) {
    const res = await get(token);
    const html = await res.text();
    expect(res.status, token).toBe(200);
    expect(html, token).not.toContain("<form");
    expect(html, token).not.toContain("<button");
    expect(html, token).toContain("Vajuta nuppu, et MS LABi uudiskirjast loobuda.");
    expect(html, token).not.toContain("alert(1)");
  }
  const none = await route.GET(new Request(`${ORIGIN}/api/newsletter/loobu`));
  expect(await none.text()).not.toContain("<form");
});

test("the database failing on GET still shows the page (in Estonian, with the form): nothing is deleted there anyway", async () => {
  const broken = vi.spyOn(db, "select").mockImplementation(() => {
    throw new Error(`no database connection for t=${TOKEN}`);
  });
  const res = await get(TOKEN_RU);
  broken.mockRestore();
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('<html lang="et">');
  expect(html).toContain("<form");
  expect(await emails()).toEqual(BOTH);
});

test("POST with a token of a row deletes that row (and only it) and goes home in the row's language with the 'loobutud' notice, never cached", async () => {
  const et = await post(TOKEN);
  expect([et.status, where(et), et.headers.get("cache-control")]).toEqual([303, "/?uudiskiri=loobutud", "no-store"]);
  expect(await emails()).toEqual(["uus-ru@example.com"]);
  const ru = await post(TOKEN_RU);
  expect([ru.status, where(ru), ru.headers.get("cache-control")]).toEqual([303, "/ru?uudiskiri=loobutud", "no-store"]);
  expect(await emails()).toEqual([]);
});

test("POST of the same page's own origin, or with no Origin at all, is accepted", async () => {
  expect(where(await post(TOKEN, { origin: ORIGIN }))).toBe("/?uudiskiri=loobutud");
  expect(where(await post(TOKEN_RU))).toBe("/ru?uudiskiri=loobutud");
  expect(await emails()).toEqual([]);
});

test("a cross-site POST (another site's Origin, or 'null') is 403 and deletes nothing", async () => {
  for (const origin of ["https://evil.example", "http://mslab.example", "null", "not a url"]) {
    const res = await post(TOKEN, { origin });
    expect([res.status, res.headers.get("cache-control"), res.headers.get("location")], origin).toEqual([403, "no-store", null]);
    expect(await emails(), origin).toEqual(BOTH);
  }
});

test("a POST that carries Origin: null (a document with a strict referrer policy) is the same site when the browser says Sec-Fetch-Site: same-origin; any other claim stays cross-site", async () => {
  const same = await post(TOKEN, { origin: "null", "sec-fetch-site": "same-origin" });
  expect([same.status, where(same)]).toEqual([303, "/?uudiskiri=loobutud"]);
  expect(await emails()).toEqual(["uus-ru@example.com"]);
  const refused: Record<string, string>[] = [
    { origin: "null" },
    { origin: "null", "sec-fetch-site": "cross-site" },
    { origin: "null", "sec-fetch-site": "same-site" },
    { origin: "null", "sec-fetch-site": "none" },
    { origin: "https://evil.example", "sec-fetch-site": "same-origin" }, // only Origin: null is excused, a named foreign site never is
    { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  ];
  for (const headers of refused) {
    const res = await post(TOKEN_RU, headers);
    expect(res.status, JSON.stringify(headers)).toBe(403);
    expect(await emails(), JSON.stringify(headers)).toEqual(["uus-ru@example.com"]);
  }
});

test("the button's POST forgets the address's once-a-year welcome mark, so a later sign-up gets a fresh welcome; a refused POST leaves it", async () => {
  const kv = new PgKv(db);
  const mark = `rl:welcome:${await sha256("uus@example.com")}`;
  const other = `rl:welcome:${await sha256("uus-ru@example.com")}`;
  await kv.put(mark, "1", { expirationTtl: 365 * 24 * 60 * 60 });
  await kv.put(other, "1", { expirationTtl: 365 * 24 * 60 * 60 });
  expect((await post(TOKEN, { origin: "https://evil.example" })).status).toBe(403);
  expect(await kv.get(mark)).toBe("1");
  expect((await get(TOKEN)).status).toBe(200); // opening the link forgets nothing
  expect(await kv.get(mark)).toBe("1");
  expect(where(await post(TOKEN))).toBe("/?uudiskiri=loobutud");
  expect(await kv.get(mark)).toBeNull();
  expect(await kv.get(other)).toBe("1"); // another address's mark is not touched
  await post("x".repeat(43)); // an unknown token forgets nothing either
  expect(await kv.get(other)).toBe("1");
});

test("POST with an unknown token, a used one, a malformed one or none: the same 303 to the Estonian home page, nothing else deleted", async () => {
  await post(TOKEN);
  const again = await post(TOKEN);
  expect([again.status, where(again), again.headers.get("cache-control")]).toEqual([303, "/?uudiskiri=loobutud", "no-store"]);
  for (const token of ["x".repeat(43), "not-a-token", "", "' or 1=1 --", "h".repeat(42), null]) {
    const res = await post(token);
    expect([res.status, where(res), res.headers.get("cache-control")], String(token)).toEqual([303, "/?uudiskiri=loobutud", "no-store"]);
  }
  const noForm = await route.POST(new Request(`${ORIGIN}/api/newsletter/loobu?t=${TOKEN_RU}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: TOKEN_RU }) }));
  expect([noForm.status, where(noForm)]).toEqual([303, "/?uudiskiri=loobutud"]); // only the form field counts, not the query or a JSON body
  expect(await emails()).toEqual(["uus-ru@example.com"]);
});

test("HEAD answers 204, not cached, and changes nothing", async () => {
  const res = await head(new Request(link(TOKEN), { method: "HEAD" }));
  expect(res.status).toBe(204);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.text()).toBe("");
  expect(await emails()).toEqual(BOTH);
});

test("the database failing on POST: the visitor is told so (?uudiskiri=viga), never that she is unsubscribed; the row stays; the log holds neither the token nor the address", async () => {
  const gone = vi.spyOn(db, "delete").mockImplementation(() => {
    throw new Error(`no database connection for t=${TOKEN} uus@example.com`);
  });
  const res = await post(TOKEN);
  expect([res.status, where(res), res.headers.get("cache-control")]).toEqual([303, "/?uudiskiri=viga", "no-store"]);
  gone.mockRestore();
  expect(await emails()).toEqual(BOTH);
  const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls);
  expect(logged).not.toContain(TOKEN);
  expect(logged).not.toContain("uus@example.com");
});

// „Saada proov“'s link (newsletter campaigns Task 4, ruling R4): a test contact that is no subscriber gets ?proov=1 as its unsubscribe link. The
// page says it is a test, has no form, and changes nothing, whatever else the address carries.
test("?proov=1: the test page in Estonian, „Proovikiri — päris kirjas viib see link loobumisele.“, no form, nothing deleted, never cached", async () => {
  for (const url of [`${ORIGIN}/api/newsletter/loobu?proov=1`, `${link(TOKEN)}&proov=1`]) {
    const res = await route.GET(new Request(url));
    expect(res.status, url).toBe(200);
    expect(res.headers.get("cache-control"), url).toBe("no-store");
    expect(res.headers.get("content-type"), url).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html, url).toContain('<html lang="et">');
    expect(html, url).toContain("Proovikiri — päris kirjas viib see link loobumisele.");
    expect(html, url).not.toContain("<form");
    expect(html, url).not.toContain("<button");
    expect(html, url).not.toContain(TOKEN);
  }
  expect(await emails()).toEqual(BOTH);
});

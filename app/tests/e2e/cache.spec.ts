import type { APIRequestContext } from "@playwright/test";
import { SEED_ECOURSE_SLUG } from "./account";
import { testEmail } from "./fixtures";
import { E2E_MONTONIO } from "./montonio-values";
import { revalidateLocalPages } from "./prod-build";
import { PROD_BUILD } from "./target";
import { submitsForms, test, expect } from "./test";

// Task 17: the public pages are rendered once and served from Next.js's cache (incremental static regeneration; on
// Vercel its CDN serves them too). Next.js says where a page came from: x-nextjs-cache HIT (cached), STALE (cached but
// older than its `revalidate`: served, and rendered again in the background) or MISS (rendered for this request).
// These run against the local production build only (E2E_PROD_BUILD=1: `next build && next start`): `next dev` renders
// every request, and a Vercel deployment answers with its own headers (checked there by hand). The admin freshness
// contract (a save shows on the next request) is checked by admin-edit.spec.ts and admin-site.spec.ts, which run
// against the local production build too.

test.skip(!PROD_BUILD, "the page cache exists in a production build only (E2E_PROD_BUILD=1)");
test.skip(({ isMobile }) => isMobile, "the same answers for every browser: desktop project only");

const COURSE = "/koolitused/kulmumeistri-baaskoolitus";

/** Next.js's own page cache: kept for a CDN (s-maxage, then stale-while-revalidate), never by the browser itself. */
const CDN_ONLY = /^s-maxage=(\d+), stale-while-revalidate=\d+$/;

type Get = { headers?: Record<string, string>; maxRedirects?: number };

/**
 * Asks until the answer comes from the cache. Another test's fixture may have marked every page stale meanwhile
 * (tests/e2e/prod-build.ts): then the first request renders the page and stores it, and the next one is answered from
 * the cache. (A test's own RSC request is not a real router's: Next.js redirects it to its cache-busting address, which
 * the request follows with the same headers.)
 */
async function fromCache(request: APIRequestContext, path: string, options: Get = {}) {
  let res = await request.get(path, { ...options, failOnStatusCode: false });
  for (let i = 0; i < 3 && res.headers()["x-nextjs-cache"] !== "HIT"; i++) res = await request.get(path, { ...options, failOnStatusCode: false });
  return res;
}

/**
 * Asks until two answers in a row come from the cache and say the same, and returns that text. Another test's fixture (or a
 * browser elsewhere) may mark every page stale or render one meanwhile (tests/e2e/prod-build.ts): a request in that gap renders
 * the page itself, and Next.js keeps the address that rendered it in the page it stores.
 */
async function settledText(request: APIRequestContext, path: string, options: Get = {}): Promise<string> {
  let before: string | null = null;
  for (let i = 0; i < 10; i++) {
    const res = await request.get(path, { ...options, failOnStatusCode: false });
    const text = res.headers()["x-nextjs-cache"] === "HIT" ? await res.text() : null;
    if (text !== null && text === before) return text;
    before = text;
  }
  throw new Error(`${path}: no two answers in a row from the cache that agree`);
}

test("a page, its navigation payload and its prefetch tree come from the cache, which only a CDN may keep", async ({ request }) => {
  for (const path of ["/", COURSE, "/ru/koolituskalender"]) {
    const html = await fromCache(request, path);
    expect(html.status(), path).toBe(200);
    expect(html.headers()["x-nextjs-cache"], path).toBe("HIT");
    expect(html.headers()["content-type"], path).toMatch(/^text\/html/);
    expect(html.headers()["cache-control"], `${path}: for a CDN only (Vercel answers browsers with max-age=0)`).toMatch(CDN_ONLY);
    expect(html.headers()["x-robots-tag"], path).toBe("noindex, nofollow");

    const rsc = await fromCache(request, `${path}?_rsc=x`, { headers: { RSC: "1" } });
    expect(rsc.headers()["x-nextjs-cache"], `${path} RSC`).toBe("HIT");
    expect(rsc.headers()["content-type"]).toBe("text/x-component");
    // the client router learns about the middleware's /et rewrite
    expect(rsc.headers()["x-nextjs-rewritten-path"], path).toBe(path.startsWith("/ru") ? undefined : path === "/" ? "/et" : `/et${path}`);

    const tree = await fromCache(request, `${path}?_rsc=y`, { headers: { RSC: "1", "Next-Router-Prefetch": "1", "Next-Router-Segment-Prefetch": "/_tree" } });
    expect(tree.headers()["x-nextjs-cache"], `${path} tree`).toBe("HIT");
    expect(tree.headers()["x-nextjs-prerender"]).toBe("1");

    // the browser's copy of the document is confirmed with a 304 (a page that was just rendered again, because another
    // test's fixture marked it stale, is sent in full: then its own ETag is tried)
    let etag = html.headers()["etag"];
    expect(etag, `${path} ETag`).toBeTruthy();
    let again = await request.get(path, { headers: { "If-None-Match": etag } });
    for (let i = 0; i < 3 && again.status() === 200; i++) {
      etag = (await fromCache(request, path)).headers()["etag"];
      again = await request.get(path, { headers: { "If-None-Match": etag } });
    }
    expect(again.status(), `${path} If-None-Match`).toBe(304);
  }
});

test("the pages that list course dates are rendered again after 5 minutes (a session that has begun drops off), the others after a day", async ({ request }) => {
  const maxAge = async (path: string) => Number(CDN_ONLY.exec((await fromCache(request, path)).headers()["cache-control"] ?? "")?.[1]);
  for (const path of ["/", "/ru", "/koolitused", COURSE, "/ru/koolitused/kulmumeistri-baaskoolitus", "/koolituskalender", "/ru/koolituskalender"]) expect(await maxAge(path), path).toBe(300);
  for (const path of ["/praktika", "/koolitaja", "/uudised", "/kontakt", "/privaatsus", "/ru/tingimused"]) expect(await maxAge(path), path).toBe(86400);
});

test("per-visitor addresses share the one cached page, and nothing of the query is in it", async ({ request }) => {
  // The clean address is settled first (two answers in a row from the cache that agree), then the one with a query must be answered
  // from the same entry. If a fixture of another test marks the pages stale in between, the request with the query renders the page
  // itself, and Next.js stores that request's address in it: not a failure of this test, so it starts again (three times at most).
  let plain = "";
  let notice: Awaited<ReturnType<APIRequestContext["get"]>>;
  let attempt = 0;
  do {
    plain = await settledText(request, "/");
    notice = await request.get("/?uudiskiri=kinnitatud", { failOnStatusCode: false });
  } while (notice.headers()["x-nextjs-cache"] !== "HIT" && ++attempt < 3);
  expect(notice.headers()["x-nextjs-cache"]).toBe("HIT");
  const html = await notice.text();
  expect(html, "the same cached page").toBe(plain);
  // the newsletter notice is put in by the browser (FlashNotice), never by the server: its region is empty in the HTML
  expect(html).toContain('data-flash-notice=""');
  expect(html).not.toMatch(/data-flash-notice="(ok|warn)"/);

  let page = "";
  let linked = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    page = await settledText(request, COURSE);
    const res = await request.get(`${COURSE}?sessioon=1`, { failOnStatusCode: false });
    linked = await res.text();
    if (res.headers()["x-nextjs-cache"] === "HIT") break;
  }
  expect(linked, "the same cached page").toBe(page);
  expect(linked, "no date is picked in the server's HTML").not.toMatch(/data-session="\d+"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-session="\d+"/);

  // the cart of one course is a page of its own (the middleware maps ?kursus to it)
  const cart = await (await fromCache(request, "/ostukorv?kursus=kulmumeistri-e-koolitus")).text();
  expect(cart).toContain("Kulmumeistri e-koolitus");
  expect(await (await fromCache(request, "/ostukorv")).text()).not.toBe(cart);
});

// The client account's pages are static shells (phase 2a): one cached copy for every visitor, whoever is signed in: Minu koolitused,
// the login page, Lemmikud, Minu andmed (Task 8), an e-course's shell (/konto/kursus/<slug>, rendered on its first visit, then
// cached per slug) and (phase 3a) a lesson's shell (/konto/kursus/<slug>/<lesson id>, rendered on its first visit, then cached per
// address: the shell knows nothing of the lesson, which comes from /api/konto/kursus/<slug>/<lesson> after the page has loaded).
const ECOURSE_SHELL = `/konto/kursus/${SEED_ECOURSE_SLUG}`;
const LESSON_SHELL = `${ECOURSE_SHELL}/1`;
const ACCOUNT_SHELLS = [
  "/konto", "/ru/konto", "/konto/sisene", "/ru/konto/sisene", "/konto/lemmikud", "/ru/konto/lemmikud", "/konto/andmed", "/ru/konto/andmed",
  ECOURSE_SHELL, `/ru${ECOURSE_SHELL}`, LESSON_SHELL, `/ru${LESSON_SHELL}`,
];

test("the account's pages come from the cache with no Set-Cookie, for a signed-in browser too; /api/konto/me never does (phase 2a)", async ({ request }) => {
  const signedIn = { cookie: `__Host-mslab_client=${"e2e".repeat(15)}; mslab_in=1` };
  for (const path of ACCOUNT_SHELLS) {
    const plain = await fromCache(request, path);
    for (const [who, res] of [["no cookie", plain], ["signed-in cookies", await fromCache(request, path, { headers: signedIn })]] as const) {
      expect(res.status(), `${path} (${who})`).toBe(200);
      expect(res.headers()["x-nextjs-cache"], `${path} (${who})`).toBe("HIT");
      expect(res.headers()["cache-control"], `${path} (${who}): for a CDN only`).toMatch(CDN_ONLY);
      expect(res.headers()["set-cookie"], `${path} (${who})`).toBeUndefined();
    }
    const rsc = await fromCache(request, `${path}?_rsc=k`, { headers: { RSC: "1", ...signedIn } });
    expect(rsc.headers()["x-nextjs-cache"], `${path} RSC`).toBe("HIT");
    expect(rsc.headers()["set-cookie"], `${path} RSC`).toBeUndefined();
  }
  // the dashboard's "Ava koolitus" and the course's "Jätka" and lesson titles are <Link>s: their prefetch (the page's tree and its
  // payload) is answered from the same cache, with no cookie set, and renders nothing personal (the course and the lesson come from
  // /api/konto/kursus/… after the page has loaded)
  for (const shell of [ECOURSE_SHELL, LESSON_SHELL])
    for (const [label, headers] of [["tree", { "Next-Router-Prefetch": "1", "Next-Router-Segment-Prefetch": "/_tree" }], ["payload", { "Next-Router-Prefetch": "1" }]] as const) {
      const prefetch = await fromCache(request, `${shell}?_rsc=p${label}`, { headers: { RSC: "1", ...headers, ...signedIn } });
      expect(prefetch.status(), `${shell} prefetch ${label}`).toBe(200);
      expect(prefetch.headers()["x-nextjs-cache"], `${shell} prefetch ${label}`).toBe("HIT");
      expect(prefetch.headers()["set-cookie"], `${shell} prefetch ${label}`).toBeUndefined();
    }
  const me = await request.get("/api/konto/me", { failOnStatusCode: false });
  expect(me.status()).toBe(401);
  expect(await me.json()).toEqual({ ok: false, reason: "none" });
  expect(me.headers()["cache-control"]).toBe("private, no-store");
  expect(me.headers()["x-nextjs-cache"]).toBeUndefined();
});

// Next.js stores the address of the request that renders a page (path and query) in the page it caches, and the next visitor is sent
// that copy; no rewrite changes it. The account's pages take parameters (viga, korda, an e-mail address): they travel in the fragment,
// which no server sees, and the middleware answers a request that has a query, whatever its method (a mail scanner's HEAD, a stray
// POST), with a 303 to the same path with the known parameters in the fragment. Checked by marking every page stale, as the fixtures
// do, then asking with a query by GET, HEAD and POST: each must answer 303 and not be kept; then the address without a query is asked
// until two answers in a row come from the cache, as a page and as the navigation payload (RSC: 1), and neither may name the query.
const PROBE_QUERY = "viga=link&korda=1&email=probe%40example.test";
// The probe's own values, not the bare words: "viga" and "korda" are ordinary Estonian ("mitu korda", the password texts of phase 2c).
const LEAKS = /probe|viga=link|korda=1|"viga":"link"|"korda":"1"/;
/** The first mention of the probe's query with the text around it ("" when there is none), for the failure message. */
const leak = (text: string): string => {
  const at = text.search(LEAKS);
  return at < 0 ? "" : text.slice(Math.max(0, at - 80), at + 80);
};

test("an account shell asked for with a query is answered with a 303 to the fragment, by every method, and the cached shell never holds the query", async ({ request }) => {
  test.setTimeout(360_000); // twelve shells
  for (const path of ACCOUNT_SHELLS) {
    revalidateLocalPages(); // the first request that reaches a shell now renders it: it must not be one with a query
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"]) {
      const probe = await request.fetch(`${path}?${PROBE_QUERY}`, {
        method,
        ...(method === "POST" || method === "PUT" ? { data: "email=probe%40example.test", headers: { "content-type": "application/x-www-form-urlencoded" } } : {}),
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      const what = `${method} ${path}?…`;
      expect(probe.status(), what).toBe(303);
      expect(probe.headers()["location"], what).toBe(`${path}#${PROBE_QUERY}`);
      expect(probe.headers()["cache-control"], what).toBe("no-store");
      expect(probe.headers()["x-nextjs-cache"], what).toBeUndefined();
      expect(probe.headers()["set-cookie"], what).toBeUndefined();
    }
    // an unknown parameter is dropped, and so is everything when none of ours is there
    const other = await request.get(`${path}?utm_source=probe&fbclid=probe`, { maxRedirects: 0, failOnStatusCode: false });
    expect(other.status(), path).toBe(303);
    expect(other.headers()["location"], path).toBe(path);

    const page = await settledText(request, path);
    const payload = await settledText(request, path, { headers: { RSC: "1" } });
    expect(leak(page), `${path}: the cached page after the requests with a query`).toBe("");
    expect(leak(payload), `${path}: the cached payload after the requests with a query`).toBe("");
    // and the clean address is answered from the cache, by a request without a query (asked again, as everywhere here, when another
    // test's fixture has just marked every page stale: the first request then renders it, cleanly, and the next is a HIT)
    expect((await fromCache(request, path)).headers()["x-nextjs-cache"], path).toBe("HIT");
  }
});

test("admin pages and the API never come from the page cache, and no CDN may keep them", async ({ request }) => {
  for (const path of ["/admin/login", "/api/feedback", "/api/cron/sweep"]) {
    for (let i = 0; i < 2; i++) {
      const res = await request.get(path, { maxRedirects: 0, failOnStatusCode: false });
      expect(res.headers()["x-nextjs-cache"], `${path}: not a cached page`).toBeUndefined();
      expect(res.headers()["cache-control"], path).toMatch(/no-store/);
    }
  }
});

test("unknown addresses share their locale's one cached 404 page: status 404, noindex, the site's own 404 (round 2 item 21)", async ({ request }) => {
  for (const [locale, title, paths] of [
    // (/admin.php, /administrator, /adminer.php, /media.php: names that only begin like the admin or /media, final review M1)
    ["et", "Lehte ei leitud", ["/olematu-leht", "/wp-admin", "/.env", "/koolitused/a/b", "/admin.php", "/administrator", "/adminer.php", "/media.php", `/e2e-${Date.now()}`]],
    ["ru", "Страница не найдена", ["/ru/net-takoj", "/ru/wp-login.php", `/ru/e2e-${Date.now()}`]],
  ] as const) {
    // the first one may render it (once per locale, also after a change made it stale); every other address is then
    // answered from the same stored page
    expect((await fromCache(request, paths[0])).headers()["x-nextjs-cache"], `${locale}: stored`).toBe("HIT");
    for (const path of paths) {
      const res = await fromCache(request, path);
      expect(res.status(), path).toBe(404);
      expect(res.headers()["x-nextjs-cache"], `${path} (${locale})`).toBe("HIT");
      expect(res.headers()["x-robots-tag"], path).toBe("noindex, nofollow");
      expect(await res.text(), path).toContain(title);
      const head = await request.head(path, { failOnStatusCode: false });
      expect(head.status(), `HEAD ${path}`).toBe(404);
    }
  }
});

test("a registration makes the course page and the calendar render again (seat counts) on their next request", async ({ page, request }, info) => {
  submitsForms();
  // the course page itself and the RU pages (the course page links to them by its language switch); the browser's own
  // prefetches are held back, or they would render a linked page as soon as the action has revalidated it
  const checked = [COURSE, "/ru/koolitused/kulmumeistri-baaskoolitus", "/ru/koolituskalender"];
  await page.route(/[?&]_rsc=/, (route) => route.abort());
  for (const path of checked) expect((await fromCache(request, path)).headers()["x-nextjs-cache"], path).toBe("HIT");
  await page.goto(COURSE);
  await page.getByRole("radio", { name: /Grupikoolitus/ }).check();
  await page.locator("[data-session]:not([aria-disabled='true'])").first().click();
  await page.getByLabel("Nimi").fill("Test Õpilane");
  await page.getByLabel("E-post", { exact: true }).fill(testEmail("cache-register", info.project.name));
  await page.getByLabel("Telefon").fill("+3725555555");
  await page.getByLabel(/tingimustega/).check();
  const action = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(COURSE));
  await page.getByRole("button", { name: "Registreeru" }).click();
  await action;
  // revalidated before the action answered (server/public-cache.ts, round 2 item 22): the very next request renders the
  // page (the pages are expired, never served stale), the one after is cached again. Asked at once, side by side, so
  // that no other test running meanwhile can be the one that renders them.
  const next = await Promise.all(checked.map((path) => request.get(path)));
  expect(next.map((res) => res.headers()["x-nextjs-cache"]), checked.join(", ")).toEqual(checked.map(() => "MISS"));
  await page.waitForURL(`${E2E_MONTONIO.url}/pay/**`);
  for (const path of checked) expect((await fromCache(request, path)).headers()["x-nextjs-cache"], path).toBe("HIT");
  await page.getByRole("button", { name: "Katkesta" }).click(); // ends the hold (the webhook), after the cache checks: it revalidates the pages again
});

test("a cart for a course that does not exist is a 404 that says the cart is empty", async ({ request }) => {
  const res = await request.get("/ostukorv?kursus=ei-ole-olemas-e2e", { failOnStatusCode: false });
  expect(res.status()).toBe(404);
  expect(await res.text()).toContain("Ostukorv on tühi");
});

test("the client router keeps a cached page for 30 s at most (x-nextjs-stale-time)", async ({ request }) => {
  for (const path of ["/", COURSE]) {
    const rsc = await fromCache(request, `${path}?_rsc=st`, { headers: { RSC: "1" } });
    expect(Number(rsc.headers()["x-nextjs-stale-time"]), path).toBeLessThanOrEqual(30);
  }
});

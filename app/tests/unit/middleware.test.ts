import { describe, expect, test } from "vitest";
import { NextRequest, type NextResponse } from "next/server";
import { canonicalPath, middleware } from "@/middleware";

// The path is appended to the origin as it is: new URL("//evil.example/", base) would parse "evil.example" as the host.
// The coming-soon gate is off here (SITE_GATE unset), and then the middleware answers synchronously, as it always did
// (tests/unit/middleware-gate.test.ts checks both).
const run = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => middleware(new NextRequest(`http://localhost${path}`, init)) as NextResponse;
const rewrittenTo = (path: string) => {
  const to = run(path).headers.get("x-middleware-rewrite");
  return to ? new URL(to).pathname + new URL(to).search : null;
};
const passesThrough = (path: string) => {
  const res = run(path);
  return res.headers.get("x-middleware-next") === "1" && !res.headers.get("x-middleware-rewrite") && res.status === 200;
};

describe("noindex (the whole host stays out of search engines)", () => {
  test("every redirect the middleware makes says X-Robots-Tag: noindex, nofollow itself, wherever it is answered", () => {
    for (const p of ["/koolitused/", "/et/koolitused", "/et", "//evil.example/", "/ru/", "/guide", "/p/d", "/admin/"]) {
      const res = run(p);
      expect(res.status, p).toBeGreaterThanOrEqual(300);
      expect(res.headers.get("x-robots-tag"), p).toBe("noindex, nofollow");
    }
  });

  test("other answers leave it to next.config headers() (set here too, it could be sent twice)", () => {
    for (const p of ["/", "/koolitused", "/ru/koolitused", "/admin/login", "/api/feedback/", "/media/img/a.jpg", "/guide/", "/robots.txt"])
      expect(run(p).headers.get("x-robots-tag"), p).toBeNull();
  });
});

describe("an account shell asked for with a query", () => {
  // Next.js keeps the address (path and query) of the request that renders a page in the page it caches, for every later visitor, and
  // a rewrite cannot change it. So no request with a query reaches a shell: a 303 to the same path, the known parameters in the fragment.
  // (Next.js's adapter wants an absolute Location from a middleware and sends it on as a relative path when the host is the request's own:
  // here the path and the fragment are compared, and the origin must be the request's own, whatever the request's headers say)
  const answer = (path: string, method = "GET", extra: Record<string, string> = {}) => {
    const res = run(path, { method, headers: extra });
    const raw = res.headers.get("location");
    const at = raw === null ? null : new URL(raw);
    expect(at === null || at.origin, path).toBe(at === null ? true : "http://localhost");
    return {
      status: res.status,
      location: at === null ? null : at.pathname + at.search + at.hash,
      cache: res.headers.get("cache-control"),
      robots: res.headers.get("x-robots-tag"),
      rewrite: res.headers.get("x-middleware-rewrite"),
      next: res.headers.get("x-middleware-next"),
    };
  };

  test("any method: 303 to the clean path with viga, korda, email and kood in the fragment (URL-encoded, in that order), never kept", () => {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = answer("/konto/sisene?kood=1&email=probe%40example.test&korda=1&viga=link", method);
      expect(res, method).toMatchObject({ status: 303, location: "/konto/sisene#viga=link&korda=1&email=probe%40example.test&kood=1", cache: "no-store", rewrite: null });
      expect(res.robots, method).toBe("noindex, nofollow");
    }
  });

  test("every shell, ET and RU, with the locale kept", () => {
    for (const [path, to] of [
      ["/konto?viga=server", "/konto#viga=server"],
      ["/ru/konto?viga=server", "/ru/konto#viga=server"],
      ["/konto/sisene?viga=link", "/konto/sisene#viga=link"],
      ["/ru/konto/sisene?korda=1", "/ru/konto/sisene#korda=1"],
      ["/konto/lemmikud?korda=1", "/konto/lemmikud#korda=1"],
      ["/ru/konto/andmed?email=a%40example.test", "/ru/konto/andmed#email=a%40example.test"],
      ["/konto/kursus/kulmude-lami?korda=1", "/konto/kursus/kulmude-lami#korda=1"],
      ["/ru/konto/kursus/e-koolitus-2?viga=link", "/ru/konto/kursus/e-koolitus-2#viga=link"],
    ] as const) {
      expect(answer(path), path).toMatchObject({ status: 303, location: to, cache: "no-store" });
    }
  });

  test("anything but the three known parameters is dropped; the first value of each wins; a value too long to be one of ours is dropped", () => {
    expect(answer("/konto/sisene?utm_source=x&fbclid=y&_rsc=abc12&viga=link&viga=server").location).toBe("/konto/sisene#viga=link");
    expect(answer("/konto/sisene?utm_source=x").location).toBe("/konto/sisene");
    expect(answer("/konto/sisene?=x").location).toBe("/konto/sisene");
    expect(answer("/konto/sisene?email=" + "a".repeat(255)).location).toBe("/konto/sisene");
    expect(answer("/konto/sisene?email=" + "a".repeat(254)).location).toBe("/konto/sisene#email=" + "a".repeat(254));
    // characters that mean something in a fragment or an address are encoded, not passed through
    expect(answer("/konto/sisene?email=a%26b%3Dc%23d%20e%2Bf").location).toBe("/konto/sisene#email=a%26b%3Dc%23d+e%2Bf");
    expect(answer("/konto/sisene?viga=%0d%0aLocation:%20https://evil.example").location).toMatch(/^\/konto\/sisene#viga=[A-Za-z0-9%+._*-]*$/);
  });

  test("the Location is the matched path and the fragment only: no header of the request leads anywhere else", () => {
    const hostile = { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", "x-forwarded-for": "10.0.0.1", "x-original-url": "//evil.example/x", referer: "https://evil.example/", origin: "https://evil.example" };
    for (const path of ["/konto/sisene?viga=link", "/ru/konto?korda=1", "/konto/kursus/x?email=a%40example.test"]) {
      const { location } = answer(path, "GET", hostile);
      expect(location, path).toMatch(/^\/(ru\/)?konto[a-z0-9/-]*(#[A-Za-z0-9%=&+._*-]*)?$/);
      expect(location, path).not.toMatch(/evil|\/\//);
    }
  });

  test("no query: passes through unchanged (a rewrite for ET, as it is for RU)", () => {
    expect(answer("/konto/sisene")).toMatchObject({ status: 200, rewrite: expect.stringContaining("/et/konto/sisene") });
    expect(answer("/ru/konto/sisene")).toMatchObject({ status: 200, location: null, next: "1" });
    expect(answer("/konto/sisene", "POST")).toMatchObject({ status: 200, location: null });
  });

  test("not a shell: untouched, the query stays (public pages, the cart, the API, the admin, an unknown address under /konto)", () => {
    for (const path of ["/koolitused/x?sessioon=1", "/ru/koolitused?x=1", "/?uudiskiri=kinnitatud", "/kontakt?x=1", "/ru/kontakt?x=1", "/kontoo?x=1", "/api/konto/verify?t=abc", "/api/konto?x=1", "/admin?x=1", "/admin/login?viga=link"]) {
      const res = answer(path);
      expect(res.status, path).toBe(200);
      expect(res.location, path).toBeNull();
    }
    expect(rewrittenTo("/ostukorv?kursus=x")).toBe("/et/ostukorv/x?kursus=x");
    expect(rewrittenTo("/koolitused/kulmude-lami?sessioon=3")).toBe("/et/koolitused/kulmude-lami?sessioon=3");
    // an address under /konto that is no page is the 404 page, with its query as it came (it renders nothing of the account)
    for (const path of ["/konto/x/y?viga=link", "/konto/kursus?viga=link", "/konto/kursus/A?viga=link", "/ru/konto/sisene/x?viga=link", "/konto/sisene/x?viga=link"]) {
      const res = answer(path);
      expect(res.status, path).toBe(200);
      expect(res.location, path).toBeNull();
      expect(new URL(res.rewrite!).pathname, path).toMatch(/^\/(et|ru)\/leidmata$/);
    }
  });

  test("an encoded, doubled or slashed path is never matched as a shell, and nothing is redirected off the site", () => {
    for (const path of ["/konto%2Fsisene?viga=link", "/%6Bonto/sisene?viga=link", "/konto/sisene%00?viga=link", "/konto/sisene%2F?viga=link", "/konto/%2e%2e/admin?viga=link", "/.konto/sisene?viga=link"]) {
      const res = answer(path);
      expect(res.status, path).not.toBe(303);
      expect(res.location, path).toBeNull();
    }
    // a trailing slash, a doubled slash and an /et prefix go to the canonical path first (308, the query as it came), then the 303
    for (const [path, to] of [["/konto/sisene/?viga=link", "/konto/sisene?viga=link"], ["/et/konto/sisene?viga=link", "/konto/sisene?viga=link"], ["//konto/sisene?viga=link", "/konto/sisene?viga=link"]] as const) {
      const res = run(path);
      expect(res.status, path).toBe(308);
      expect(new URL(res.headers.get("location")!, "http://localhost").pathname + new URL(res.headers.get("location")!, "http://localhost").search, path).toBe(to);
    }
    expect(answer("/konto/sisene?viga=link").location).toBe("/konto/sisene#viga=link");
  });
});

describe("locale middleware", () => {
  test("Estonian pages are served from the et locale without changing the URL", () => {
    expect(rewrittenTo("/")).toBe("/et");
    expect(rewrittenTo("/koolitused")).toBe("/et/koolitused");
    expect(rewrittenTo("/koolitused/kulmumeistri-baaskoolitus?sessioon=3")).toBe("/et/koolitused/kulmumeistri-baaskoolitus?sessioon=3");
  });

  test("an account shell asked for without a query is served as before: ET rewritten to /et, RU as it is", () => {
    expect(rewrittenTo("/konto/sisene")).toBe("/et/konto/sisene");
    expect(rewrittenTo("/konto/kursus/kulmude-lami")).toBe("/et/konto/kursus/kulmude-lami");
    expect(passesThrough("/ru/konto/sisene")).toBe(true);
    expect(passesThrough("/ru/konto")).toBe(true);
    // a bare "?" is no query
    expect(rewrittenTo("/konto/sisene?")).toBe("/et/konto/sisene");
    expect(passesThrough("/ru/konto?")).toBe(true);
  });

  test("the public pages keep their query (the cart's course, the course page's date, the practice package)", () => {
    expect(rewrittenTo("/koolitused/kulmude-lami?sessioon=3")).toBe("/et/koolitused/kulmude-lami?sessioon=3");
    expect(rewrittenTo("/ostukorv?kursus=x")).toBe("/et/ostukorv/x?kursus=x");
    expect(passesThrough("/ru/koolitused?kategooria=x")).toBe(true);
  });

  test("Russian pages render app/[locale]=ru directly", () => {
    expect(passesThrough("/ru")).toBe(true);
    expect(passesThrough("/ru/koolitused")).toBe(true);
  });

  test("an explicit /et prefix redirects permanently to the unprefixed URL", () => {
    for (const [from, to] of [["/et", "/"], ["/et/", "/"], ["/et/koolitused", "/koolitused"], ["/et/koolitused?x=1", "/koolitused?x=1"]]) {
      const res = run(from);
      expect(res.status, from).toBe(308);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname + location.search, from).toBe(to);
    }
  });

  test("admin, api, media, hub files and static paths are not rewritten", () => {
    for (const p of ["/admin", "/admin/login", "/api/feedback", "/api/feedback/abc123def456gh", "/media/img/a.jpg", "/p/b/index.html", "/p/d/assets/logo.png", "/guide/og.jpg", "/guide/thumbs/a-d.jpg", "/_next/static/chunk.js", "/feedback.js", "/robots.txt", "/favicon.ico", "/icon.svg", "/brand/logo.png", "/seed/r1.jpg", "/og.jpg"])
      expect(passesThrough(p), p).toBe(true);
  });

  test("paths that only start like a locale are still Estonian pages (the Estonian 404 page: they name no page)", () => {
    expect(rewrittenTo("/russia")).toBe("/et/leidmata");
    expect(rewrittenTo("/etude")).toBe("/et/leidmata");
  });

  test("the cart of one course is a page of its own, so that it can be cached by its path (Task 17)", () => {
    expect(rewrittenTo("/ostukorv?kursus=kulmumeistri-e-koolitus")).toBe("/et/ostukorv/kulmumeistri-e-koolitus?kursus=kulmumeistri-e-koolitus");
    expect(rewrittenTo("/ru/ostukorv?kursus=kulmumeistri-e-koolitus")).toBe("/ru/ostukorv/kulmumeistri-e-koolitus?kursus=kulmumeistri-e-koolitus");
    expect(rewrittenTo("/ostukorv?kursus=a%2Fb")).toBe("/et/ostukorv/a%2Fb?kursus=a%2Fb"); // one path segment, whatever it says
    // without a course: the empty cart
    expect(rewrittenTo("/ostukorv")).toBe("/et/ostukorv");
    expect(rewrittenTo("/ostukorv?kursus=")).toBe("/et/ostukorv?kursus=");
    expect(passesThrough("/ru/ostukorv")).toBe(true);
  });

  test("paths that only start like the hub, a static file or the OG image are Estonian pages (here: the 404 page)", () => {
    for (const p of ["/guidexyz", "/guides", "/p", "/feedback.json", "/feedback.jsx", "/robots.txt.bak", "/og.html", "/og.jpg.html", "/ogx", "/og.svg", "/og.png"])
      expect(rewrittenTo(p), p).toBe("/et/leidmata");
  });

  test("every address without a page of its own is served from its locale's one 404 page (round 2 item 21)", () => {
    for (const p of ["/wp-admin", "/wp-login.php", "/.env", "/xmlrpc.php", "/olematu-leht", "/koolitused/Suur", "/koolitused/a/b", "/uudised/x.php", "/leidmata"])
      expect(rewrittenTo(p), p).toBe("/et/leidmata");
    for (const p of ["/ru/net-takoj", "/ru/wp-admin", "/ru/koolitused/a/b"]) expect(rewrittenTo(p), p).toBe("/ru/leidmata");
    // the pages themselves stay as they are
    expect(rewrittenTo("/koolitused/kulmumeistri-baaskoolitus")).toBe("/et/koolitused/kulmumeistri-baaskoolitus");
    expect(rewrittenTo("/uudised/x")).toBe("/et/uudised/x");
    expect(rewrittenTo("/ru/koolituskalender")).toBeNull(); // /ru/* renders as it is
  });
});

describe("design-review hub (public/guide, public/p/<dir>)", () => {
  test("a hub folder with its slash serves its index.html (next dev; in production the static assets do it)", () => {
    expect(rewrittenTo("/guide/")).toBe("/guide/index.html");
    expect(rewrittenTo("/guide/tagasiside/")).toBe("/guide/tagasiside/index.html");
    expect(rewrittenTo("/p/d/")).toBe("/p/d/index.html");
    expect(rewrittenTo("/p/moodboard/")).toBe("/p/moodboard/index.html");
    expect(rewrittenTo("/guide/?fb=abc123def456gh")).toBe("/guide/index.html?fb=abc123def456gh");
  });

  test("a hub folder without its slash redirects to it (as the static assets do), keeping the query", () => {
    for (const [from, to] of [["/guide", "/guide/"], ["/guide/tagasiside", "/guide/tagasiside/"], ["/p/d", "/p/d/"], ["/p/d?fb=abc123def456gh", "/p/d/?fb=abc123def456gh"]]) {
      const res = run(from);
      expect(res.status, from).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname + location.search, from).toBe(to);
    }
  });
});

describe("trailing slash (Next's own redirect is off for the hub: next.config skipTrailingSlashRedirect)", () => {
  test("every other path loses its trailing slash with a permanent redirect, keeping the query", () => {
    for (const [from, to] of [
      ["/koolitused/", "/koolitused"],
      ["/koolitused/kulmumeistri-baaskoolitus/?sessioon=3", "/koolitused/kulmumeistri-baaskoolitus?sessioon=3"],
      ["/ru/", "/ru"],
      ["/ru/koolitused/", "/ru/koolitused"],
      ["/admin/", "/admin"],
      ["/guidexyz/", "/guidexyz"],
      ["/et/koolitused/", "/koolitused"],
    ]) {
      const res = run(from);
      expect(res.status, from).toBe(308);
      const location = new URL(res.headers.get("location")!);
      expect(location.origin + location.pathname + location.search, from).toBe(`http://localhost${to}`);
    }
  });

  test("API routes are never redirected (a POST to /api/x/ must not turn into a GET elsewhere)", () => {
    for (const p of ["/api/feedback/", "/api/feedback", "/api/auth/request/", "/api/feedback/abc123def456gh/"]) expect(passesThrough(p), p).toBe(true);
  });

  test("a redirect never leaves the site: leading slashes and backslashes collapse to one slash", () => {
    // Next.js turns a same-origin Location into a relative one: "//evil.example" there would be another host.
    for (const [from, to] of [
      ["//evil.example/", "/evil.example"],
      ["///evil.example/", "/evil.example"],
      ["//evil.example/x/?q=1", "/evil.example/x?q=1"],
      ["/et//evil.example", "/evil.example"],
      ["/et//evil.example/", "/evil.example"],
      ["//", "/"],
    ]) {
      const res = run(from);
      expect(res.status, from).toBe(308);
      const location = new URL(res.headers.get("location")!);
      expect(location.origin, from).toBe("http://localhost");
      expect(location.pathname + location.search, from).toBe(to);
      expect(location.pathname.startsWith("//"), from).toBe(false);
    }
  });

  test("encoded slashes and backslashes stay part of a same-origin path (%2F, %5C are not separators)", () => {
    for (const [from, to] of [
      ["/%2F%2Fevil.com/", "/%2F%2Fevil.com"],
      ["/%5C%5Cevil.com/", "/%5C%5Cevil.com"],
      ["/et/%2F%2Fevil.com/", "/%2F%2Fevil.com"],
      ["/et/%2F%2Fevil.com", "/%2F%2Fevil.com"],
    ]) {
      const res = run(from);
      expect(res.status, from).toBe(308);
      const raw = res.headers.get("location")!;
      const location = new URL(raw);
      expect(location.origin, from).toBe("http://localhost");
      expect(location.pathname, from).toBe(to);
      expect(location.pathname.startsWith("//") || location.pathname.startsWith("/\\"), from).toBe(false);
      // as a browser resolves the relative Location Next.js sends (path only): still this site
      expect(new URL(location.pathname, "https://mslab.example").origin, from).toBe("https://mslab.example");
    }
    // without a trailing slash or /et there is nothing to redirect: an Estonian page (a 404)
    expect(rewrittenTo("/%2F%2Fevil.com")).toBe("/et/leidmata");
  });

  test("canonicalPath: one slash in front, none at the end, no /et prefix", () => {
    expect(canonicalPath("//evil.example/")).toBe("/evil.example");
    expect(canonicalPath("/\\evil.example")).toBe("/evil.example");
    expect(canonicalPath("/\\/evil.example/")).toBe("/evil.example");
    expect(canonicalPath("/et//evil.example")).toBe("/evil.example");
    expect(canonicalPath("/et/\\evil.example")).toBe("/evil.example");
    expect(canonicalPath("/koolitused/")).toBe("/koolitused");
    expect(canonicalPath("/et")).toBe("/");
    expect(canonicalPath("/")).toBe("/");
    expect(canonicalPath("/koolitused")).toBe("/koolitused");
  });

  test("the home page keeps its slash", () => {
    expect(rewrittenTo("/")).toBe("/et");
    expect(rewrittenTo("/?x=1")).toBe("/et?x=1");
  });
});

// B19 (admin UX pass piece 4c, ruling R-f): a server component does not know the address it renders, so the middleware hands the admin's path and query
// on in a request header; requireAdmin() builds the login page's ?tagasi= of it. The header is the middleware's own: one a client sends is replaced.
describe("the admin's way back after signing in (x-mslab-path)", () => {
  const handedOn = (path: string, headers?: Record<string, string>) => {
    const res = run(path, headers ? { headers } : undefined);
    return { next: res.headers.get("x-middleware-next"), path: res.headers.get("x-middleware-request-x-mslab-path"), overrides: res.headers.get("x-middleware-override-headers") };
  };

  test("every /admin address passes on with its path and query in the request header", () => {
    for (const p of ["/admin", "/admin/kalender?id=3", "/admin/testimine", "/admin/login?tagasi=%2Fadmin%2Fkalender", "/admin/tagasiside?vaade=arvustused&olek=ootel"]) {
      const h = handedOn(p);
      expect(h.next, p).toBe("1");
      expect(h.path, p).toBe(p);
      expect(h.overrides?.split(","), p).toContain("x-mslab-path");
    }
  });

  test("a header the client sent is replaced on /admin, and the other request headers stay", () => {
    const res = run("/admin/kalender", { headers: { "x-mslab-path": "//evil.example", cookie: "a=1" } });
    expect(res.headers.get("x-middleware-request-x-mslab-path")).toBe("/admin/kalender");
    expect(res.headers.get("x-middleware-request-cookie")).toBe("a=1");
  });

  test("nothing is added anywhere else (the site, the API, an address that only starts like the admin)", () => {
    for (const p of ["/", "/koolitused", "/api/auth/verify?t=x", "/api/admin/margid", "/adminx", "/media/img/a.jpg"]) expect(handedOn(p).path, p).toBeNull();
  });
});

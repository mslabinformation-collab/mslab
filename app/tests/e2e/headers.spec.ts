import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { LOCAL_ENV } from "../local-secrets";
import { PROD_ENV } from "./prod-build";
import { DEV_ENV } from "./server";
import { PROD_BUILD, TARGET } from "./target";
import { test, expect } from "./test";

// Read-only checks of the answers themselves, like `curl -I`: they run against the local dev server, the local
// production build (E2E_PROD_BUILD) and a deployment (E2E_BASE_URL). Task 16 items 14 (link preview) and 16 (noindex on
// every kind of answer). The headers every answer carries come from next.config.ts headers().

const NOINDEX = "noindex, nofollow";
const REFERRER = "strict-origin-when-cross-origin";
const FRAMING = "frame-ancestors 'self'";

/**
 * The site's address (SITE_URL): link previews name it, whichever host served the page (Task 17). The local production build's own
 * address (prod-build.ts), the dev server's own (server.ts DEV_ENV), or, for a deployment, the public value of .env.example.
 */
const SITE_URL = PROD_BUILD ? PROD_ENV.SITE_URL : TARGET ? LOCAL_ENV.SITE_URL : DEV_ENV.SITE_URL;

/** HEAD (as curl -I), without following redirects; GET where the answer to HEAD would not say anything. */
async function head(request: APIRequestContext, path: string) {
  const res = await request.fetch(path, { method: "HEAD", maxRedirects: 0, failOnStatusCode: false });
  return res.status() === 405 ? request.fetch(path, { method: "GET", maxRedirects: 0, failOnStatusCode: false }) : res;
}

test.describe("noindex on every kind of answer (item 16)", () => {
  test.skip(({ isMobile }) => isMobile, "the same answers for every browser: desktop project only");

  test("pages, 404, API, /media, static files, the hub and redirects all say X-Robots-Tag: noindex, nofollow; none says X-Powered-By", async ({ request }) => {
    // a built script of the page itself (a hashed /_next/static file)
    const html = await (await request.get("/")).text();
    const chunk = /\/_next\/static\/[^"'\s]+\.js/.exec(html)?.[0];
    expect(chunk, "a /_next/static script in the home page").toBeTruthy();

    const answers: [path: string, status: number | RegExp][] = [
      ["/", 200],
      ["/ru", 200],
      ["/koolitused", 200],
      ["/koolitused/kulmumeistri-baaskoolitus", 200],
      ["/uudised", 200],
      ["/olematu-leht", 404],
      ["/ru/net-takoj", 404],
      ["/admin/login", 200],
      ["/api/feedback", 401],
      ["/api/feedback/zzzzzzzzzzzzzz", 404],
      ["/media/img/olematu.jpg", 404],
      ["/robots.txt", 200],
      ["/favicon.ico", 200],
      ["/og.jpg", 200],
      ["/feedback.js?v=5", 200],
      ["/seed/flower-hero.png", 200],
      ["/brand/logo.png", 200],
      [chunk!, 200],
      ["/guide/", 200],
      ["/p/d/styles.css", 200],
      // redirects
      ["/koolitused/", 308],
      ["/et/koolitused", 308],
      ["/guide", /^30[78]$/],
      ["/p/d", /^30[78]$/],
    ];
    const report: string[] = [];
    for (const [path, status] of answers) {
      const res = await head(request, path);
      const ok = typeof status === "number" ? res.status() === status : status.test(String(res.status()));
      const robots = res.headers()["x-robots-tag"];
      report.push(`${path} → ${res.status()} x-robots-tag: ${robots ?? "(none)"}`);
      expect(ok, `${path}: status ${res.status()}`).toBe(true);
      expect(robots, `${path} (${res.status()}): once, exactly`).toBe(NOINDEX);
      expect(res.headers()["referrer-policy"], `${path} (${res.status()}): Referrer-Policy once, exactly`).toBe(REFERRER);
      expect(res.headers()["x-powered-by"], `${path}: no X-Powered-By (N12)`).toBeUndefined();
    }
    test.info().annotations.push({ type: "answers", description: report.join("\n") });
  });

  test("robots.txt keeps search engines out and lets only link-preview bots in", async ({ request }) => {
    const text = await (await request.get("/robots.txt")).text();
    const groups = text.split(/\n\s*\n/).map((g) => g.replace(/^#.*$/gm, "").trim()).filter(Boolean);
    const all = groups.find((g) => /^User-agent:\s*\*$/im.test(g));
    expect(all, "a group for every other robot").toMatch(/^Disallow:\s*\/\s*$/im);
    const PREVIEW = /^(facebookexternalhit|Facebot|Twitterbot|LinkedInBot|TelegramBot|WhatsApp|Slackbot-LinkExpanding|Slackbot|Discordbot|SkypeUriPreview|vkShare|Pinterestbot|redditbot)$/i;
    for (const g of groups.filter((x) => x !== all)) {
      const agents = [...g.matchAll(/^User-agent:\s*(.+)$/gim)].map((m) => m[1].trim());
      for (const a of agents) expect(a, "only link-preview bots are allowed in").toMatch(PREVIEW);
    }
    expect(text).not.toMatch(/Googlebot|bingbot|Yandex|Applebot/i); // search crawlers (Applebot feeds Siri / Spotlight search)
  });
});

test.describe("link preview of the home page (item 14)", () => {
  test.skip(({ isMobile }) => isMobile, "the same markup for every browser: desktop project only");

  test("/ and /ru carry Open Graph and Twitter card tags with the 1200×630 home picture", async ({ page }) => {
    for (const [path, locale, title] of [
      ["/", "et_EE", "MS LAB Koolituskeskus — Brow & Lash Academy"],
      ["/ru", "ru_RU", "MS LAB Учебный центр — Brow & Lash Academy"],
    ] as const) {
      await page.goto(path);
      const meta = (key: string) => page.locator(`meta[property="${key}"], meta[name="${key}"]`).first().getAttribute("content");
      expect(await meta("og:title"), path).toBe(title);
      expect(await meta("og:description"), path).toBeTruthy();
      expect(await meta("og:type"), path).toBe("website");
      expect(await meta("og:locale"), path).toBe(locale);
      expect(new URL((await meta("og:url"))!).pathname, path).toBe(path);
      const image = new URL((await meta("og:image"))!);
      // a cached page is the same for every host that serves it (custom domain, Vercel addresses): absolute links use SITE_URL
      expect(image.origin, "the picture is on the site's address").toBe(new URL(SITE_URL).origin);
      expect(image.pathname).toBe("/og.jpg");
      expect(await meta("og:image:width")).toBe("1200");
      expect(await meta("og:image:height")).toBe("630");
      expect(await meta("og:image:alt"), path).toBeTruthy();
      expect(await meta("twitter:card")).toBe("summary_large_image");
      expect(new URL((await meta("twitter:image"))!).pathname).toBe("/og.jpg");
    }
  });

  test("a course and a post preview themselves; other pages name the site only, never the home page's title (fix round 1)", async ({ page }) => {
    const meta = (key: string) => page.locator(`meta[property="${key}"], meta[name="${key}"]`).first().getAttribute("content");
    const count = (key: string) => page.locator(`meta[property="${key}"], meta[name="${key}"]`).count();
    const home = "MS LAB Koolituskeskus — Brow & Lash Academy";
    for (const [path, title, description, image] of [
      ["/koolitused/kulmumeistri-baaskoolitus", "Kulmumeistri baaskoolitus", "Tugev vundament sinu teekonnale kulmumeistrina.", "/seed/brow-editorial.jpg"],
      ["/uudised/kuidas-valida-endale-sobiv-kulmukoolitus", "Kuidas valida endale sobiv kulmukoolitus?", "Baas- või täiendkoolitus, e-õpe või kontaktpäev — lühike juhend, kust alustada.", "/seed/brow-editorial.jpg"],
    ] as const) {
      await page.goto(path);
      expect(await meta("og:title"), path).toBe(title);
      expect(await meta("og:description"), path).toBe(description);
      expect(await meta("twitter:title"), path).toBe(title);
      expect(await meta("twitter:description"), path).toBe(description);
      expect(new URL((await meta("og:url"))!).pathname, path).toBe(path);
      expect(new URL((await meta("og:image"))!).pathname, path).toBe(image);
      expect(new URL((await meta("twitter:image"))!).pathname, path).toBe(image);
      expect(await meta("og:site_name"), path).toBe("MS LAB Koolituskeskus");
    }
    // other pages: the layout adds the site's name, language and picture; Next.js fills in each page's own title and
    // description (never the home page's)
    for (const path of ["/praktika", "/koolitused", "/kontakt", "/ru/koolituskalender"]) {
      await page.goto(path);
      const own = await page.title();
      expect(own, path).not.toBe(home);
      expect(await meta("og:title"), path).toBe(own);
      expect(await meta("twitter:title"), path).toBe(own);
      expect(await meta("og:description"), path).toBe(await meta("description"));
      expect(await count("og:url"), path).toBe(0);
      expect(new URL((await meta("og:image"))!).pathname, path).toBe("/og.jpg");
      expect(await meta("og:site_name"), path).toMatch(/^MS LAB/);
    }
  });

  test("the picture is a 1200×630 JPEG without provenance or tool names in it", async ({ request }) => {
    const res = await request.get("/og.jpg?v=1");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/image\/jpeg/);
    const bytes = await res.body();
    // the frame size from the JPEG's start-of-frame marker (SOF0…SOF3)
    let size: [number, number] | null = null;
    for (let i = 2; i < bytes.length - 9 && !size; ) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1];
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) size = [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)];
      i += 2 + len;
    }
    expect(size).toEqual([1200, 630]);
    expect(bytes.toString("latin1")).not.toMatch(/claude|anthropic|lovable|openai|gemini|midjourney|dall-e|c2pa|jumbf/i);
  });
});

test.describe("uploaded images: the /media route's own answers (final review I1)", () => {
  test.skip(({ isMobile }) => isMobile, "the same answers for every browser: desktop project only");

  test("/media: the route's 404s with noindex and nosniff, never kept by a CDN", async ({ request }) => {
    // a key putImage could have made, of an image that does not exist; and keys it never makes
    for (const path of ["/media/img/00000000-0000-4000-8000-000000000000.jpg", "/media/img/olematu.jpg", "/media/img/x.svg"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await request.fetch(path, { method, maxRedirects: 0, failOnStatusCode: false });
        expect(res.status(), `${method} ${path}`).toBe(404);
        expect(res.headers()["x-robots-tag"], `${method} ${path}`).toBe(NOINDEX);
        expect(res.headers()["x-content-type-options"], `${method} ${path}`).toBe("nosniff");
        expect(res.headers()["cache-control"], `${method} ${path}`).toMatch(/no-store/);
        expect(res.headers()["content-security-policy"], `${method} ${path}`).toBe("default-src 'none'; sandbox");
        // an image asked for too early is not remembered as missing (server/media.ts)
        expect(res.headers()["vercel-cdn-cache-control"], `${method} ${path}`).toBeUndefined();
      }
    }
    // addresses that only look like /media are not images: the site's 404 page
    for (const path of ["/media.php", "/mediakit"]) {
      const res = await request.get(path, { failOnStatusCode: false });
      expect(res.status(), path).toBe(404);
      expect(await res.text(), path).toContain("Lehte ei leitud");
    }
  });
});

test.describe("framing: only by this site's own pages (final review M10)", () => {
  test("pages, the 404 page, the admin, the hub and the prototypes say frame-ancestors 'self', once", async ({ request, isMobile }) => {
    test.skip(isMobile, "the same answers for every browser: desktop project only");
    for (const path of ["/", "/ru", "/koolitused/kulmumeistri-baaskoolitus", "/olematu-leht", "/admin/login", "/guide/", "/p/d/", "/p/a/"]) {
      const res = await request.get(path, { maxRedirects: 0, failOnStatusCode: false });
      expect(res.status(), path).toBeLessThan(500);
      expect(res.headers()["content-security-policy"], path).toBe(FRAMING);
    }
  });

  test("the hub still shows the prototypes in its frame, at desktop and phone size", async ({ page }) => {
    const refused: string[] = [];
    page.on("console", (m) => {
      if (/frame-ancestors|refused to (display|frame)/i.test(m.text())) refused.push(m.text());
    });
    for (const [dir, device] of [["d", "desk"], ["a", "mob"], ["b", "mob"]] as const) {
      await page.goto("about:blank"); // (a new hash alone would not load the hub again)
      await page.goto(`/guide/#vaade=${dir}&seade=${device}`);
      await expect(page.locator("#viewer")).toBeVisible();
      // the framed document is the prototype itself (same origin, so the hub can reach into it), with its content
      await expect
        .poll(
          () =>
            page.locator("#ifr").evaluate((f: HTMLIFrameElement) => {
              try {
                const doc = f.contentDocument;
                return doc && doc.body && doc.body.children.length > 0 ? f.contentWindow!.location.pathname : "";
              } catch {
                return "blocked";
              }
            }),
          { message: `${dir} at ${device}` },
        )
        .toBe(`/p/${dir}/`);
      await expect(page.locator("#ifr")).toBeVisible();
    }
    expect(refused).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Parity on `next start` / Vercel (Move to Vercel, Task 5). Before, a Cloudflare layer put these headers on every answer;
// now only next.config.ts headers() (and src/middleware.ts for its own redirects) do. The static files of public/ (the
// design-review hub, the prototypes, og.jpg, robots.txt, feedback.js, favicon.ico), the built /_next/static files, the
// middleware's redirects and the 404s are not answers of a page route, so each kind is checked on its own: the same
// three headers (noindex, framing by this site only, the origin as referrer), each once, and no X-Powered-By.

/** The headers every answer of the site carries, whatever made it (a route, a static file, the middleware, Next.js). */
function expectSiteHeaders(res: APIResponse, label: string): void {
  const h = res.headers();
  expect(h["x-robots-tag"], `${label}: X-Robots-Tag once, exactly`).toBe(NOINDEX);
  expect(h["content-security-policy"], `${label}: framing by this site only, once, exactly`).toBe(FRAMING);
  expect(h["referrer-policy"], `${label}: Referrer-Policy once, exactly`).toBe(REFERRER);
  expect(h["x-powered-by"], `${label}: no X-Powered-By (N12)`).toBeUndefined();
}

/** Is the answer text (HTML, CSS, JavaScript, plain text) by its Content-Type? */
function isText(contentType: string | undefined): boolean {
  return /^text\/|javascript/i.test(contentType ?? "");
}

/**
 * Is `served` the file `onDisk`? Byte for byte for a binary. Text without regard to line ends: the checkout here has CRLF
 * (core.autocrlf, no .gitattributes) while a deployment built from Git sends LF, and the same file is both.
 */
function sameFile(served: Buffer, onDisk: Buffer, text: boolean): boolean {
  if (!text) return served.equals(onDisk);
  return served.toString("utf8").replace(/\r\n/g, "\n") === onDisk.toString("utf8").replace(/\r\n/g, "\n");
}

/** Where a redirect goes, as a path with its query (Location may be a full address or only a path). */
function redirectTarget(res: APIResponse): string {
  const to = new URL(res.headers()["location"] ?? "", "http://site.test");
  return to.pathname + to.search;
}

test.describe("static files and the hub: the same headers as a page (Task 5)", () => {
  test.skip(({ isMobile }) => isMobile, "the same answers for every browser: desktop project only");

  test("the hub, the prototypes, og.jpg, robots.txt, feedback.js, favicon.ico and built /_next/static files: noindex, framing, referrer; GET and HEAD", async ({ request }) => {
    const home = await (await request.get("/")).text();
    const script = /\/_next\/static\/[^"'\s]+\.js/.exec(home)?.[0];
    const style = /\/_next\/static\/[^"'\s]+\.css/.exec(home)?.[0];
    expect(script, "a /_next/static script in the home page").toBeTruthy();
    expect(style, "a /_next/static stylesheet in the home page").toBeTruthy();

    // [address, content type, the file of public/ it must arrive as, byte for byte (none for a built file)]
    const files: [path: string, type: RegExp, file?: string][] = [
      ["/guide/", /^text\/html/, "guide/index.html"],
      ["/guide/tagasiside/", /^text\/html/, "guide/tagasiside/index.html"],
      ["/p/d/", /^text\/html/, "p/d/index.html"],
      ["/p/a/", /^text\/html/, "p/a/index.html"],
      ["/p/d/styles.css", /^text\/css/, "p/d/styles.css"],
      ["/p/d/app.js", /javascript/, "p/d/app.js"],
      ["/guide/thumbs/a-d.jpg", /^image\/jpeg/, "guide/thumbs/a-d.jpg"],
      ["/og.jpg", /^image\/jpeg/, "og.jpg"],
      ["/robots.txt", /^text\/plain/, "robots.txt"],
      ["/feedback.js", /javascript/, "feedback.js"],
      ["/favicon.ico", /^image\/(x-icon|vnd\.microsoft\.icon)/, "favicon.ico"],
      [script!, /javascript/],
      [style!, /^text\/css/],
    ];
    for (const [path, type, file] of files) {
      for (const method of ["GET", "HEAD"]) {
        const label = `${method} ${path}`;
        const res = await request.fetch(path, { method, maxRedirects: 0, failOnStatusCode: false });
        expect(res.status(), label).toBe(200);
        expect(res.headers()["content-type"], label).toMatch(type);
        expectSiteHeaders(res, label);
        // a built file is named by its content hash: kept for a year (not by `next dev`, which rebuilds them); Vercel writes
        // the value without spaces
        if (file === undefined && TARGET) expect(res.headers()["cache-control"]?.replace(/\s+/g, ""), label).toBe("public,max-age=31536000,immutable");
        // the file itself, not the site's 404 page or another file (the hub's index pages are served by the middleware)
        if (file !== undefined && method === "GET") {
          const onDisk = readFileSync(join(process.cwd(), "public", file));
          const served = await res.body();
          expect(sameFile(served, onDisk, isText(res.headers()["content-type"])), `${label}: the file public/${file}`).toBe(true);
          // a deployment built from Git sends the text with LF, whatever this checkout (core.autocrlf) has: still the file
          if (isText(res.headers()["content-type"])) expect(sameFile(Buffer.from(onDisk.toString("utf8").replace(/\r\n/g, "\n")), onDisk, true), `${label}: with LF line ends`).toBe(true);
        }
      }
    }
  });

  test("the file comparison ignores line ends of text, never of anything else", () => {
    const lf = Buffer.from("a\nb\n");
    const crlf = Buffer.from("a\r\nb\r\n");
    expect(sameFile(lf, crlf, true), "text: LF served, CRLF checked out").toBe(true);
    expect(sameFile(crlf, lf, true), "text: CRLF served, LF checked out").toBe(true);
    expect(sameFile(lf, Buffer.from("a\nc\n"), true), "text: another letter").toBe(false);
    expect(sameFile(lf, Buffer.from("a\n\nb\n"), true), "text: another line").toBe(false);
    expect(sameFile(lf, crlf, false), "binary: a 0x0D byte is a difference").toBe(false);
    expect(sameFile(crlf, Buffer.from(crlf), false), "binary: the same bytes").toBe(true);
    expect(isText("text/html; charset=UTF-8")).toBe(true);
    expect(isText("application/javascript; charset=UTF-8")).toBe(true);
    expect(isText("text/css; charset=UTF-8")).toBe(true);
    expect(isText("text/plain; charset=UTF-8")).toBe(true);
    for (const type of ["image/jpeg", "image/x-icon", "image/vnd.microsoft.icon", undefined]) expect(isText(type), String(type)).toBe(false);
  });

  test("a file asked for with a query string (?v=) gets the same headers", async ({ request }) => {
    for (const path of ["/og.jpg?v=1", "/feedback.js?v=5", "/guide/?v=1", "/p/d/?x=1"]) {
      const res = await request.get(path, { maxRedirects: 0, failOnStatusCode: false });
      expect(res.status(), path).toBe(200);
      expectSiteHeaders(res, path);
    }
  });
});

test.describe("redirects: noindex and the other headers on the middleware's own answers (Task 5)", () => {
  test.skip(({ isMobile }) => isMobile, "the same answers for every browser: desktop project only");

  // Next.js lets both next.config.ts headers() and the middleware's own headers reach a redirect the middleware made;
  // the middleware also sets X-Robots-Tag on its redirects itself (src/middleware.ts), so the header is there wherever
  // they are answered. What the answer must not do is carry it twice: expectSiteHeaders compares the whole value.
  test("the hub's folder without its slash (307), a trailing slash and the /et prefix (308): Location, noindex, framing, referrer", async ({ request }) => {
    const redirects: [from: string, status: number, to: string][] = [
      ["/guide", 307, "/guide/"],
      ["/guide?v=1", 307, "/guide/?v=1"],
      ["/guide/tagasiside", 307, "/guide/tagasiside/"],
      ["/p/d", 307, "/p/d/"],
      ["/p/moodboard", 307, "/p/moodboard/"],
      ["/koolitused/", 308, "/koolitused"],
      ["/koolitused/?kuupaev=1", 308, "/koolitused?kuupaev=1"],
      ["/ru/koolitused/", 308, "/ru/koolitused"],
      ["/admin/login/", 308, "/admin/login"],
      ["/et/koolitused", 308, "/koolitused"],
      ["/et", 308, "/"],
    ];
    for (const [from, status, to] of redirects) {
      for (const method of ["GET", "HEAD"]) {
        const label = `${method} ${from}`;
        const res = await request.fetch(from, { method, maxRedirects: 0, failOnStatusCode: false });
        expect(res.status(), label).toBe(status);
        expect(redirectTarget(res), label).toBe(to);
        expectSiteHeaders(res, label);
      }
    }
  });

  test("following a hub redirect lands on the hub's page, with its headers", async ({ request }) => {
    for (const [from, to] of [["/guide", "/guide/"], ["/p/b", "/p/b/"]]) {
      const res = await request.get(from, { failOnStatusCode: false }); // follows the redirect
      expect(res.status(), from).toBe(200);
      expect(new URL(res.url()).pathname, from).toBe(to);
      expectSiteHeaders(res, `${from} → ${to}`);
    }
  });
});

test.describe("404s of every kind: noindex and the other headers (Task 5)", () => {
  test.skip(({ isMobile }) => isMobile, "the same answers for every browser: desktop project only");

  test("an unknown page, a missing file of the hub, of a prototype and of /_next/static, and an unknown hub folder", async ({ request }) => {
    const missing = [
      "/olematu-leht",
      "/ru/net-takoj",
      "/olematu.txt",
      "/guide/olematu.html",
      "/guide/thumbs/olematu.jpg",
      "/p/d/olematu.js",
      "/p/x/", // not a prototype: the middleware asks for /p/x/index.html
      "/guide/olematu/",
      "/_next/static/chunks/olematu.js",
      "/api/olematu",
    ];
    for (const path of missing) {
      for (const method of ["GET", "HEAD"]) {
        const label = `${method} ${path}`;
        const res = await request.fetch(path, { method, maxRedirects: 0, failOnStatusCode: false });
        expect(res.status(), label).toBe(404);
        expectSiteHeaders(res, label);
      }
    }
  });

  test("an unknown page gets the site's 404 page; a missing file of the hub never turns into a page of the hub", async ({ request }) => {
    expect(await (await request.get("/olematu-leht", { failOnStatusCode: false })).text()).toContain("Lehte ei leitud");
    // (a path outside the site's own pages gets Next.js's plain 404 page, which says noindex in its markup too)
    for (const path of ["/guide/olematu.html", "/guide/olematu/", "/p/x/"]) {
      const body = await (await request.get(path, { failOnStatusCode: false })).text();
      expect(body, path).not.toContain("disainisuunad");
      expect(body, path).not.toContain("<title>MS LAB");
    }
  });
});

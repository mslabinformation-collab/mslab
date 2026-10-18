import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { signPreview } from "@/lib/preview-cookie";
import { alwaysThrough, GATE_PAGES, gateDecision, gateOn, opensAsPage, prefersHtml, type GateEnv } from "@/lib/site-gate";
import { ROOT_FILES, ROOT_FOLDERS } from "@/lib/root-files";
import { routeSitePath } from "@/lib/site-routing";

// The coming-soon gate (hotfix 08.10): with SITE_GATE on, a visitor without the admins' preview cookie is answered with the
// coming-soon page, whatever the address; the admin area, the sign-in, the crons and webhooks, the newsletter's confirm and unsubscribe links and
// the static files always go through. A pure function of the request's path, method and cookie and of the two settings.

const SECRET = "preview-secret-for-tests-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const ON: GateEnv = { SITE_GATE: "1", PREVIEW_SECRET: SECRET };
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const decide = (path: string, env: GateEnv = ON, cookie?: string, method = "GET") => gateDecision({ path, method, cookie }, env, NOW);
const kind = async (path: string, env: GateEnv = ON, cookie?: string, method = "GET") => (await decide(path, env, cookie, method)).kind;

/** Addresses that must always be answered by the app itself, gate or not. */
const THROUGH = [
  "/admin",
  "/admin/",
  "/admin/login",
  "/admin/koolitused/3",
  "/admin/uudiskiri",
  "/api/auth/request",
  "/api/auth/verify",
  "/api/auth/logout",
  "/api/admin/preview",
  "/api/admin/upload",
  "/api/admin/subscribers.csv",
  "/api/admin/lesson-file",
  "/api/cron/sweep",
  "/api/bunny/webhook",
  "/api/payments/notify", // Montonio's webhook (phase 2b)
  "/maksa/AbC_d-0123456789012345678901234567890", // the mail's Maksa link (phase 2b)
  "/api/newsletter/confirm",
  "/api/newsletter/loobu", // the unsubscribe link of the welcome mail (one-step newsletter, 09.10)
  "/_next/static/chunks/main.js",
  "/_next/image",
  "/_next/webpack-hmr",
  "/media/img/a.jpg",
  "/media/x",
  "/favicon.ico",
  "/icon.svg",
  "/robots.txt",
  "/og.jpg",
  "/brand/logo.png",
  "/seed/kulmud-1.jpg",
  "/feedback.js",
];

/** Addresses that are gated: every page of the site, the account and its API, the review tools, anything unknown. */
const GATED = [
  "/",
  "/koolitused",
  "/koolitused/kulmude-lami",
  "/koolituskalender",
  "/ostukorv",
  "/kontakt",
  "/uudised/x",
  "/konto",
  "/konto/sisene",
  "/konto/kursus/x/12",
  "/konto/kursus/x/praktiline",
  "/konto/kursus/x/test",
  "/konto/protokoll",
  "/konto/tagasiside",
  "/ru",
  "/ru/",
  "/ru/koolitused",
  "/ru/konto/sisene",
  "/et",
  "/et/koolitused",
  "/tulekul",
  "/tulekul/et",
  "/tulekul/ru",
  "/et/tulekul",
  "/ru/tulekul",
  "/leidmata",
  "/api",
  "/api/",
  "/api/konto",
  "/api/konto/verify",
  "/api/konto/kursus/x/1/fail/2",
  "/api/konto/kursus/x/praktiline",
  "/api/konto/praktiline/foto/1",
  "/api/konto/kursus/x/test",
  "/api/konto/kursus/x/tunnistus", // the certificate (phase 3d)
  "/api/konto/tunnistus/1",
  "/api/konto/arve/1", // an invoice's PDF (invoices Task 6)
  "/api/konto/leping/1", // a contract's PDF (contracts Task 6)
  "/api/konto/leping-tekst/1", // the text „Kinnita leping" shows (contracts Task 6)
  "/api/konto/protokoll",
  "/api/konto/tagasiside",
  "/api/konto/tagasiside/peida",
  "/api/feedback",
  "/api/feedback/1",
  "/guide",
  "/guide/",
  "/guide/index.html",
  "/p/d/",
  "/p/d/index.html",
  // look-alikes of the addresses that go through: a path boundary or an exact file name, never a prefix
  "/administrator",
  "/admin.php",
  "/admins",
  "/media.php",
  "/api/authx",
  "/api/auth.php",
  "/api/admins",
  "/api/cronx/sweep",
  "/api/bunny",
  "/api/bunny/webhookx",
  "/api/bunny/other",
  // the webhook is one exact address: the return, the rest of /api/payments and look-alikes of the webhook stay gated (phase 2b)
  "/api/payments",
  "/api/payments/notify/",
  "/api/payments/notifyx",
  "/api/payments/notify/x",
  "/api/payments/return",
  "/api/payments/return/",
  "/api/payments/return/x",
  "/api/payments/returnx",
  // the result page the bank sends the payer back to is a page of the site (phase 2b): gated like the rest, in both languages. It is not /maksa
  "/makse",
  "/ru/makse",
  "/et/makse",
  "/makse/x",
  "/makse/..%2fkonto",
  // the pay page is one segment after /maksa: the bare path, anything deeper, look-alikes, a locale in front and an encoded way out stay gated (phase 2b)
  "/maksa",
  "/maksa/a/b",
  "/maksax/a",
  "/ru/maksa/a",
  "/maksa/..%2fkonto",
  "/api/newsletterx",
  "/_nextx/a",
  "/_next",
  "/favicon.ico.bak",
  "/favicon.icox",
  "/robots.txt/x",
  "/og.jpg.bak",
  "/brand",
  "/branding/x.png",
  "/seed",
  "/feedback.json",
  "/x/admin",
  "/ru/admin",
  "/et/admin",
  // encoded or dotted forms are never taken for the admin or the API (WHATWG URL parsing removes real dot segments first)
  "/%61dmin",
  "/admin/..%2fkonto",
  "/admin/%2e%2e/konto",
  "/admin/%2E%2E/konto",
  "/admin/../konto",
  "/admin/./x",
  "/admin\\..\\konto",
  "/admin%5c..%5ckonto",
  "/api/admin/..%2F..%2Fkonto",
  "//admin",
  "/media//x",
  "/wp-login.php",
  "/.env",
];

describe("gateOn: the SITE_GATE setting", () => {
  test("unset, blank or an explicit off: the site behaves as today", () => {
    for (const value of [undefined, "", "   ", "0", "false", "FALSE", "off", "Off", "no", " 0 "]) expect(gateOn(value), String(value)).toBe(false);
  });

  test("1 turns it on; so does any other value (a typo must not open the site)", () => {
    for (const value of ["1", " 1 ", "true", "TRUE", "on", "yes", "2", "gate"]) expect(gateOn(value), value).toBe(true);
  });
});

describe("gateDecision", () => {
  test("gate off: everything passes, whatever the cookie and the method", async () => {
    for (const env of [{}, { SITE_GATE: "" }, { SITE_GATE: "0" }, { SITE_GATE: undefined, PREVIEW_SECRET: SECRET }, { SITE_GATE: "off", PREVIEW_SECRET: "" }] as GateEnv[])
      for (const path of [...GATED, ...THROUGH]) expect(await kind(path, env), `${JSON.stringify(env)} ${path}`).toBe("pass");
  });

  test("gate on, no cookie: the always-through addresses pass", async () => {
    for (const path of THROUGH) expect(await kind(path), path).toBe("pass");
    for (const path of THROUGH) expect(alwaysThrough(path), path).toBe(true);
  });

  test("gate on, no cookie: everything else is gated, look-alikes and encoded forms included", async () => {
    for (const path of GATED) expect(await kind(path), path).toBe("gate");
    for (const path of GATED) expect(alwaysThrough(path), path).toBe(false);
  });

  test("the coming-soon page of the address's language: /ru… the Russian one, everything else the Estonian one", async () => {
    expect(GATE_PAGES).toEqual({ et: "/tulekul/et", ru: "/tulekul/ru" });
    for (const path of ["/ru", "/ru/", "/ru/koolitused", "/ru/konto/sisene", "/ru/tulekul", "/ru/x/y"]) expect(await decide(path), path).toMatchObject({ kind: "gate", page: "/tulekul/ru" });
    for (const path of ["/", "/koolitused", "/konto", "/et", "/et/koolitused", "/rus", "/ru-x", "/rux/y", "/x/ru", "/api/konto", "/guide/", "/RU"])
      expect(await decide(path), path).toMatchObject({ kind: "gate", page: "/tulekul/et" });
  });

  test("a gated API address called by a script is answered as JSON (no page); a gated page is the page", async () => {
    for (const path of ["/api", "/api/", "/api/konto", "/api/konto/verify", "/api/feedback", "/api/feedback/1", "/api/admins", "/api/bunny/other"])
      expect(await decide(path), path).toMatchObject({ kind: "gate", json: true });
    for (const path of ["/", "/konto", "/api-docs", "/apix", "/guide/", "/ru/api/x"]) expect(await decide(path), path).toMatchObject({ kind: "gate", json: false });
  });

  // A student's mailed login link (/api/konto/verify?…) opened in the browser must show the coming-soon page, not raw JSON.
  const asked = (path: string, method: string, headers: { fetchMode?: string | null; accept?: string | null }) => gateDecision({ path, method, cookie: undefined, ...headers }, ON, NOW);
  const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

  test("a gated API address opened as a page (GET or HEAD, a navigation or an Accept that prefers HTML) is the coming-soon page", async () => {
    for (const method of ["GET", "HEAD", "get"]) {
      expect(await asked("/api/konto/verify", method, { fetchMode: "navigate", accept: BROWSER_ACCEPT }), method).toEqual({ kind: "gate", page: "/tulekul/et", json: false });
      expect(await asked("/api/konto/verify", method, { fetchMode: "navigate" }), method).toMatchObject({ json: false });
      expect(await asked("/api/feedback", method, { accept: BROWSER_ACCEPT }), method).toMatchObject({ json: false }); // no Sec-Fetch-Mode (an older browser)
      expect(await asked("/api/konto/x", method, { accept: "text/html" }), method).toMatchObject({ json: false });
      expect(await asked("/api/konto/x", method, { accept: "application/json;q=0.5, text/html" }), method).toMatchObject({ json: false });
    }
  });

  test("the bank's way back and its result page stay gated (phase 2b): the payer's browser gets the coming-soon page, a script the 404 JSON; no method, query or look-alike opens them; an admin's preview cookie does", async () => {
    const BACK = ["/api/payments/return", "/makse", "/ru/makse"];
    // the payer arrives from the bank as a navigation; before the launch that is the coming-soon page of her language
    expect(await asked("/api/payments/return", "GET", { fetchMode: "navigate", accept: BROWSER_ACCEPT })).toEqual({ kind: "gate", page: "/tulekul/et", json: false });
    expect(await asked("/api/payments/return", "GET", { fetchMode: "cors", accept: "application/json" })).toEqual({ kind: "gate", page: "/tulekul/et", json: true });
    expect(await asked("/api/payments/return", "HEAD", { fetchMode: "navigate" })).toMatchObject({ kind: "gate", json: false });
    expect(await decide("/makse")).toEqual({ kind: "gate", page: "/tulekul/et", json: false });
    expect(await decide("/ru/makse")).toEqual({ kind: "gate", page: "/tulekul/ru", json: false });
    // they are not on the list of addresses that always go through (only the webhook and the mail's /maksa/<token> are), whatever the method
    for (const path of BACK) {
      expect(alwaysThrough(path), path).toBe(false);
      for (const method of METHODS) expect(await kind(path, ON, undefined, method), `${method} ${path}`).toBe("gate");
    }
    expect(alwaysThrough("/api/payments/notify")).toBe(true);
    // the cookie of a signed-in admin opens them, and nothing else does (a forged one, none)
    const cookie = await signPreview(SECRET, NOW);
    for (const path of BACK) expect(await kind(path, ON, cookie), path).toBe("pass");
    for (const path of BACK) expect(await kind(path, ON, "1"), path).toBe("gate");
  });

  test("a script's call (fetch, XHR: cors, same-origin, no-cors) or an Accept that prefers JSON keeps the 404 JSON; so does any other method", async () => {
    for (const fetchMode of ["cors", "same-origin", "no-cors", "websocket", null, undefined])
      for (const accept of ["*/*", "application/json", "application/json, text/plain, */*", null, undefined, ""])
        expect(await asked("/api/konto/me", "GET", { fetchMode, accept }), `${fetchMode} ${accept}`).toMatchObject({ kind: "gate", json: true });
    for (const accept of ["application/json, text/html", "text/html;q=0.5, application/json", "text/html;q=0", "application/json;q=1, text/html;q=1"])
      expect(await asked("/api/konto/me", "GET", { accept }), accept).toMatchObject({ json: true });
    // a form POSTed by navigation (or any write) is never turned into a page
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
      expect(await asked("/api/konto/request", method, { fetchMode: "navigate", accept: BROWSER_ACCEPT }), method).toMatchObject({ kind: "gate", json: true });
    // and the headers never open the gate
    expect(await asked("/api/konto/me", "GET", { fetchMode: "navigate", accept: BROWSER_ACCEPT })).toMatchObject({ kind: "gate" });
  });

  test("the coming-soon page's own server action (a POST with Next-Action) to the /api address it was opened at goes to the page too", async () => {
    // the newsletter form of the coming-soon page shown at /api/konto/verify?… posts its action to that same address
    expect(await gateDecision({ path: "/api/konto/verify", method: "POST", cookie: undefined, action: true, fetchMode: "cors", accept: "text/x-component" }, ON, NOW)).toEqual({ kind: "gate", page: "/tulekul/et", json: false });
    // not for another method, and never without the header
    for (const method of ["GET", "PUT", "DELETE"]) expect(await gateDecision({ path: "/api/konto/verify", method, cookie: undefined, action: true, accept: "text/x-component" }, ON, NOW), method).toMatchObject({ json: true });
    expect(await gateDecision({ path: "/api/konto/verify", method: "POST", cookie: undefined, action: false, accept: "text/x-component" }, ON, NOW)).toMatchObject({ json: true });
    // the gate itself stays shut
    expect(await gateDecision({ path: "/api/konto/me", method: "POST", cookie: undefined, action: true }, ON, NOW)).toMatchObject({ kind: "gate" });
  });

  test("Sec-Fetch-Mode comes first: 'navigate' is a page whatever Accept says; any other value is not a page whatever Accept says", () => {
    const page = (fetchMode: string | null | undefined, accept: string | null | undefined, method = "GET") => opensAsPage({ method, fetchMode, accept });
    for (const accept of ["*/*", "application/json", "text/plain", "", null, undefined, BROWSER_ACCEPT, "application/json, text/html"]) {
      expect(page("navigate", accept), `navigate ${accept}`).toBe(true);
      expect(page("Navigate", accept, "HEAD"), `Navigate ${accept}`).toBe(true);
      expect(page(" navigate ", accept), `" navigate " ${accept}`).toBe(true);
    }
    for (const fetchMode of ["cors", "no-cors", "same-origin", "websocket", "nested-navigate", "navigat", "x"])
      for (const accept of ["text/html", BROWSER_ACCEPT, "text/html, application/json", "*/*", null, undefined])
        expect(page(fetchMode, accept), `${fetchMode} ${accept}`).toBe(false);
    // only an absent header (or one with no value) falls back to Accept
    for (const fetchMode of [null, undefined, "", "  "]) {
      expect(page(fetchMode, "text/html"), `${JSON.stringify(fetchMode)} text/html`).toBe(true);
      expect(page(fetchMode, BROWSER_ACCEPT), `${JSON.stringify(fetchMode)} browser`).toBe(true);
      expect(page(fetchMode, "*/*"), `${JSON.stringify(fetchMode)} */*`).toBe(false);
      expect(page(fetchMode, "application/json, text/html"), `${JSON.stringify(fetchMode)} json first`).toBe(false);
      expect(page(fetchMode, null), `${JSON.stringify(fetchMode)} no Accept`).toBe(false);
    }
    // the method rules stay: a write is never a page, a server action (POST + Next-Action) is
    expect(opensAsPage({ method: "POST", fetchMode: "navigate", accept: BROWSER_ACCEPT })).toBe(false);
    expect(opensAsPage({ method: "POST", fetchMode: "cors", accept: "text/x-component", action: true })).toBe(true);
    expect(opensAsPage({ method: "PUT", fetchMode: "navigate", accept: "text/html" })).toBe(false);
  });

  test("a script that sends Accept: text/html with a fetch (Sec-Fetch-Mode: cors) still gets the 404 JSON; a navigation with Accept: */* gets the page", async () => {
    expect(await asked("/api/konto/me", "GET", { fetchMode: "cors", accept: "text/html" })).toMatchObject({ kind: "gate", json: true });
    expect(await asked("/api/konto/me", "GET", { fetchMode: "same-origin", accept: BROWSER_ACCEPT })).toMatchObject({ kind: "gate", json: true });
    expect(await asked("/api/konto/verify", "GET", { fetchMode: "navigate", accept: "*/*" })).toEqual({ kind: "gate", page: "/tulekul/et", json: false });
    expect(await asked("/api/konto/verify", "GET", { fetchMode: "navigate", accept: "application/json" })).toMatchObject({ json: false });
  });

  test("an Accept range with q=0 is 'not acceptable'; q=0.0 and q=0.000 too; a malformed q keeps the default of 1 (RFC 9110)", () => {
    for (const q of ["q=0", "q=0.0", "q=0.00", "q=0.000", "Q=0", "q=0.", "q=0 ", " q=0"]) {
      expect(prefersHtml(`text/html;${q}`), q).toBe(false); // the only HTML range is not acceptable
      expect(prefersHtml(`text/html;${q}, application/json`), q).toBe(false);
      expect(prefersHtml(`application/json;${q}, text/html`), q).toBe(true); // JSON is the one that is out
      expect(prefersHtml(`application/json;${q}, text/html;q=0.1`), q).toBe(true);
      expect(prefersHtml(`text/html;level=1;${q}`), q).toBe(false); // other parameters before it
    }
    // a small non-zero q is acceptable, only weighed against JSON
    for (const q of ["q=0.001", "q=0.1", "q=1", "q=1.0", "q=1.000"]) expect(prefersHtml(`text/html;${q}`), q).toBe(true);
    expect(prefersHtml("text/html;q=0.001, application/json;q=0.002")).toBe(false);
    // a malformed q is no q at all: the default of 1 (not 0, not a crash)
    for (const q of ["q=", "q=abc", "q=.", "q=..", "q=1.2.3", "q=1.5", "q=2", "q=0.1234", "q=-1", "q = 0", "q=1e-9", "q=00", "q=0x1"]) {
      expect(prefersHtml(`text/html;${q}`), q).toBe(true);
      expect(prefersHtml(`text/html;${q}, application/json`), q).toBe(true); // 1 against 1, HTML listed first
      expect(prefersHtml(`application/json, text/html;${q}`), q).toBe(false); // 1 against 1, JSON listed first
      expect(prefersHtml(`application/json;${q}, text/html;q=0.5`), q).toBe(false); // JSON at 1 beats HTML at 0.5
    }
  });

  test("the method never opens the gate (a server action is a POST to the page's own address) and never closes it", async () => {
    for (const method of METHODS) {
      for (const path of ["/", "/konto/sisene", "/ru/kontakt", "/api/konto/request", "/api/feedback"]) expect(await kind(path, ON, undefined, method), `${method} ${path}`).toBe("gate");
      for (const path of ["/admin/login", "/api/auth/logout", "/api/admin/upload", "/api/bunny/webhook", "/api/payments/notify", "/api/newsletter/confirm", "/api/newsletter/loobu", "/maksa/AbC_d-0123456789012345678901234567890"])
        expect(await kind(path, ON, undefined, method), `${method} ${path}`).toBe("pass");
    }
  });

  test("a valid preview cookie lets every address through, every method", async () => {
    const cookie = await signPreview(SECRET, NOW);
    for (const method of METHODS) for (const path of GATED) expect(await kind(path, ON, cookie, method), `${method} ${path}`).toBe("pass");
  });

  test("an expired, tampered, foreign or malformed cookie is no pass", async () => {
    const good = await signPreview(SECRET, NOW);
    const [exp, sig] = good.split(".");
    const expired = await signPreview(SECRET, NOW - 31 * 86_400_000);
    const foreign = await signPreview("another-secret-0123456789abcdef-x", NOW);
    for (const cookie of [expired, foreign, `${Number(exp) + 1}.${sig}`, `${exp}.${sig.slice(1)}A`, "", "1", "x.y", "true", "admin"])
      for (const path of ["/", "/konto", "/ru", "/api/konto"]) expect(await kind(path, ON, cookie), `${cookie} ${path}`).toBe("gate");
  });

  test("no PREVIEW_SECRET (unset, empty or blank) with the gate on: nobody passes, except the always-through addresses", async () => {
    const cookie = await signPreview(SECRET, NOW);
    for (const env of [{ SITE_GATE: "1" }, { SITE_GATE: "1", PREVIEW_SECRET: "" }, { SITE_GATE: "1", PREVIEW_SECRET: "   " }] as GateEnv[]) {
      for (const path of ["/", "/konto", "/ru/koolitused", "/api/konto"]) expect(await kind(path, env, cookie), `${JSON.stringify(env)} ${path}`).toBe("gate");
      for (const path of THROUGH) expect(await kind(path, env, cookie), `${JSON.stringify(env)} ${path}`).toBe("pass");
    }
  });

  test("the secret is read trimmed, as every other setting (a pasted value with a newline still works)", async () => {
    const cookie = await signPreview(SECRET, NOW);
    expect(await kind("/", { SITE_GATE: "1", PREVIEW_SECRET: ` ${SECRET}\n` }, cookie)).toBe("pass");
  });
});

describe("the coming-soon page itself", () => {
  test("is no page of the site: with the gate off (or for an admin) its addresses are the 404 page", () => {
    for (const path of ["/tulekul", "/tulekul/et", "/tulekul/ru", "/ru/tulekul"])
      expect(routeSitePath(path, new URLSearchParams()), path).toEqual({ kind: "page", page: path.startsWith("/ru") ? "/ru/leidmata" : "/et/leidmata", rewritten: true });
  });

  test("lives at app/tulekul/[locale] with a root layout of its own: no site shell, and nothing read from the settings or the database", () => {
    const dir = join(process.cwd(), "src/app/tulekul/[locale]");
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(["page.tsx", "layout.tsx"]));
    expect(readdirSync(join(process.cwd(), "src/app/tulekul"))).toEqual(["[locale]"]); // no layout above it: its own is the root layout
    const layout = readFileSync(join(dir, "layout.tsx"), "utf8");
    expect(layout).toMatch(/<html lang=\{locale\}/);
    // `next build` prerenders both languages, and the build must succeed with an empty environment (docs/deploy.md section 2):
    // the [locale] layout's link-preview tags read SITE_URL, so the page is not under it, and reads none of these itself
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(/@\/server\/|@\/db\/|share-meta|next\/headers|process\.env|connection\(/);
    }
  });
});

describe("one list of static files for the routing and the gate (lib/root-files.ts)", () => {
  const served = (path: string) => routeSitePath(path, new URLSearchParams()).kind === "other";

  test("every file of the list exists (public/, or app/icon.svg), and so does every folder: no entry for a file that is not there (og.png was one)", () => {
    expect(ROOT_FILES).not.toContain("og.png"); // the link preview is og.jpg only
    for (const name of ROOT_FILES) expect(existsSync(join(process.cwd(), name === "icon.svg" ? "src/app" : "public", name)), name).toBe(true);
    for (const folder of ROOT_FOLDERS) expect(existsSync(join(process.cwd(), "public", folder)), folder).toBe(true);
  });

  test("every file and folder of the list is served as it is AND goes through the gate", () => {
    for (const name of ROOT_FILES) {
      expect(served(`/${name}`), name).toBe(true);
      expect(alwaysThrough(`/${name}`), name).toBe(true);
    }
    for (const folder of ROOT_FOLDERS) {
      expect(served(`/${folder}/x.png`), folder).toBe(true);
      expect(alwaysThrough(`/${folder}/x.png`), folder).toBe(true);
    }
  });

  test("their look-alikes are neither: the routing's 404 page, and gated", () => {
    const lookAlikes = [
      ...ROOT_FILES.flatMap((name) => [`/${name}.bak`, `/${name}x`, `/x${name}`, `/${name}/x`, `/ru/${name}`, `/x/${name}`]),
      ...ROOT_FOLDERS.flatMap((folder) => [`/${folder}`, `/${folder}x/a.png`, `/x/${folder}/a.png`]),
      "/og.gif",
      "/og.png", // no such file: the 404 page, and gated
      "/ogXjpg",
      "/favicon.ico.php",
    ];
    for (const path of lookAlikes) {
      expect(served(path), path).toBe(false);
      expect(alwaysThrough(path), path).toBe(false);
    }
  });
});

describe("every static file of public/ goes through (the design-review hub excepted)", () => {
  test("each top-level file and folder of public/", () => {
    const hub = new Set(["guide", "p"]);
    const entries = readdirSync(join(process.cwd(), "public"), { withFileTypes: true }).filter((e) => !hub.has(e.name));
    expect(entries.length).toBeGreaterThan(3);
    for (const e of entries) {
      if (e.isDirectory()) {
        for (const file of readdirSync(join(process.cwd(), "public", e.name)).slice(0, 5)) expect(alwaysThrough(`/${e.name}/${file}`), `/${e.name}/${file}`).toBe(true);
      } else expect(alwaysThrough(`/${e.name}`), `/${e.name}`).toBe(true);
    }
    for (const name of hub) expect(alwaysThrough(`/${name}/`), name).toBe(false);
  });
});

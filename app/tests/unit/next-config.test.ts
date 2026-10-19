import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MEDIA_CSP } from "@/server/media";

// next.config.ts headers(): the headers every answer carries (pages, API, /media, the static files of public/), and the
// stricter ones of single routes. A header given there replaces the route's own, and the later rule for the same path
// and header wins, so those come after the rule for every path. The e2e headers spec checks the answers themselves.

type Rule = { source: string; headers: { key: string; value: string }[] };

async function config(env: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  return (await import("../../next.config")).default;
}

afterEach(() => vi.unstubAllEnvs());

/** The value `path`'s answer gets for `key` from the rules (the last matching rule wins; simple sources only). */
function valueFor(rules: Rule[], path: string, key: string): string | undefined {
  const matches = (source: string) => {
    if (source.endsWith("/:path*")) return path === source.slice(0, -7) || path.startsWith(source.slice(0, -6));
    if (!source.includes("/:")) return path === source;
    // a source with named segments (/:slug/…): each names exactly one non-empty segment of the path
    const want = source.split("/");
    const got = path.split("/");
    return want.length === got.length && want.every((segment, i) => (segment.startsWith(":") ? got[i] !== "" : segment === got[i]));
  };
  let value: string | undefined;
  for (const rule of rules) if (matches(rule.source)) for (const h of rule.headers) if (h.key.toLowerCase() === key.toLowerCase()) value = h.value;
  return value;
}

describe("next.config.ts headers()", () => {
  test("every answer: noindex, framing by this site only, the origin only as referrer", async () => {
    const rules = (await (await config()).headers!()) as Rule[];
    expect(rules[0]).toEqual({
      source: "/:path*",
      headers: [
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    });
    for (const path of ["/", "/koolitused", "/guide/", "/p/d/styles.css", "/robots.txt", "/_next/static/chunks/x.js", "/api/feedback"]) {
      expect(valueFor(rules, path, "x-robots-tag"), path).toBe("noindex, nofollow");
      expect(valueFor(rules, path, "content-security-policy"), path).toBe("frame-ancestors 'self'");
      expect(valueFor(rules, path, "referrer-policy"), path).toBe("strict-origin-when-cross-origin");
    }
  });

  test("routes with stricter values keep them: /media's sandbox CSP, the login link's no-referrer; admin and login never cached", async () => {
    const rules = (await (await config()).headers!()) as Rule[];
    expect(valueFor(rules, "/media/img/x.jpg", "content-security-policy")).toBe(MEDIA_CSP);
    expect(valueFor(rules, "/media/img/x.jpg", "x-robots-tag")).toBe("noindex, nofollow");
    expect(valueFor(rules, "/api/auth/verify", "referrer-policy")).toBe("no-referrer");
    expect(valueFor(rules, "/api/auth/request", "referrer-policy")).toBe("strict-origin-when-cross-origin");
    for (const path of ["/admin", "/admin/koolitused", "/api/auth/verify", "/api/admin/upload"]) expect(valueFor(rules, path, "cache-control"), path).toBe("no-store");
    expect(valueFor(rules, "/koolitused", "cache-control")).toBeUndefined(); // Next.js's own for the cached pages
  });

  test("the client account's API is private and never cached; its login link sends no Referer (the token is in the address)", async () => {
    const rules = (await (await config()).headers!()) as Rule[];
    for (const path of ["/api/konto", "/api/konto/me", "/api/konto/login", "/api/konto/verify", "/api/konto/kursus/some-course"])
      expect(valueFor(rules, path, "cache-control"), path).toBe("private, no-store");
    expect(valueFor(rules, "/api/konto/verify", "referrer-policy")).toBe("no-referrer");
    for (const path of ["/api/konto", "/api/konto/me", "/api/konto/login", "/api/konto/code"])
      expect(valueFor(rules, path, "referrer-policy"), path).toBe("strict-origin-when-cross-origin");
    for (const path of ["/api/konto/verify", "/api/konto/me"]) expect(valueFor(rules, path, "x-robots-tag"), path).toBe("noindex, nofollow");
    expect(valueFor(rules, "/konto", "cache-control")).toBeUndefined(); // the static shell pages keep the CDN's caching
  });

  test("Maria's invoice downloads are private and never kept: the PDF, the month's CSV and the sample (the admin rule's plain no-store would replace the route's own header); the rest of /api/admin keeps no-store (invoices Task 5)", async () => {
    const rules = (await (await config()).headers!()) as Rule[];
    for (const path of ["/api/admin/arve/12", "/api/admin/arved", "/api/admin/naidisarve"]) {
      expect(valueFor(rules, path, "cache-control"), path).toBe("private, no-store");
      expect(valueFor(rules, path, "x-robots-tag"), path).toBe("noindex, nofollow");
    }
    for (const path of ["/api/admin/upload", "/api/admin/subscribers.csv", "/api/admin/arve", "/api/admin/arve/12/x", "/api/admin/arvedx"]) expect(valueFor(rules, path, "cache-control"), path).toBe("no-store");
  });

  test("Maria's contract downloads are private and never kept, as the invoices': the PDF by its id and Seaded's sample; no other path under /api/admin/leping or /api/admin/naidisleping is (contracts Task 5)", async () => {
    const rules = (await (await config()).headers!()) as Rule[];
    for (const path of ["/api/admin/leping/12", "/api/admin/naidisleping"]) {
      expect(valueFor(rules, path, "cache-control"), path).toBe("private, no-store");
      expect(valueFor(rules, path, "x-robots-tag"), path).toBe("noindex, nofollow");
      expect(valueFor(rules, path, "content-security-policy"), path).toBe("frame-ancestors 'self'");
    }
    for (const path of ["/api/admin/leping", "/api/admin/leping/12/x", "/api/admin/lepingud", "/api/admin/naidisleping/x", "/api/admin/naidislepingx"]) expect(valueFor(rules, path, "cache-control"), path).toBe("no-store");
  });

  test("the unsubscribe page's POST keeps its Origin: the loobu route is same-origin, never no-referrer (a strict policy makes the form post Origin: null, which is refused as cross-site)", async () => {
    const rules = (await (await config()).headers!()) as Rule[];
    expect(valueFor(rules, "/api/newsletter/loobu", "referrer-policy")).toBe("same-origin");
    expect(valueFor(rules, "/api/newsletter/loobu", "referrer-policy")).not.toBe("no-referrer");
    expect(valueFor(rules, "/api/newsletter/loobu", "x-robots-tag")).toBe("noindex, nofollow"); // the route sets none of its own
    // nothing else is changed: the old confirm link and the other newsletter paths keep the global value
    for (const path of ["/api/newsletter/confirm", "/api/newsletter", "/api/newsletter/loobux"]) expect(valueFor(rules, path, "referrer-policy"), path).toBe("strict-origin-when-cross-origin");
  });

  test("a lesson file's redirect sends no Referer to R2 (the global rule would replace the route's own header); the other lesson routes keep the global value", async () => {
    const rules = (await (await config()).headers!()) as Rule[];
    const file = "/api/konto/kursus/kulmumeistri-e-koolitus/12/fail/juhend.pdf";
    expect(valueFor(rules, file, "referrer-policy")).toBe("no-referrer");
    expect(valueFor(rules, file, "cache-control")).toBe("private, no-store");
    expect(valueFor(rules, file, "x-robots-tag")).toBe("noindex, nofollow");
    for (const path of [
      "/api/konto/kursus/kulmumeistri-e-koolitus",
      "/api/konto/kursus/kulmumeistri-e-koolitus/12",
      "/api/konto/kursus/kulmumeistri-e-koolitus/12/progress",
      "/api/konto/kursus/kulmumeistri-e-koolitus/12/tehtud",
      "/api/konto/kursus/kulmumeistri-e-koolitus/12/fail",
      "/api/konto/kursus/kulmumeistri-e-koolitus/12/fail/juhend.pdf/extra",
    ])
      expect(valueFor(rules, path, "referrer-policy"), path).toBe("strict-origin-when-cross-origin");
  });

  test("a practical photo's redirect sends no Referer to R2, the photo and its thumbnail; the practical work's other paths keep the global value (e-course completion, R5)", async () => {
    const rules = (await (await config()).headers!()) as Rule[];
    for (const path of ["/api/konto/praktiline/foto/12", "/api/konto/praktiline/foto/12/pisi"]) {
      expect(valueFor(rules, path, "referrer-policy"), path).toBe("no-referrer");
      expect(valueFor(rules, path, "cache-control"), path).toBe("private, no-store");
      expect(valueFor(rules, path, "x-robots-tag"), path).toBe("noindex, nofollow");
    }
    // the upload's POST and the page's own reads keep the site's value (a POST from the page must keep its Origin)
    for (const path of ["/api/konto/kursus/veebikursus/praktiline", "/api/konto/kursus/veebikursus/praktiline/foto", "/api/konto/kursus/veebikursus/praktiline/saada", "/api/konto/praktiline"])
      expect(valueFor(rules, path, "referrer-policy"), path).toBe("strict-origin-when-cross-origin");
  });

  test("the pay page's button POST keeps its Origin: /maksa/<token> is same-origin, never no-referrer; nothing else changes (phase 2b)", async () => {
    const rules = (await (await config()).headers!()) as Rule[];
    expect(valueFor(rules, "/maksa/abc", "referrer-policy")).toBe("same-origin");
    expect(valueFor(rules, "/maksa/abc", "cache-control")).toBe("no-store");
    expect(valueFor(rules, "/maksa/abc", "x-robots-tag")).toBe("noindex, nofollow");
    for (const path of ["/maksa", "/maksa/abc/x", "/makse"]) expect(valueFor(rules, path, "referrer-policy"), path).toBe("strict-origin-when-cross-origin");
    // the bank's way back: the signed order token is in the address, so it is never sent on as a Referer, and the answer is never cached
    expect(valueFor(rules, "/api/payments/return", "referrer-policy")).toBe("no-referrer");
    expect(valueFor(rules, "/api/payments/return", "cache-control")).toBe("no-store");
    expect(valueFor(rules, "/api/payments/return", "x-robots-tag")).toBe("noindex, nofollow");
    // ...and nothing else around it: the webhook, the rest of /api/payments and the result page keep the site's defaults
    for (const path of ["/api/payments/notify", "/api/payments", "/api/payments/returnx", "/api/payments/return/x", "/makse", "/ru/makse"]) {
      expect(valueFor(rules, path, "referrer-policy"), path).toBe("strict-origin-when-cross-origin");
      expect(valueFor(rules, path, "cache-control"), path).toBeUndefined();
    }
  });

  test("the e2e page cache only when the e2e run's production build asks for it (E2E_PAGE_CACHE)", async () => {
    expect((await config({ E2E_PAGE_CACHE: undefined, VERCEL: undefined })).cacheHandler).toBeUndefined();
    expect((await config({ E2E_PAGE_CACHE: "/tmp/stale", VERCEL: undefined })).cacheHandler).toMatch(/tests[\\/]e2e[\\/]page-cache\.cjs$/);
  });

  test("...and never in a Vercel build: VERCEL set switches it off whatever E2E_PAGE_CACHE says", async () => {
    for (const vercel of ["1", "production"]) {
      const cfg = await config({ E2E_PAGE_CACHE: "/tmp/stale", VERCEL: vercel });
      expect(cfg.cacheHandler, `VERCEL=${vercel}`).toBeUndefined();
      expect(Object.keys(cfg), `VERCEL=${vercel}`).not.toContain("cacheHandler");
    }
    // VERCEL set to nothing is not a Vercel build
    expect((await config({ E2E_PAGE_CACHE: "/tmp/stale", VERCEL: "" })).cacheHandler).toMatch(/page-cache\.cjs$/);
  });
});

describe("next.config.ts outputFileTracingIncludes (the certificate, phase 3d; the invoices, phase 4; the contracts, phase 4)", () => {
  // The PDFs are drawn in the functions that serve them, from fonts read with fs (server/certificate-pdf.ts, server/invoice-pdf.ts,
  // server/contract-pdf.ts), so the folder goes with each of them. The keys are globs matched against each route's name. Turbopack (Next
  // 16.3.8, `next build`'s bundler) matches "/api/konto/**", but neither the literal "/api/konto/[[...path]]" nor a backslash-escaped one:
  // checked with a build on 15.10.2026. A bracketed folder is "*" in a key: a build on 17.10.2026 (a marker file per candidate key, looked
  // for in the course page's .nft.json) reached the page's function with "/*/koolitused/**", and with neither "/[locale]/koolitused/[slug]"
  // nor "/[[]locale]/koolitused/**" nor the backslash-escaped form.
  const FONTS = ["./assets/fonts/**"];

  test("the fonts go with the two functions that render the certificate, named by their folders", async () => {
    const include = (await config()).outputFileTracingIncludes!;
    for (const key of ["/api/konto/**", "/api/admin/tunnistus/**"]) expect(include[key], key).toEqual(FONTS);
  });

  test("...and with every function that renders an invoice: Maria's download and the sample, the payment routes, the cron and the admin pages", async () => {
    const include = (await config()).outputFileTracingIncludes!;
    for (const key of ["/api/admin/arve/**", "/api/admin/naidisarve/**", "/api/payments/**", "/api/cron/**", "/admin/**"]) expect(include[key], key).toEqual(FONTS);
  });

  test("...and with Maria's two contract routes, named by their folders and not by the bracketed route (contracts Task 5): the download and Seaded's sample", async () => {
    const include = (await config()).outputFileTracingIncludes!;
    for (const key of ["/api/admin/leping/**", "/api/admin/naidisleping/**"]) expect(include[key], key).toEqual(FONTS);
    expect(Object.keys(include)).not.toContain("/api/admin/leping/[id]");
  });

  test("...and with the public course page's function, where the registration form's action runs and mails the contract's PDF: the key has no brackets, \"*\" stands for the locale's folder (contracts, Task 2)", async () => {
    const include = (await config()).outputFileTracingIncludes!;
    expect(include["/*/koolitused/**"]).toEqual(FONTS);
    // the literal route and its bracket-escaped forms trace nothing under Turbopack (the build's marker check): none of them is the key
    for (const key of Object.keys(include)) expect(key, key).not.toMatch(/\[|\\/);
  });

  test("nothing else is traced with the fonts: exactly these ten keys, each a route's folder and /** (a bracketed folder is *)", async () => {
    const include = (await config()).outputFileTracingIncludes!;
    expect(Object.keys(include).sort()).toEqual(
      [
        "/*/koolitused/**", "/admin/**", "/api/admin/arve/**", "/api/admin/leping/**", "/api/admin/naidisarve/**", "/api/admin/naidisleping/**", "/api/admin/tunnistus/**",
        "/api/cron/**", "/api/konto/**", "/api/payments/**",
      ].sort(),
    );
    for (const [key, files] of Object.entries(include)) {
      expect(key, key).toMatch(/^\/[a-z*/]+\/\*\*$/);
      expect(files, key).toEqual(FONTS);
    }
  });
});

describe("next.config.ts env (the test page, phase 4)", () => {
  // The build's instant is what a "markedAt": "deploy" of the test plan reads as when tools/testplan-stamp.mjs was skipped (spec §6). The
  // server reads it as process.env.TESTPLAN_BUILD_AT, inlined when the config is loaded for the build.
  test("TESTPLAN_BUILD_AT is the moment the config was loaded, as an ISO instant", async () => {
    const before = Date.now();
    const at = (await config()).env?.TESTPLAN_BUILD_AT;
    expect(typeof at).toBe("string");
    expect(Number.isNaN(Date.parse(at!))).toBe(false);
    expect(new Date(at!).toISOString()).toBe(at); // exactly the form the answers' instants have, so they compare as instants
    expect(Date.parse(at!)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(at!)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("the review tools' flag is still there beside it", async () => {
    expect((await config()).env?.NEXT_PUBLIC_REVIEW_TOOLS).toBe("1");
  });
});

describe("next.config.ts's import chain uses no \"@/…\" path", () => {
  // Next does give its config loader the tsconfig paths, but an alias comes out relative to the project root and Node resolves it from the importing file:
  // an "@/…" import in a file below next.config.ts makes `next dev` and `next build` stop with "Cannot find module" (it happened once: server/media.ts,
  // imported for MEDIA_CSP, took its key rule from "@/lib/media"). vitest resolves the paths itself, so no other test notices. The rule is stricter than
  // it has to be (an "@/…" import written in next.config.ts itself would resolve), which keeps it simple. A type-only import is erased and may use them.
  test("nothing next.config.ts imports, however deep, is imported by an \"@/…\" path", () => {
    const root = process.cwd();
    const seen = new Set<string>();
    const aliased: string[] = [];
    const resolveFile = (from: string, spec: string): string | null => {
      const base = join(dirname(from), spec);
      return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((p) => existsSync(p) && /\.tsx?$/.test(p)) ?? null;
    };
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g)) {
        if (m[1]) continue; // type-only
        const spec = m[2];
        if (spec.startsWith("@/")) aliased.push(`${file.slice(root.length + 1)} imports ${spec}`);
        else if (spec.startsWith(".")) {
          const next = resolveFile(file, spec);
          if (next) visit(next);
        }
      }
    };
    visit(join(root, "next.config.ts"));
    expect(seen.size).toBeGreaterThan(1); // (next.config.ts does import the media rules: the walk is not vacuous)
    expect(aliased).toEqual([]);
  });
});

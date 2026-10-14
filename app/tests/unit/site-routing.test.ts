import { describe, expect, test } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { accountShellTarget, isKnownPage, routeSitePath } from "@/lib/site-routing";

// lib/site-routing.ts: the middleware's decisions as plain functions. The middleware applies them to each request
// (tests/unit/middleware.test.ts checks the middleware's answers themselves).

const route = (url: string) => {
  const u = new URL(url, "https://mslab.example");
  return routeSitePath(u.pathname, u.searchParams);
};

describe("routeSitePath", () => {
  test("public pages: ET under /et (rewritten), RU as they are, the cart of one course its own page", () => {
    expect(route("/")).toEqual({ kind: "page", page: "/et", rewritten: true });
    expect(route("/koolitused/x?sessioon=3")).toEqual({ kind: "page", page: "/et/koolitused/x", rewritten: true });
    expect(route("/ru")).toEqual({ kind: "page", page: "/ru", rewritten: false });
    expect(route("/ru/praktika?pakett=MAXI")).toEqual({ kind: "page", page: "/ru/praktika", rewritten: false });
    expect(route("/ostukorv?kursus=x")).toEqual({ kind: "page", page: "/et/ostukorv/x", rewritten: true });
    expect(route("/ru/ostukorv?kursus=x")).toEqual({ kind: "page", page: "/ru/ostukorv/x", rewritten: true });
    // the page the bank sends the payer back to (phase 2b): a static page of its own; its result is in the fragment, which no server sees
    expect(route("/makse")).toEqual({ kind: "page", page: "/et/makse", rewritten: true });
    expect(route("/ru/makse")).toEqual({ kind: "page", page: "/ru/makse", rewritten: false });
    // an address without a page of its own: its locale's one 404 page (round 2 item 21)
    expect(route("/olematu")).toEqual({ kind: "page", page: "/et/leidmata", rewritten: true });
    expect(route("/ru/olematu")).toEqual({ kind: "page", page: "/ru/leidmata", rewritten: true });
  });

  test("the known pages are exactly the pages of app/[locale]/(site) (round 2 item 21)", () => {
    const root = join(process.cwd(), "src/app/[locale]/(site)");
    const pages: string[] = [];
    const walk = (dir: string, path: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name), `${path}/${e.name}`);
        else if (e.name === "page.tsx") pages.push(path);
      }
    };
    walk(root, "");
    expect(pages.sort()).toEqual(
      ["", "/[...rest]", "/kontakt", "/konto", "/konto/andmed", "/konto/kursus/[slug]", "/konto/kursus/[slug]/[lesson]", "/konto/kursus/[slug]/praktiline", "/konto/kursus/[slug]/test", "/konto/lemmikud", "/konto/protokoll", "/konto/sisene", "/konto/tagasiside", "/koolitaja", "/koolitused", "/koolitused/[slug]", "/koolituskalender", "/makse", "/ostukorv", "/ostukorv/[kursus]", "/praktika", "/privaatsus", "/tingimused", "/uudised", "/uudised/[slug]"].sort(),
    );
    for (const p of pages.filter((x) => !x.includes("["))) expect(isKnownPage(`/et${p}`), p).toBe(true);
    for (const p of ["/koolitused/x", "/uudised/y-2", "/ostukorv/whatever"]) expect(isKnownPage(`/ru${p}`), p).toBe(true);
    for (const p of ["/et/leidmata", "/et/koolitused/x/y", "/ru/kontakt/x", "/et/KONTAKT", "/etude", "/et/uudised/Y"]) expect(isKnownPage(p), p).toBe(false);
  });

  test("the client account's pages are known, in both locales; nothing deeper is (phase 2a Task 5)", () => {
    for (const locale of ["et", "ru"])
      for (const p of ["/konto", "/konto/sisene", "/konto/lemmikud", "/konto/andmed", "/konto/protokoll", "/konto/tagasiside", "/konto/kursus/kulmude-lami", "/konto/kursus/e-koolitus-2", "/konto/kursus/kulmude-lami/12", "/konto/kursus/kulmude-lami/test", "/konto/kursus/kulmude-lami/praktiline"])
        expect(isKnownPage(`/${locale}${p}`), `/${locale}${p}`).toBe(true);
    for (const p of [
      "/et/konto/x/y", "/et/konto/x", "/et/konto/kursus", "/et/konto/kursus/A", "/et/konto/kursus/x/y", "/ru/konto/sisene/x", "/et/konto/lemmikud/x", "/et/konto/protokoll/5", "/et/konto/tagasiside/5",
      // a lesson's id is parseRowId's (lib/row-id.ts): digits, no leading zero, at most 2 147 483 647; nothing below a lesson
      "/et/konto/kursus/x/0", "/et/konto/kursus/x/012", "/et/konto/kursus/x/12/y", "/et/konto/kursus/X/12", "/et/konto/kursus/x/2147483648",
      "/et/konto/kursus/x/-1", "/et/konto/kursus/x/1e3", "/et/konto/kursus/x/12345678901", "/et/konto/kursus/x/12/",
      // the course's completion steps (e-course completion): test and praktiline, exactly, under a slug of ours; nothing below them
      "/et/konto/kursus/x/tests", "/et/konto/kursus/x/Test", "/et/konto/kursus/x/praktika", "/et/konto/kursus/x/test/1", "/et/konto/kursus/x/praktiline/foto",
      "/et/konto/kursus/X/test", "/et/konto/kursus/-x/test", `/et/konto/kursus/${"a".repeat(81)}/praktiline`, "/et/konto/kursus/x/test/",
    ])
      expect(isKnownPage(p), p).toBe(false);
    expect(isKnownPage("/et/konto/kursus/x/2147483647")).toBe(true);
    expect(isKnownPage(`/ru/konto/kursus/${"a".repeat(80)}/test`)).toBe(true);
    // a step's shell with a query: the same 303 into the fragment
    expect(route("/konto/kursus/kulmude-lami/test?viga=1")).toEqual({ kind: "shellRedirect", location: "/konto/kursus/kulmude-lami/test#viga=1" });
    expect(route("/konto/kursus/kulmude-lami/test")).toEqual({ kind: "page", page: "/et/konto/kursus/kulmude-lami/test", rewritten: true });
    // the slug as lib/slug.ts isSlug reads it: at most 80 characters, single dashes between letters and digits
    expect(isKnownPage(`/et/konto/kursus/${"a".repeat(80)}/12`)).toBe(true);
    expect(isKnownPage(`/et/konto/kursus/${"a".repeat(81)}/12`)).toBe(false);
    for (const slug of ["-x", "x-", "x--y", "x_y", "x%20y", "õ"]) expect(isKnownPage(`/et/konto/kursus/${slug}/12`), slug).toBe(false);
    // a lesson's shell with a query: the same 303 into the fragment
    expect(route("/konto/kursus/kulmude-lami/12?viga=1")).toEqual({ kind: "shellRedirect", location: "/konto/kursus/kulmude-lami/12#viga=1" });
    expect(route("/ru/konto/kursus/kulmude-lami/12")).toEqual({ kind: "page", page: "/ru/konto/kursus/kulmude-lami/12", rewritten: false });
    expect(route("/konto/kursus/kulmude-lami/12")).toEqual({ kind: "page", page: "/et/konto/kursus/kulmude-lami/12", rewritten: true });
    // an id the database cannot hold is the 404 page, also with a query (no redirect to an unknown page)
    expect(route("/konto/kursus/kulmude-lami/2147483648?viga=1")).toEqual({ kind: "page", page: "/et/leidmata", rewritten: true });
    // a shell asked for with a query is not rendered: a redirect to the same path with the known parameters in the fragment
    expect(route("/konto/sisene?viga=link")).toEqual({ kind: "shellRedirect", location: "/konto/sisene#viga=link" });
    expect(route("/ru/konto/sisene?korda=1")).toEqual({ kind: "shellRedirect", location: "/ru/konto/sisene#korda=1" });
    expect(route("/konto/kursus/kulmude-lami?x=1")).toEqual({ kind: "shellRedirect", location: "/konto/kursus/kulmude-lami" });
    expect(route("/konto/kursus/kulmude-lami")).toEqual({ kind: "page", page: "/et/konto/kursus/kulmude-lami", rewritten: true });
    expect(route("/ru/konto/sisene")).toEqual({ kind: "page", page: "/ru/konto/sisene", rewritten: false });
  });

  test("only the account's shells answer a query with a redirect: not the public pages, the cart, an unknown address under /konto", () => {
    for (const p of ["/konto", "/ru/konto", "/konto/sisene", "/ru/konto/sisene", "/konto/lemmikud", "/konto/andmed", "/konto/kursus/x", "/ru/konto/kursus/x", "/konto/kursus/x/1", "/ru/konto/kursus/x/1", "/konto/kursus/x/test", "/konto/kursus/x/praktiline", "/ru/konto/kursus/x/praktiline"]) expect(route(p + "?a=1"), p).toMatchObject({ kind: "shellRedirect" });
    for (const p of ["/", "/ru", "/koolitused", "/koolitused/x?sessioon=1", "/kontakt", "/ru/kontakt", "/makse", "/ru/makse", "/ostukorv?kursus=x", "/konto/x/y", "/konto/kursus", "/kontoo", "/konto/kursus/x/0", "/konto/kursus/x/1/y"])
      expect(route(p.includes("?") ? p : p + "?a=1"), p).not.toMatchObject({ kind: "shellRedirect" });
  });

  test("accountShellTarget: the parameters the page knows move into the fragment, in a fixed order, URL-encoded; the rest is dropped", () => {
    const target = (path: string, query: string) => accountShellTarget(path, new URLSearchParams(query));
    expect(target("/konto/sisene", "email=a%40example.test&viga=link&korda=1")).toBe("/konto/sisene#viga=link&korda=1&email=a%40example.test");
    // an old or mangled ?kood=1 link (the e-mail's own link has it in the fragment already) still works
    expect(target("/konto/sisene", "kood=1&email=a%2Bb%40example.test")).toBe("/konto/sisene#email=a%2Bb%40example.test&kood=1");
    expect(target("/ru/konto/sisene", "kood=1&email=a%40example.test")).toBe("/ru/konto/sisene#email=a%40example.test&kood=1");
    expect(target("/ru/konto", "")).toBe("/ru/konto");
    expect(target("/ru/konto", "utm=1&_rsc=x")).toBe("/ru/konto");
    expect(target("/konto/sisene", "viga=link&viga=server")).toBe("/konto/sisene#viga=link");
    expect(target("/konto/sisene", "email=" + "a".repeat(255))).toBe("/konto/sisene");
    expect(target("/konto/sisene", "viga=%23%26%3D x")).toBe("/konto/sisene#viga=%23%26%3D+x");
    // the protocol's page (phase protocols): its registration moves into the fragment, after the others
    expect(target("/konto/protokoll", "id=42")).toBe("/konto/protokoll#id=42");
    expect(target("/ru/konto/protokoll", "utm=1&id=42")).toBe("/ru/konto/protokoll#id=42");
    expect(route("/konto/protokoll?id=42")).toEqual({ kind: "shellRedirect", location: "/konto/protokoll#id=42" });
    // and the feedback form's (phase protocols, Task 8)
    expect(target("/konto/tagasiside", "id=42")).toBe("/konto/tagasiside#id=42");
    expect(target("/ru/konto/tagasiside", "utm=1&id=42")).toBe("/ru/konto/tagasiside#id=42");
  });

  test("redirects, the hub, the API and everything served as it is", () => {
    expect(route("/koolitused/")).toEqual({ kind: "redirect", path: "/koolitused" });
    expect(route("/et/koolitused")).toEqual({ kind: "redirect", path: "/koolitused" });
    // (a path, not a URL: new URL("//evil.example", base) would read evil.example as the host)
    expect(routeSitePath("//evil.example", new URLSearchParams())).toEqual({ kind: "redirect", path: "/evil.example" });
    expect(route("/guide/")).toEqual({ kind: "hub" });
    expect(route("/api/feedback")).toEqual({ kind: "api" });
    // Montonio's webhook is answered at its own path, with or without a trailing slash: a POST is never redirected (phase 2b, spec 10)
    for (const p of ["/api/payments/notify", "/api/payments/notify/"]) expect(route(p), p).toEqual({ kind: "api" });
    for (const p of ["/admin", "/admin/koolitused", "/media/img/a.jpg", "/_next/static/x.js", "/robots.txt", "/seed/a.jpg", "/og.jpg", "/favicon.ico", "/icon.svg"]) expect(route(p), p).toEqual({ kind: "other" });
    expect(route("/maksa/AbC_d-0123456789012345678901234567890")).toEqual({ kind: "other" }); // the pay page (phase 2b): a route handler, served as it is
  });

  test("names that only begin like admin, media or a static file are unknown addresses: the cached 404 page (final review M1)", () => {
    for (const p of ["/admin.php", "/administrator", "/adminer.php", "/media.php", "/mediakit", "/_nextx", "/favicon.png", "/favicon.ico.bak", "/icon.svgz", "/robots.txt.bak", "/maksa", "/maksax/a", "/maksa/a/b"])
      expect(route(p), p).toEqual({ kind: "page", page: "/et/leidmata", rewritten: true });
    expect(route("/ru/admin.php")).toEqual({ kind: "page", page: "/ru/leidmata", rewritten: true });
  });
});

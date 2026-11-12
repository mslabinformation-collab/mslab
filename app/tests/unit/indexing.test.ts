import { describe, expect, test } from "vitest";
import { indexableHost, indexingOn, NOINDEX, PRIVATE_HEADER_SOURCES } from "@/lib/indexing";

// SEO G1: one decision whether search engines may index the site: the gate is off AND this is Vercel's production environment.
// Every other machine (local, the e2e run, previews) and the gated site say noindex, exactly as before.

describe("indexingOn", () => {
  test("only an off gate on Vercel production is indexable", () => {
    for (const gate of [undefined, "1"]) {
      for (const vercel of ["production", "preview", "development", undefined]) {
        const want = gate === undefined && vercel === "production";
        expect(indexingOn({ SITE_GATE: gate, VERCEL_ENV: vercel }), `gate=${gate} VERCEL_ENV=${vercel}`).toBe(want);
      }
    }
  });

  test("an explicit off of the gate counts as off (gateOn's rules); a blank or odd value keeps it on", () => {
    for (const gate of ["off", "0", "false", "no", "", "  "]) expect(indexingOn({ SITE_GATE: gate, VERCEL_ENV: "production" }), gate).toBe(true);
    for (const gate of ["on", "yes", "true", "typo"]) expect(indexingOn({ SITE_GATE: gate, VERCEL_ENV: "production" }), gate).toBe(false);
  });

  test("VERCEL_ENV is read trimmed and exactly: only the word production", () => {
    expect(indexingOn({ VERCEL_ENV: " production\n" })).toBe(true);
    for (const v of ["Production", "prod", "", "preview"]) expect(indexingOn({ VERCEL_ENV: v }), v).toBe(false);
    expect(indexingOn({})).toBe(false);
  });
});

describe("indexableHost", () => {
  test("only the host of SITE_URL, without a port, in any case", () => {
    expect(indexableHost("mslab.ee", "https://mslab.ee")).toBe(true);
    expect(indexableHost("MSLAB.EE:443", "https://mslab.ee")).toBe(true);
    expect(indexableHost("mslab.ee", "https://mslab.ee/")).toBe(true);
  });

  test("www, the Vercel addresses, a look-alike and no host are never indexable", () => {
    for (const host of ["www.mslab.ee", "mslab-flax.vercel.app", "mslab.ee.evil.example", "xmslab.ee", "", null, undefined])
      expect(indexableHost(host, "https://mslab.ee"), String(host)).toBe(false);
  });
});

test("the noindex value and the private sources", () => {
  expect(NOINDEX).toBe("noindex, nofollow");
  expect(PRIVATE_HEADER_SOURCES).toEqual([
    "/admin/:path*",
    "/api/:path*",
    "/konto/:path*",
    "/konto",
    "/ru/konto/:path*",
    "/ru/konto",
    "/ostukorv/:path*",
    "/ostukorv",
    "/ru/ostukorv/:path*",
    "/ru/ostukorv",
    "/makse",
    "/ru/makse",
    "/maksa/:token",
    "/guide/:path*",
    "/p/:path*",
    "/tulekul/:path*",
  ]);
});

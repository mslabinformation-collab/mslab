import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ADMIN_PATH_HEADER, PATH_ORIGIN, RETURN_MAX, adminLoginHref, adminReturnPath } from "@/lib/admin-return";

// B19 (admin UX pass piece 4c, ruling R-f): the way back to the admin page she opened before signing in. The value comes from a query
// parameter (?tagasi=), so it is checked as an attacker's: the login request checks it, and the login link checks it again. Anything that
// is not one of the admin's own pages lands on /admin without a word (builder notes §5 C8).

const SITE = "https://mslab.example";

describe("adminReturnPath: an admin page of this site", () => {
  test.each([
    ["/admin/kalender?id=3", "/admin/kalender?id=3"],
    ["/admin/testimine#x", "/admin/testimine#x"],
    ["/admin", "/admin"],
    ["/admin/koolitused/5?oppetund=9#moodul-2", "/admin/koolitused/5?oppetund=9#moodul-2"],
    ["/admin/tagasiside?vaade=arvustused&olek=ootel", "/admin/tagasiside?vaade=arvustused&olek=ootel"],
  ])("%s is kept", (raw, kept) => {
    expect(adminReturnPath(raw, SITE)).toBe(kept);
  });

  test("it is rebuilt from the parsed path, query and fragment: what goes into a Location header is encoded", () => {
    expect(adminReturnPath('/admin/opilased?otsi=Anu Kask"<x>', SITE)).toBe("/admin/opilased?otsi=Anu%20Kask%22%3Cx%3E");
    expect(adminReturnPath("/admin/testimine#a b", SITE)).toBe("/admin/testimine#a%20b");
    expect(adminReturnPath("/admin/ä", SITE)).toBe("/admin/%C3%A4");
  });

  test(`up to ${RETURN_MAX} characters, before and after the encoding`, () => {
    const at = (n: number) => `/admin/opilased?otsi=${"a".repeat(n - "/admin/opilased?otsi=".length)}`;
    expect(adminReturnPath(at(RETURN_MAX), SITE)).toBe(at(RETURN_MAX));
    expect(adminReturnPath(at(RETURN_MAX + 1), SITE)).toBeNull();
    // 58 characters typed, 303 once encoded
    expect(adminReturnPath(`/admin/x?${"ä".repeat(49)}`, SITE)).toBeNull();
    expect(adminReturnPath(`/admin/x?${"ä".repeat(48)}`, SITE)).toBe(`/admin/x?${"%C3%A4".repeat(48)}`);
    expect(RETURN_MAX).toBe(300);
  });

  test("the origin given decides nothing for a path: the same answer for the site's own and for the check of a path alone", () => {
    for (const raw of ["/admin/kalender?id=3", "/admin/testimine#x", "//evil", "/admin/login"])
      expect(adminReturnPath(raw, PATH_ORIGIN), raw).toBe(adminReturnPath(raw, SITE));
  });
});

describe("adminReturnPath: anything else is null (the landing is then /admin)", () => {
  test.each([
    // another site
    ["//evil"],
    ["//evil.example/admin"],
    ["/\\evil"],
    ["/\\evil.example/admin"],
    ["\\\\evil.example/admin"],
    ["https://other/admin"],
    ["https://mslab.example/admin"], // an absolute URL, even of this site: the app only ever sends a path
    ["http:/admin"],
    ["javascript:alert(1)"],
    // encoded slashes, backslashes and dots (lib/unclean-path.ts UNCLEAN, the gate's rule too)
    ["%2F%2Fevil"],
    ["/%2F%2Fevil"],
    ["/admin/%2F%2Fevil"],
    ["/admin/%2fevil"],
    ["/admin/%5Cevil"],
    ["/admin/%2e%2e/konto"],
    ["/admin/../konto"],
    ["/admin/./kalender"],
    ["/admin//kalender"],
    ["/admin\\kalender"],
    // the login page itself, however it is written (a loop back to the form)
    ["/admin/login"],
    ["/admin/login?tagasi=/admin/kalender"],
    ["/admin/login/"],
    ["/admin/login#x"],
    ["/admin/%6Cogin"],
    // not the admin
    ["/adminx"],
    ["/administrator"],
    ["/admin.php"],
    ["/"],
    ["/konto"],
    ["/api/admin/margid"],
    ["admin/kalender"],
    // a tab, a newline or another control character anywhere (URL parsing would drop tabs and newlines without a word)
    ["/admin/kalen\tder"],
    ["/admin/kalender\n"],
    ["/admin/kalender\r\nSet-Cookie: x=1"],
    ["\t/admin"],
    ["/admin/kalender?id=3\u0000"],
    ["/admin/testimine#\u007f"],
    // nothing
    [""],
  ])("%j", (raw) => {
    expect(adminReturnPath(raw, SITE)).toBeNull();
  });

  test("301 characters, null and a broken origin", () => {
    expect(adminReturnPath(`/admin/${"k".repeat(301 - "/admin/".length)}`, SITE)).toBeNull();
    expect(adminReturnPath(null, SITE)).toBeNull();
    expect(adminReturnPath("/admin/kalender", "not a url")).toBeNull();
  });
});

describe("adminLoginHref: the login page with the way back", () => {
  test("an admin page gives ?tagasi= with its path, query and fragment, encoded as one value", () => {
    expect(adminLoginHref("/admin/kalender?id=3")).toBe("/admin/login?tagasi=%2Fadmin%2Fkalender%3Fid%3D3");
    expect(adminLoginHref("/admin/testimine#kirjad-halduse-link")).toBe("/admin/login?tagasi=%2Fadmin%2Ftestimine%23kirjad-halduse-link");
  });

  test("the panel's front page, a bad path and none give the plain login page (a sign-in lands on /admin anyway)", () => {
    for (const path of ["/admin", "//evil", "/admin/login", "/adminx", null]) expect(adminLoginHref(path), String(path)).toBe("/admin/login");
  });

  test("the middleware's request header", () => {
    expect(ADMIN_PATH_HEADER).toBe("x-mslab-path");
  });
});

describe("what the browser gets of it (review m-4)", () => {
  test("it imports only the gate's one pattern (lib/unclean-path.ts), never the gate or its cookie signing: SaveStatus runs it in the browser", () => {
    const imports = [...readFileSync(join(process.cwd(), "src", "lib", "admin-return.ts"), "utf8").matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./unclean-path"]);
    expect(readFileSync(join(process.cwd(), "src", "lib", "unclean-path.ts"), "utf8")).not.toMatch(/^import /m);
  });
});

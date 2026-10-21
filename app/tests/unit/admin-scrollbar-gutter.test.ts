import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The scroll-lock layout shift (launch checklist §5, closed by the admin UX pass piece 1) is fixed with `scrollbar-gutter: stable`, for the
// admin's menu and drawers only. The public site is out of scope (spec §11): a gutter on it takes 15 px of every full-width band on a
// browser with classic scrollbars. So the rule hangs on a marker that only the admin's root layout sets, and no other root layout may set it.

const APP = process.cwd();
const read = (path: string) => readFileSync(join(APP, path), "utf8");

/** Every `layout.tsx` under src/app that renders <html> (a root layout). */
function rootLayouts(dir = join(APP, "src", "app")): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...rootLayouts(path));
    else if (name === "layout.tsx" && /<html[\s>]/.test(readFileSync(path, "utf8"))) found.push(path);
  }
  return found;
}

describe("the scrollbar gutter is the admin's alone", () => {
  const css = read("src/styles/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

  test("globals.css declares scrollbar-gutter once, inside the rule for html[data-admin]", () => {
    const declarations = css.match(/scrollbar-gutter\s*:[^;]*;/g) ?? [];
    expect(declarations).toHaveLength(1);
    const rule = /(^|[}\s])html\[data-admin\]\s*\{([^}]*)\}/.exec(css);
    expect(rule, "a rule for html[data-admin]").not.toBeNull();
    expect(rule![2]).toMatch(/scrollbar-gutter\s*:\s*stable\s*;/);
  });

  test("no other stylesheet of the app sets it", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    const others = walk(join(APP, "src"))
      .filter((path) => /\.(css|tsx?)$/.test(path) && !path.endsWith(join("styles", "globals.css")))
      .filter((path) => /scrollbar-gutter/.test(readFileSync(path, "utf8")));
    expect(others.map((p) => p.slice(APP.length + 1))).toEqual([]);
  });

  test("the admin's root layout sets data-admin on <html>, and no other root layout does", () => {
    const layouts = rootLayouts().map((path) => ({ path: path.slice(APP.length + 1).replace(/\\/g, "/"), source: readFileSync(path, "utf8") }));
    expect(layouts.map((l) => l.path)).toContain("src/app/admin/layout.tsx");
    for (const { path, source } of layouts) {
      const html = /<html[^>]*>/.exec(source)?.[0] ?? "";
      if (path === "src/app/admin/layout.tsx") expect(html, path).toMatch(/\sdata-admin(=|\s|>)/);
      else expect(html, path).not.toMatch(/data-admin/);
    }
  });
});

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ignore from "ignore";
import { describe, expect, test } from "vitest";

// `vercel deploy` from the repository root uploads what the root .vercelignore lets through (the CLI reads the file of
// the folder it runs in). The file is an allow-list of what `next build` in app/ reads. The folder next to it holds
// local state that must never go up: Wrangler state of the retired Workers (a copy of the production KV namespace id
// and hundreds of MB of logs), the old OpenNext build, local media, env files with secrets, test output. This guard
// applies the file the way the CLI does (vercel 54.6.1: the `ignore` package, one test per path and per folder above it,
// an ignored folder is not entered), on its own, without the CLI's built-in default list, so the file itself has to
// carry every exclusion.

const APP = process.cwd();
const REPO = join(APP, "..");
const FILE = readFileSync(join(REPO, ".vercelignore"), "utf8");

/** The CLI's `clearRelative`: a leading "./" in a rule is dropped. */
const clearRelative = (text: string) => text.replace(/(\n|^)\.\//g, "$1");

/** Whether a deploy from the repository root uploads `path` (forward slashes, relative to the root). */
function uploaded(rules: string, path: string): boolean {
  const ig = ignore().add(clearRelative(rules));
  const parts = path.split("/");
  // the CLI walks the tree: an ignored folder is never entered, so a path goes up only when it and every folder above it pass
  return parts.every((_, i) => !ig.ignores(parts.slice(0, i + 1).join("/")));
}

/** What the Vercel build of app/ reads (project Root Directory `app`), the certificate's fonts included (phase 3d): the only things of app/ that may be uploaded. */
const BUILD_INPUTS = ["src", "public", "assets", "drizzle", "package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "vercel.json", "drizzle.config.ts"];

describe("root .vercelignore (what a CLI deploy uploads)", () => {
  test("uploads what the build of app/ reads", () => {
    const sql = readdirSync(join(APP, "drizzle")).find((f) => f.endsWith(".sql"));
    const wanted = [...BUILD_INPUTS.filter((p) => !["src", "public", "assets", "drizzle"].includes(p)), "src/middleware.ts", "src/instrumentation.ts", "public/feedback.js", "assets/fonts/Jost[wght].ttf", `drizzle/${sql}`];
    for (const p of wanted) expect(existsSync(join(APP, p)), `${p} exists`).toBe(true); // the list is not stale
    expect(wanted.filter((p) => !uploaded(FILE, `app/${p}`))).toEqual([]);
  });

  test("leaves out local state and secrets of app/, however deep they sit", () => {
    const local = [
      "node_modules/next/package.json",
      ".next/BUILD_ID",
      ".env",
      ".env.local",
      ".env.production",
      ".env.development.local",
      ".env.vercel",
      ".env.example", // not read by the build, so not uploaded either
      ".dev.vars",
      ".dev.vars.production",
      ".wrangler/state/v3/kv/miniflare-KVNamespaceObject/abc.sqlite",
      ".wrangler/logs/wrangler.log",
      ".open-next/worker.js",
      ".open-next/assets/_next/static/x.js",
      ".vercel/project.json",
      ".media-local/img/a.jpg",
      "test-results/x/error-context.md",
      "playwright-report/index.html",
      "visual-shots/home.png",
      "tsconfig.tsbuildinfo",
      "next-env.d.ts",
      // not build inputs: tests and the tools that run them
      "tests/unit/env.test.ts",
      "tests/local-secrets.ts",
      "vitest.config.mts",
      "playwright.config.ts",
      "eslint.config.mjs",
      ".gitignore",
      // a copied folder can carry its own local state
      "src/server/.env",
      "src/.dev.vars",
      "public/guide/.wrangler/state/x",
      "public/p/d/.env.local",
      "drizzle/.dev.vars.test",
    ];
    expect(local.filter((p) => uploaded(FILE, `app/${p}`))).toEqual([]);
  });

  test("leaves out everything outside app/", () => {
    const outside = [
      ".dev.vars",
      ".env",
      ".wrangler/state/v3/kv/x.sqlite",
      ".vercel/project.json",
      ".git/config",
      ".gitignore",
      ".vercelignore",
      ".playwright-mcp/page.yml",
      ".superpowers/sdd/ledger.md",
      "Assets/photo.png",
      "docs/deploy.md",
      "tools/cache-smoke.mjs",
      "README.md",
    ];
    expect(outside.filter((p) => uploaded(FILE, p))).toEqual([]);
  });

  test("on this machine too: nothing of app/ or of the repository root that the build does not read goes up", () => {
    const top = (dir: string, prefix: string) => readdirSync(dir).filter((name) => uploaded(FILE, prefix + name));
    expect(top(REPO, "")).toEqual(["app"]);
    const extra = top(APP, "app/").filter((name) => !BUILD_INPUTS.includes(name));
    expect(extra).toEqual([]);
  });

  test("the folder of the file itself is the only one that counts: there is no .vercelignore in app/", () => {
    // the CLI reads the file of the folder it runs in: a deploy from the root ignores an app/.vercelignore, and a deploy
    // from app/ is refused (the Root Directory `app` would then be app/app)
    expect(existsSync(join(APP, ".vercelignore"))).toBe(false);
  });

  test("the matcher notices a hole: the file this one replaced let local Wrangler state and the old build through", () => {
    const before = ["/*", "!/app", "/app/node_modules", "/app/.next", "/app/.env*", "!/app/.env.example", "/app/.vercel", "/app/.media-local", "/app/test-results", "/app/playwright-report", "/app/visual-shots", "/app/.dev.vars*"].join("\n");
    expect(uploaded(before, "app/.wrangler/state/v3/kv/x.sqlite")).toBe(true);
    expect(uploaded(before, "app/.open-next/worker.js")).toBe(true);
    expect(uploaded(before, "app/src/middleware.ts")).toBe(true);
    expect(uploaded(before, "docs/deploy.md")).toBe(false);
  });
});

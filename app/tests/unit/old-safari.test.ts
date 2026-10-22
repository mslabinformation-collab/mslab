import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The course day's screen runs on Maria's tablet and the account's pages and the site on the students' phones: iOS Safari before 16.4
// cannot parse a regular expression with a lookbehind, and one such literal stops the whole script (the final review found lib/storable.ts's
// reaching every account page through AccountLoader → useAccount → lib/favourites). So this test follows the imports: from each entry
// point (the phase's browser files below, and every "use client" file of src) it walks every `@/…` and relative import that is loaded in the
// browser, and no file in that graph may hold a lookbehind. Not followed: `import type` (and imports of types only), which the build
// erases; a "use server" file, of which the browser gets only references; packages; CSS, images and other assets.

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const BROWSER_FILES = [
  // phase protocols, Task 1
  "src/lib/to-storable.ts",
  "src/domain/protocols.ts",
  // what domain/protocols.ts pulls into the browser (Task 1's review)
  "src/domain/calendar.ts",
  "src/domain/catalogue.ts",
  // Task 4
  "src/components/admin/ProtocolStagesEditor.tsx",
  // Task 5
  "src/components/admin/protocol-autosave.ts",
  "src/components/admin/ProtocolScreen.tsx",
  "src/components/admin/GrowingText.tsx",
  // Task 6
  "src/components/admin/ProtocolSend.tsx",
  // what the screen pulls into the browser besides (Task 5's review)
  "src/i18n/format.ts",
  "src/i18n/dict/admin.ts",
  // Task 7
  "src/components/account/useHashId.ts",
  "src/components/account/AccountNotFound.tsx",
  "src/components/account/ProtocolPage.tsx",
  // Task 8
  "src/components/account/FeedbackCard.tsx",
  "src/components/account/FeedbackForm.tsx",
  // what the card and the form pull into the browser besides: the JSON request, the language's address, the loader around the form's state
  "src/lib/json-request.ts",
  "src/i18n/href.ts",
  "src/components/account/AccountLoader.tsx",
  // what the student's page pulls into the browser besides: the id parser, the language pick, the texts and the dictionaries they come from
  "src/lib/row-id.ts",
  "src/i18n/field.ts",
  "src/components/account/texts.ts",
  "src/i18n/dict/et.ts",
  "src/i18n/dict/ru.ts",
  // the final review: the site's favourite hearts and the home page's two popups (lib/favourites, lib/typography)
  "src/components/site/FavouriteButton.tsx",
  "src/components/site/CampaignPopup.tsx",
  "src/components/site/NewsletterPopup.tsx",
  // e-course completion, Task 1: the rules the test and practical pages and the course editor share
  "src/domain/completion.ts",
  // e-course completion, Task 3: the course editor's "Teadmiste test" (it pulls domain/completion.ts into the browser)
  "src/components/admin/TestEditor.tsx",
  // e-course completion, Task 6: the student's test (a "use client" file, walked anyway: listed as the phase's entry point)
  "src/components/account/TestPage.tsx",
  // e-course completion, Task 8: the practical page, the shrink and the upload
  "src/lib/shrink-image.ts",
  "src/components/account/photo-upload.ts",
  "src/components/account/PracticalPage.tsx",
  "src/components/account/PhotoSlot.tsx",
  // e-course completion, Task 9: the e-course page's steps
  "src/components/account/CompletionSteps.tsx",
  // e-course completion, Task 11: Maria's verdict taps
  "src/components/admin/verdict-taps.ts",
  // the certificate, Task 1: the name rules the student's name field and Seaded share (it pulls domain/calendar.ts, listed above)
  "src/domain/certificate.ts",
  // the test page, Task 1: the plan's rules the page loads in the browser (pure, imports nothing)
  "src/domain/testplan.ts",
  // the test page, Task 3: the page, its outbox of unsent answers, and the Avaleht card (the card is a server component, listed anyway: it is the phase's file)
  "src/components/admin/TestPlan.tsx",
  "src/components/admin/testplan-outbox.ts",
  "src/components/admin/TestplanCard.tsx",
  // contracts, Task 1: the placeholders' fill and the session and payment texts the form's and the cart's inline contract and Seaded's sample run in the browser
  "src/domain/contract.ts",
  // student reviews, Task 1: the consent, name and month rules the feedback form, Maria's „Lisa arvustus“ and the review blocks run in the browser (it pulls domain/protocols.ts, domain/calendar.ts, i18n/format.ts and lib/row-id.ts with it)
  "src/domain/review.ts",
  // newsletter campaigns, Task 1: the draft's rules and the text of each language, which Maria's campaign editor and its preview run in the browser (it pulls domain/welcome-code.ts, domain/catalogue.ts and lib/to-storable.ts with it)
  "src/domain/newsletter-campaign.ts",
  // admin UX pass, Task 4: the menu state the sidebar reads from /api/admin/margid
  "src/components/admin/menu-state.ts",
  // admin UX pass, Task 3: the menu's sections and groups, and the address-to-entry rule the sidebar runs in the browser
  "src/components/admin/sections.ts",
  // admin UX pass, Task 8: the autosave's status and the save endpoints' answer (types), which SaveStatus and the editors' autosave share
  "src/domain/autosave.ts",
  // admin UX pass, Task 9: the editors' autosave engine (useAutosave's, no React; it pulls lib/version.ts and autosave/constants.ts, the timings protocol-autosave.ts re-exports)
  "src/components/admin/autosave/engine.ts",
  // admin UX pass, Task 13: the list addresses (withListParams, listHref) the ListToolbar builds its replaces from in the browser (the toolbar is a "use client" file, walked anyway)
  "src/components/admin/list-params.ts",
  // instalments, Task 1: the rules of Järelmaks (Inbank) (offered, allowed, the phone and the name for Inbank's form), which the registration form and the cart run in the browser (pure, imports nothing)
  "src/domain/financing.ts",
  // the A screens, Task 1: the search and name helpers the lists, the drawers and the greeting run in the browser (pure, import nothing), the folded row and the
  // tab pills (plain markup with no "use client" line: server pages and client components both draw them) and the autosave timings (the engine pulls them)
  "src/domain/search.ts",
  "src/domain/names.ts",
  "src/components/admin/FoldRow.tsx",
  "src/components/admin/TabPills.tsx",
  "src/components/admin/autosave/constants.ts",
];

const LOOKBEHIND = new RegExp(["\\(\\?<", "="].join("") + "|" + ["\\(\\?<", "!"].join(""));

const CODE = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const ASSET = /\.(css|scss|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|mp4|webm|json|txt)$/i;
const USE_CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/;
const USE_SERVER = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use server["']/;

/** `import … from "x"` and `export … from "x"` (with what they bring), `import "x"`, and `import("x")`. */
const FROM = /(?:^|[\s;}])(import|export)\s+([^'";]*?)\s*from\s*["']([^"']+)["']/g;
const BARE = /(?:^|[\s;}])import\s*["']([^"']+)["']/g;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** An import that brings only types (`import type …`, `export type …`, `import { type A, type B }`): erased by the build. */
function typesOnly(clause: string): boolean {
  const c = clause.trim();
  if (/^type[\s{]/.test(c)) return true;
  const braces = c.match(/^\{([^}]*)\}$/);
  if (!braces) return false;
  const names = braces[1].split(",").map((n) => n.trim()).filter(Boolean);
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}

/** The specifiers a file loads in the browser (not type-only imports). */
function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(FROM)) if (!typesOnly(m[2])) out.push(m[3]);
  for (const m of source.matchAll(BARE)) out.push(m[1]);
  for (const m of source.matchAll(DYNAMIC)) out.push(m[1]);
  return out;
}

/** The file a specifier names (`@/…` or relative), null for a package or an asset; throws when it names nothing (the walk must not skip it). */
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = resolve(dirname(from), spec);
  else return null;
  if (ASSET.test(spec)) return null;
  for (const ext of ["", ...CODE, ...CODE.map((e) => `/index${e}`)]) {
    const file = base + ext;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  throw new Error(`${relative(ROOT, from)}: cannot resolve "${spec}"`);
}

/** Every file of src with a "use client" directive. */
function clientFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...clientFiles(path));
    else if (CODE.some((e) => name.endsWith(e)) && USE_CLIENT.test(readFileSync(path, "utf8"))) out.push(path);
  }
  return out;
}

/** The browser's graph from `entries`: each file with the one that imported it first (for the message). */
function browserGraph(entries: readonly string[]): Map<string, string | null> {
  const seen = new Map<string, string | null>();
  const todo = entries.map((f) => resolve(ROOT, f));
  for (const f of todo) seen.set(f, null);
  while (todo.length > 0) {
    const file = todo.shift()!;
    const source = readFileSync(file, "utf8");
    if (USE_SERVER.test(source)) continue; // (the browser gets references to its actions, not its code)
    for (const spec of importsOf(source)) {
      const target = resolveImport(file, spec);
      if (target === null || seen.has(target)) continue;
      seen.set(target, file);
      todo.push(target);
    }
  }
  return seen;
}

const path = (file: string, graph: Map<string, string | null>): string => {
  const chain: string[] = [];
  for (let f: string | null = file; f; f = graph.get(f) ?? null) chain.unshift(relative(ROOT, f).replaceAll("\\", "/"));
  return chain.join(" → ");
};

describe("old iPads and phones (iOS Safari before 16.4)", () => {
  test("no file the browser loads holds a lookbehind: the phase's browser files, every 'use client' file, and everything they import", () => {
    for (const f of BROWSER_FILES) expect(existsSync(join(ROOT, f)), f).toBe(true);
    const graph = browserGraph([...BROWSER_FILES, ...clientFiles()]);
    const bad = [...graph.keys()].filter((f) => LOOKBEHIND.test(readFileSync(f, "utf8"))).map((f) => path(f, graph));
    expect(bad).toEqual([]);
  });

  test("the walk follows `@/…` and relative imports, and the account pages reach lib/storable through lib/favourites", () => {
    const graph = browserGraph(["src/components/account/AccountLoader.tsx"]);
    const storable = join(SRC, "lib", "storable.ts");
    expect(path(storable, graph)).toBe("src/components/account/AccountLoader.tsx → src/components/account/useAccount.ts → src/lib/favourites.ts → src/lib/storable.ts");
    expect(path(join(SRC, "lib", "typography.ts"), browserGraph(["src/components/site/CampaignPopup.tsx"]))).toContain("src/components/site/CampaignCard.tsx → src/lib/typography.ts");
  });

  test("the walk leaves out what the browser does not load: imports of types only, and a 'use server' file's own imports", () => {
    const graph = browserGraph(["src/components/admin/ProtocolSend.tsx"]);
    const keys = [...graph.keys()].map((f) => relative(ROOT, f).replaceAll("\\", "/"));
    expect(keys).toContain("src/server/actions/admin-protocols.ts"); // its references are loaded
    expect(keys).not.toContain("src/server/protocols.ts"); // `import type { BulkResult, SendOutcome }`, and the action file's own import
    expect(importsOf('import type { A } from "./a";\nimport { type B, type C } from "./b";\nimport { type D, e } from "./c";\nexport type { F } from "./f";')).toEqual(["./c"]);
    expect(importsOf('import x, {\n  y,\n  z,\n} from "@/lib/x";\nimport "./side";\nconst m = await import("../dyn");')).toEqual(["@/lib/x", "./side", "../dyn"]);
  });

  test("the check sees a lookbehind", () => {
    expect("/(?" + "<!x)y/").toMatch(LOOKBEHIND);
    expect("/(?" + "<=x)y/").toMatch(LOOKBEHIND);
    expect("/(?<name>x)/").not.toMatch(LOOKBEHIND);
  });
});

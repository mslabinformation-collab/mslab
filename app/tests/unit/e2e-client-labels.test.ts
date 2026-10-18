import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Every account test signs in as `e2e-client-<label>-<project>@example.test` with an e-course `e2e-konto-<label>-<project>` of its own
// (tests/e2e/account.ts clientEmail, fixtures.ts accountCourseSlug), and removes those rows by address before and after it runs
// (removeClientRows). The workers share one database, so two spec files that use the same label would delete each other's client and
// course in the middle of a test: a foreign key error, or a student sent to the login page. A label belongs to one spec file.

const E2E_DIR = fileURLToPath(new URL("../e2e", import.meta.url));

/** The closing character of each bracket a call's arguments may hold. */
const CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * One past the end of the string, template, bracketed group or comment that starts at `at` (the end of `src` when it is not closed): a `${…}`
 * inside a template is skipped as code, and a quote inside a comment opens nothing. (No regular expression literal is ever passed to a label
 * helper, so none is read here.)
 */
function skip(src: string, at: number): number {
  const open = src[at];
  const until = (end: string, from: number) => (src.indexOf(end, from) < 0 ? src.length : src.indexOf(end, from) + end.length);
  if (src.startsWith("//", at)) return until("\n", at);
  if (src.startsWith("/*", at)) return until("*/", at + 2);
  let i = at + 1;
  if (open === '"' || open === "'") {
    while (i < src.length && src[i] !== open) i += src[i] === "\\" ? 2 : 1;
    return i + 1;
  }
  if (open === "`") {
    while (i < src.length && src[i] !== "`") i = src[i] === "\\" ? i + 2 : src.startsWith("${", i) ? skip(src, i + 1) : i + 1;
    return i + 1;
  }
  while (i < src.length && src[i] !== CLOSE[open]) i = opens(src, i) ? skip(src, i) : i + 1;
  return i + 1;
}

/** Whether a string, template, bracket or comment starts at `i`. */
const opens = (src: string, i: number) => /["'`([{]/.test(src[i]) || src.startsWith("//", i) || src.startsWith("/*", i);

/**
 * `src` with its comments blanked (a comment's example call, such as `address (\`e2e-client-details-…\`)`, is no call), its strings and its
 * regular expression literals kept as they are: a quote inside either opens nothing. A "/" is a regular expression where an operand is expected
 * (after an operator, an opening bracket, a comma or `return`), a division after a name, a number or a closing bracket.
 */
function code(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; ) {
    if (src.startsWith("//", i) || src.startsWith("/*", i)) {
      const end = skip(src, i);
      out += src.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
    } else if (/["'`]/.test(src[i])) {
      const end = skip(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (src[i] === "/" && /(^|[=(,:[!&|?{};+\-*%<>~^]|\breturn)\s*$/.test(out.slice(-20))) {
      let j = i + 1;
      for (let inClass = false; j < src.length && src[j] !== "\n" && (inClass || src[j] !== "/"); j++) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else out += src[i++];
  }
  return out;
}

/** The arguments (or parameters) of the call (or declaration) whose "(" is at `open`, as written, trimmed; a trailing comma adds none. */
function argsAt(src: string, open: number): string[] {
  const end = skip(src, open) - 1;
  const args: string[] = [];
  let from = open + 1;
  for (let i = from; i < end; ) {
    if (src[i] === ",") {
      args.push(src.slice(from, i).trim());
      from = ++i;
    } else i = opens(src, i) ? skip(src, i) : i + 1;
  }
  const last = src.slice(from, end).trim();
  return last ? [...args, last] : args;
}

/**
 * A function that makes an address from a label: which of its arguments is the label (`at`), what the address puts in front of it (`prefix`), and
 * how much of that the functions of the file it is declared in add themselves (`word`: the rest comes from a helper module's function).
 */
type Helper = { at: number; prefix: string; word: string };

/** A function declared in a file of tests/e2e whose parameters include `label`: its name, the label's place, and its body (to its closing brace). */
type Declared = { name: string; at: number; body: string };

/** The functions of `source` that take a `label` (tests/e2e is formatted by Prettier: a top-level function's body ends at a "}" that starts a line). */
function declared(source: string): Declared[] {
  const out: Declared[] = [];
  for (const m of source.matchAll(/^(?:export )?(?:async )?function (\w+)\s*(?:<[^(]*>)?\(/gm)) {
    const open = m.index + m[0].length - 1;
    const at = argsAt(source, open).findIndex((p) => /^label\b/.test(p));
    if (at < 0) continue;
    const from = skip(source, open);
    out.push({ name: m[1], at, body: source.slice(from, source.indexOf("\n}", from)) });
  }
  return out;
}

/** Every call in `source` of one of `helpers` (not a method: `x.student(` is another's), with its arguments as written. */
function* calls(source: string, helpers: Map<string, Helper>): Generator<{ name: string; helper: Helper; args: string[] }> {
  for (const m of source.matchAll(/(?<![\w.$])(\w+)\s*\(/g)) {
    const helper = helpers.get(m[1]);
    if (helper) yield { name: m[1], helper, args: argsAt(source, m.index + m[0].length - 1) };
  }
}

/**
 * The label helpers each file may call, found to a fixed point from tests/e2e/account.ts clientEmail: a function is one when its body hands its own
 * `label` to a helper, as it is (`clientEmail(label, project)`) or after a word of its own (`clientEmail(\`certrace-${label}\`, …)`). Each file
 * sees its own functions and those of the helper modules (account.ts, protocols.ts, …: the files that are not specs); its own come first.
 */
function labelHelpers(files: { f: string; source: string }[]): { visible: Map<string, Map<string, Helper>>; own: Map<string, Map<string, Helper>> } {
  const decls = new Map(files.map(({ f, source }) => [f, declared(source)]));
  const own = new Map(files.map(({ f }) => [f, new Map<string, Helper>()]));
  own.get("account.ts")?.set("clientEmail", { at: 0, prefix: "", word: "" });
  const shared = () => new Map(files.filter(({ f }) => !f.endsWith(".spec.ts")).flatMap(({ f }) => [...own.get(f)!]));
  const visible = (f: string) => new Map([...shared(), ...own.get(f)!]);
  for (let found = true; found; ) {
    found = false;
    for (const { f } of files)
      for (const d of decls.get(f)!) {
        if (own.get(f)!.has(d.name)) continue;
        for (const { name, helper, args } of calls(d.body, visible(f))) {
          const arg = args[helper.at] ?? "";
          const word = arg === "label" ? "" : /`([^`$]*)\$\{label\}/.exec(arg)?.[1];
          if (word === undefined) continue;
          own.get(f)!.set(d.name, { at: d.at, prefix: helper.prefix + word, word: (own.get(f)!.has(name) ? helper.word : "") + word });
          found = true;
          break;
        }
      }
  }
  return { visible: new Map(files.map(({ f }) => [f, visible(f)])), own };
}

type Labels = { file: string; own: string[]; prefixes: string[]; templates: string[] };

/**
 * The labels one spec file gives its client helpers (`student(page, "fail", info.project.name)`, `written("race", runName(info))`), as the
 * address carries them: a helper may put a word in front (account-details: `details-${label}`; protocols.ts: `proto-${label}`). `prefixes` are
 * the words its own helpers put in front (an imported helper's word is shared by every spec that calls it). `templates` are labels with a part
 * that varies (`seekbox-${mode}`), up to the variable part.
 */
function labelsOf(file: string, source: string, helpers: Map<string, Helper>, local: Map<string, Helper>): Labels {
  const own = new Set<string>();
  const templates = new Set<string>();
  for (const { helper, args } of calls(source, helpers)) {
    const arg = args[helper.at] ?? "";
    if (!/^(`[^`]*`|"[^"]*"|'[^']*')$/.test(arg)) continue; // a variable: the call that gives it its value is read instead
    const label = arg.slice(1, -1);
    const at = label.indexOf("${");
    if (at < 0) own.add(helper.prefix + label);
    else templates.add(helper.prefix + label.slice(0, at));
  }
  const prefixes = [...local.values()].filter((h) => h.word).map((h) => h.prefix);
  return { file, own: [...own], prefixes: [...new Set(prefixes)], templates: [...templates] };
}

// tests/e2e's files, their comments blanked
const files = readdirSync(E2E_DIR)
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => ({ f, source: code(readFileSync(`${E2E_DIR}/${f}`, "utf8")) }));
const helpers = labelHelpers(files);

// the specs that make clients: the ones that remove their rows
const specs = files
  .filter(({ f, source }) => f.endsWith(".spec.ts") && source.includes("removeClientRows"))
  .map(({ f, source }) => labelsOf(f, source, helpers.visible.get(f)!, helpers.own.get(f)!));

describe("e2e client labels", () => {
  test("the specs that make clients are found, with their labels, through the helpers that make the address too", () => {
    expect(specs.length).toBeGreaterThan(8);
    expect(specs.find((s) => s.file === "lesson-player.spec.ts")!.own).toContain("seek");
    expect(specs.find((s) => s.file === "account-details.spec.ts")!.prefixes).toEqual(["details-"]);
    expect(specs.find((s) => s.file === "account-details.spec.ts")!.own).toContain("details-profile");
    // a local helper calling a local helper (completion-race: ready → course), and an imported one (protocols-race: written → insertProtocolFixtures)
    expect(specs.find((s) => s.file === "completion-race.spec.ts")!.own).toEqual(expect.arrayContaining(["race-send", "race-cap", "race-gone"]));
    expect(specs.find((s) => s.file === "protocols-race.spec.ts")!.own).toEqual(expect.arrayContaining(["proto-race", "proto-held"]));
    // a helper that is handed the test's info, not its project's name (contracts-race: student(label, cards, info)), with a word of its own
    const contracts = specs.find((s) => s.file === "contracts-race.spec.ts")!;
    expect(contracts.own).toEqual(expect.arrayContaining(["contract-race-a", "contract-race-c"]));
    expect(contracts.templates).toEqual(expect.arrayContaining(["contract-race-b-", "contract-race-d-"]));
    expect(specs.find((s) => s.file === "certificate-race.spec.ts")!.own).toEqual(expect.arrayContaining(["certrace-a", "certrace-twice"]));
    // the reviews' race (student reviews, Task 6): the same helper shape as contracts-race, and the whole path's own labels
    const reviews = specs.find((s) => s.file === "reviews-race.spec.ts")!;
    expect(reviews.own).toEqual(expect.arrayContaining(["revrace-a", "revrace-b"]));
    expect(reviews.templates).toEqual(expect.arrayContaining(["revrace-c-"]));
    expect(specs.find((s) => s.file === "reviews.spec.ts")!.own).toEqual(expect.arrayContaining(["reviews-contact", "reviews-ecourse"]));
  });

  test("every spec that makes clients has its labels seen: one the helpers cannot be followed through would be checked against nothing", () => {
    expect(specs.filter((s) => s.own.length + s.templates.length === 0).map((s) => s.file)).toEqual([]);
    // the race specs on real Postgres among them
    const races = specs.filter((s) => s.file.endsWith("-race.spec.ts")).map((s) => s.file).sort();
    expect(races).toEqual(["certificate-race.spec.ts", "completion-race.spec.ts", "contracts-race.spec.ts", "protocols-race.spec.ts", "reviews-race.spec.ts"]);
  });

  test("a label is used by one spec file only: the workers share the database, and a test removes its client's rows by address", () => {
    const owners = new Map<string, Set<string>>();
    for (const s of specs) for (const label of s.own) owners.set(label, (owners.get(label) ?? new Set()).add(s.file));
    const shared = [...owners].filter(([, files]) => files.size > 1).map(([label, files]) => `"${label}": ${[...files].join(", ")}`);
    expect(shared).toEqual([]);
  });

  test("no label starts with the word another spec file puts in front of its own (`adm-`, `details-`, `fav-`) or builds a label from", () => {
    const clashes: string[] = [];
    for (const a of specs)
      for (const start of new Set([...a.prefixes, ...a.templates].filter(Boolean)))
        for (const b of specs.filter((s) => s.file !== a.file))
          for (const label of b.own) if (label.startsWith(start)) clashes.push(`"${label}" (${b.file}) starts with "${start}" (${a.file})`);
    expect(clashes).toEqual([]);
  });

  test("a label is lowercase letters, digits and hyphens: removeClientRows matches with LIKE, where `_` and `%` stand for other characters", () => {
    const odd = specs.flatMap((s) => [...s.own, ...s.templates].filter((l) => !/^[a-z0-9-]+$/.test(l)).map((l) => `"${l}" (${s.file})`));
    expect(odd).toEqual([]);
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { PLAN_FILE, countDeploy, stamp } from "../../tools/testplan-stamp.mjs";

// tools/testplan-stamp.mjs (phase 4, piece 1, spec §6): right before the push to main it replaces every "markedAt": "deploy" of the test plan
// with the current instant, so a mark means the deploy that carried it. It changes nothing else, byte for byte.

const NOW = new Date("2026-10-22T09:30:15.123Z");
const ISO = "2026-10-22T09:30:15.123Z";
const TOOL = resolve(process.cwd(), "tools/testplan-stamp.mjs");

const SAMPLE = [
  "{",
  '  "version": 1,',
  '  "items": [',
  '    { "id": "a-one", "mark": "redo", "markedAt": "deploy", "why": "Sest." },',
  '    { "id": "a-two", "mark": "new", "markedAt": "2026-10-20T09:00:00.000Z" },',
  '    { "id": "a-three", "mark": "reworded", "markedAt": "deploy" }',
  "  ]",
  "}",
  "",
].join("\n");

describe("stamp(text, now)", () => {
  test("every \"markedAt\": \"deploy\" becomes the instant; nothing else changes", () => {
    const got = stamp(SAMPLE, NOW);
    expect(got).toBe(SAMPLE.replaceAll('"markedAt": "deploy"', `"markedAt": "${ISO}"`));
    expect(got).not.toContain("deploy");
    // a plan that was valid JSON still is, and the marks read as the instant
    const items = JSON.parse(got).items;
    expect(items.map((i: { markedAt: string }) => i.markedAt)).toEqual([ISO, "2026-10-20T09:00:00.000Z", ISO]);
  });

  test("a text with no \"deploy\" comes back identical", () => {
    const text = SAMPLE.replaceAll('"markedAt": "deploy"', '"markedAt": "2026-10-21T00:00:00.000Z"');
    expect(stamp(text, NOW)).toBe(text);
    expect(stamp("", NOW)).toBe("");
  });

  test("byte for byte: CRLF line endings, a BOM, tabs, the spacing around the colon and a missing final newline are all kept", () => {
    const crlf = SAMPLE.replaceAll("\n", "\r\n");
    expect(stamp(crlf, NOW)).toBe(crlf.replaceAll('"markedAt": "deploy"', `"markedAt": "${ISO}"`));
    const odd = '\uFEFF{\t"a": {"markedAt":"deploy"},\r\n "b": {"markedAt"  :\t"deploy"}, "c": {"markedAt" :"deploy"}}';
    expect(stamp(odd, NOW)).toBe(`\uFEFF{\t"a": {"markedAt":"${ISO}"},\r\n "b": {"markedAt"  :\t"${ISO}"}, "c": {"markedAt" :"${ISO}"}}`);
    const noFinalNewline = SAMPLE.trimEnd();
    expect(stamp(noFinalNewline, NOW).endsWith("}")).toBe(true);
  });

  test("only a markedAt value: the word elsewhere, another key, or text that merely mentions it is left alone", () => {
    const text = [
      "{",
      '  "mark": "deploy",',
      '  "why": "deploy",',
      '  "title": "markedAt deploy",',
      '  "note": "\\"markedAt\\": \\"deploy\\"",',
      '  "markedAt": "deployed",',
      '  "markedAt": "redeploy",',
      '  "markedAt": null,',
      '  "Markedat": "deploy"',
      "}",
    ].join("\n");
    expect(stamp(text, NOW)).toBe(text);
  });

  test("idempotent: stamping a stamped text changes nothing more", () => {
    const once = stamp(SAMPLE, NOW);
    expect(stamp(once, new Date("2027-01-01T00:00:00.000Z"))).toBe(once);
  });

  test("the instant is `now`'s ISO string, in UTC, with milliseconds", () => {
    expect(stamp('{"markedAt":"deploy"}', new Date("2026-03-01T04:05:06.007+02:00"))).toBe('{"markedAt":"2026-03-01T02:05:06.007Z"}');
  });
});

describe("countDeploy(text)", () => {
  test("counts what stamp would replace", () => {
    expect(countDeploy(SAMPLE)).toBe(2);
    expect(countDeploy(stamp(SAMPLE, NOW))).toBe(0);
    expect(countDeploy("")).toBe(0);
    expect(countDeploy('{"mark": "deploy"}')).toBe(0);
  });
});

describe("the command line: node tools/testplan-stamp.mjs [file]", () => {
  const dir = mkdtempSync(join(tmpdir(), "testplan-stamp-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args: string[]) => execFileSync(process.execPath, [TOOL, ...args], { encoding: "utf8", cwd: dir });

  test("rewrites the file in place, line endings included, and prints how many marks it replaced", () => {
    const file = join(dir, "crlf.json");
    const crlf = SAMPLE.replaceAll("\n", "\r\n");
    writeFileSync(file, crlf);
    const out = run(file);
    expect(out).toContain('replaced 2 "deploy" marks');
    const written = readFileSync(file, "utf8");
    // the first and the third mark are the run's instant (the moment of the run, the same for both); the second kept its own
    const instants = [...written.matchAll(/"markedAt": "([^"]+)"/g)].map((m) => m[1]);
    expect(instants).toHaveLength(3);
    expect(instants[1]).toBe("2026-10-20T09:00:00.000Z");
    expect(instants[2]).toBe(instants[0]);
    expect(Math.abs(Date.now() - Date.parse(instants[0]))).toBeLessThan(60_000);
    // and nothing else changed: the CRLF line endings are all still there
    expect(written).toBe(crlf.replaceAll('"markedAt": "deploy"', `"markedAt": "${instants[0]}"`));
  });

  test("a file with no \"deploy\" is left alone and the count is 0", () => {
    const file = join(dir, "clean.json");
    const text = SAMPLE.replaceAll('"markedAt": "deploy"', '"markedAt": "2026-10-21T00:00:00.000Z"');
    writeFileSync(file, text);
    expect(run(file)).toContain('replaced 0 "deploy" marks');
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  test("a file that does not exist is an error, not a silent 0", () => {
    expect(() => execFileSync(process.execPath, [TOOL, join(dir, "puudub.json")], { stdio: "pipe" })).toThrow();
  });

  test("without a file it takes the plan: src/data/testplan.json of the app, wherever it is run from", () => {
    expect(PLAN_FILE).toBe(resolve(process.cwd(), "src/data/testplan.json"));
    expect(existsSync(PLAN_FILE)).toBe(true);
  });
});

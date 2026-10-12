import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeStaleMark } from "../e2e/prod-build";

// The switch file of the e2e run's production build (tests/e2e/prod-build.ts writeStaleMark; page-cache.cjs reads it on every page lookup). Every
// worker that writes to the database writes it. Truncating it and writing it again (writeFileSync's default) leaves it EMPTY for a moment, and
// the cache that read it then took "empty" for "nothing was ever revalidated": a page stored before a test's change was served after it. So the
// time is written over the old one, in place, at a fixed width. (Under a reader and a writer loop of two processes the truncating write left the
// file empty for 2 193 of 5 137 reads.)

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mslab-stale-mark-"));
  file = join(dir, "sub", "e2e-stale-pages");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeStaleMark", () => {
  test("creates the file (and its folder) when it is not there: 13 digits", () => {
    writeStaleMark(file, 1_791_829_538_721);
    expect(readFileSync(file, "utf8")).toBe("1791829538721");
  });

  test("writes over the old time in place at the same width, and the mark never goes back", () => {
    writeStaleMark(file, 1_791_829_538_721);
    writeStaleMark(file, 1_791_829_538_900);
    expect(readFileSync(file, "utf8")).toBe("1791829538900");
    writeStaleMark(file, 1_791_829_538_800); // a worker that was late
    expect(readFileSync(file, "utf8")).toBe("1791829538900");
  });

  test("a file that is empty or not a time is written over", () => {
    writeStaleMark(file, 1_791_829_538_721);
    writeFileSync(file, "");
    writeStaleMark(file, 1_791_829_538_722);
    expect(readFileSync(file, "utf8")).toBe("1791829538722");
    writeFileSync(file, "soon");
    writeStaleMark(file, 1_791_829_538_723);
    expect(readFileSync(file, "utf8")).toBe("1791829538723");
  });

  test("a reader in another process never finds it empty or short while it is written over about a thousand times a second", async () => {
    writeStaleMark(file);
    const reader = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("fs"); const file = process.argv[1]; const end = Date.now() + 1500; let reads = 0, bad = 0;
         while (Date.now() < end) { const t = fs.readFileSync(file, "utf8"); reads++; if (!/^[0-9]{13}$/.test(t)) bad++; }
         console.log(JSON.stringify({ reads, bad }));`,
        file,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    reader.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    const done = new Promise<void>((resolve) => reader.on("exit", () => resolve()));
    const end = Date.now() + 1300;
    let writes = 0;
    while (Date.now() < end) {
      writeStaleMark(file);
      writes++;
    }
    await done;
    const seen = JSON.parse(out) as { reads: number; bad: number };
    expect(writes).toBeGreaterThan(500);
    expect(seen.reads).toBeGreaterThan(500);
    expect(seen.bad, `reads of ${seen.reads} that found the file empty or not 13 digits`).toBe(0);
  });
});

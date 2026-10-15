import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// The certificate's two fonts and their licences (phase 3d, spec §7) are committed exactly as downloaded from google/fonts on 15.10.2026
// (ofl/greatvibes and ofl/jost, each folder's OFL.txt beside its font): byte for byte, so a changed or truncated file, or a checkout that
// converted line endings, fails here and not in a student's PDF. The root .gitattributes keeps git from converting them. The two packages
// that draw the PDF are pinned exactly, as the spike of 15.10 proved them with these fonts.

const FONTS = join(process.cwd(), "assets", "fonts");
const SHA256: Record<string, string> = {
  "GreatVibes-Regular.ttf": "8d509802186f1b51572531ecf313e8098f9a5bfdfaca93f0c9b34467f9982d15",
  "Jost[wght].ttf": "6343b70971000b04c5d401c96ae08ce371086135e999d5e1e1413039c0213076",
  "OFL-GreatVibes.txt": "61093a21f5e63dedf54222b3c09997e54c0fe43e3851d21386e02ddcbc246d49",
  "OFL-Jost.txt": "1af3438a4d5f0ed2bdbc5751a5a67ebf6d537334161184b7fbb68503ef0ea0c5",
};

test("the folder holds exactly the two fonts and their licences, byte for byte as downloaded (SHA-256)", () => {
  expect(readdirSync(FONTS).sort()).toEqual(Object.keys(SHA256).sort());
  for (const [name, hash] of Object.entries(SHA256)) expect(createHash("sha256").update(readFileSync(join(FONTS, name))).digest("hex"), name).toBe(hash);
});

test("the licences are the SIL Open Font License 1.1 of each font", () => {
  for (const [name, font] of [["OFL-GreatVibes.txt", "Great Vibes"], ["OFL-Jost.txt", "Jost"]]) {
    const text = readFileSync(join(FONTS, name), "utf8");
    expect(text, name).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(text, name).toContain(font);
  }
});

test("pdf-lib and its fontkit are pinned exactly (no range), in package.json and in the lock", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
  expect([pkg.dependencies["pdf-lib"], pkg.dependencies["@pdf-lib/fontkit"]]).toEqual(["1.17.1", "1.1.1"]);
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { version: string }> };
  expect([lock.packages["node_modules/pdf-lib"].version, lock.packages["node_modules/@pdf-lib/fontkit"].version]).toEqual(["1.17.1", "1.1.1"]);
});

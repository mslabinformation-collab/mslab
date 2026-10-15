import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CERT_FONTS } from "@/server/certificate-pdf";

// The certificate's fonts (phase 3d, spec §7) are committed exactly as obtained, byte for byte, so a changed or truncated file, or a checkout
// that converted line endings, fails here and not in a student's PDF; the root .gitattributes keeps git from converting them.
// - Jost (the sans: the heading, the texts) comes from google/fonts on 15.10.2026 (ofl/jost, with that folder's OFL.txt beside it): open source.
// - Revive 80 Signature (the script: the student's name and Maria's signature) is © Tom Chalky / Inspiration Hut, the font of Maria's Canva
//   certificates. It is licensed to MS LAB for its certificates (the owner, 15.10.2026), NOT open source: it is never copied out of this
//   folder, and the repository is private before anything is deployed.
// The two packages that draw the PDF are pinned exactly, as the spike of 15.10 proved them with these fonts.

const FONTS = join(process.cwd(), "assets", "fonts");
const SHA256: Record<string, string> = {
  [CERT_FONTS.sans]: "6343b70971000b04c5d401c96ae08ce371086135e999d5e1e1413039c0213076",
  [CERT_FONTS.script]: "f864b644c4382edf7d30a67d8b345b64e0a8bb632b76c6b2091249c384556bba",
  "OFL-Jost.txt": "1af3438a4d5f0ed2bdbc5751a5a67ebf6d537334161184b7fbb68503ef0ea0c5",
};

test("the folder holds exactly the two fonts and Jost's licence, byte for byte as obtained (SHA-256)", () => {
  expect(readdirSync(FONTS).sort()).toEqual(["Jost[wght].ttf", "OFL-Jost.txt", "Revive80Signature.otf"]);
  expect(Object.keys(SHA256).sort()).toEqual(readdirSync(FONTS).sort());
  for (const [name, hash] of Object.entries(SHA256)) expect(createHash("sha256").update(readFileSync(join(FONTS, name))).digest("hex"), name).toBe(hash);
});

test("Jost's licence is the SIL Open Font License 1.1 (Revive 80 Signature is licensed, not open: it has no OFL text)", () => {
  const text = readFileSync(join(FONTS, "OFL-Jost.txt"), "utf8");
  expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
  expect(text).toContain("Jost");
});

test("pdf-lib and its fontkit are pinned exactly (no range), in package.json and in the lock", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
  expect([pkg.dependencies["pdf-lib"], pkg.dependencies["@pdf-lib/fontkit"]]).toEqual(["1.17.1", "1.1.1"]);
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { version: string }> };
  expect([lock.packages["node_modules/pdf-lib"].version, lock.packages["node_modules/@pdf-lib/fontkit"].version]).toEqual(["1.17.1", "1.1.1"]);
});

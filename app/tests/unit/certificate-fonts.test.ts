import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { expect, test } from "vitest";
import { CERT_FONTS } from "@/server/certificate-pdf";

// The certificate's fonts (phase 3d, spec §7) are committed exactly as obtained, byte for byte, so a changed or truncated file, or a checkout
// that converted line endings, fails here and not in a student's PDF; the root .gitattributes keeps git from converting them.
// - Jost (the sans: the logo, the invoice and the contract, the letters the body font lacks) comes from google/fonts on 15.10.2026 (ofl/jost,
//   with that folder's OFL.txt beside it): open source.
// - Glacial Indifference (the body: the heading and the certificate's lines, as on Maria's Canva certificate) comes from Font Squirrel on
//   07.11.2026 (fontsquirrel.com/fonts/glacial-indifference: the zip's GlacialIndifference-Regular.otf, version 1.01, and its
//   "SIL Open Font License.txt" as OFL-GlacialIndifference.txt): open source, © 2015 Alfredo Marco Pradil, the copyright in the font's names.
// - Montserrat (the course title) comes from JulietaUla/Montserrat on 07.11.2026 (fonts/ttf/Montserrat-Regular.ttf, the static Regular: the
//   variable font's default is Thin, which pdf-lib would draw; the repository's OFL.txt as OFL-Montserrat.txt): open source.
// - Revive 80 Signature (the script: the student's name and Maria's signature) is © Tom Chalky / Inspiration Hut, the font of Maria's Canva
//   certificates. It is licensed to MS LAB for its certificates (the owner, 15.10.2026), NOT open source: it is never copied out of this
//   folder, and the repository is private before anything is deployed.
// The two packages that draw the PDF are pinned exactly, as the spike of 15.10 proved them with these fonts.

const FONTS = join(process.cwd(), "assets", "fonts");
const SHA256: Record<string, string> = {
  [CERT_FONTS.sans]: "6343b70971000b04c5d401c96ae08ce371086135e999d5e1e1413039c0213076",
  [CERT_FONTS.script]: "f864b644c4382edf7d30a67d8b345b64e0a8bb632b76c6b2091249c384556bba",
  "OFL-Jost.txt": "1af3438a4d5f0ed2bdbc5751a5a67ebf6d537334161184b7fbb68503ef0ea0c5",
  [CERT_FONTS.body]: "0818598f079819bd5921445a11b76d276e68987a1cc4bd183b9bc5517befcfcc",
  "OFL-GlacialIndifference.txt": "130b55d0f6564114388c1ddaa88a517a945155bcb6344439f879aaa07ba19b81",
  [CERT_FONTS.title]: "3e8abe50c44c82e2242e97d1ec8c0d385c4890cdc50447bcdb8605c81a38cfb2",
  "OFL-Montserrat.txt": "8b7141c03fa4f8d44e6345d5d4931709290f0f67875e452e95ac1fd3a027802e",
};

test("the folder holds exactly the four fonts and the three open fonts' licences, byte for byte as obtained (SHA-256)", () => {
  expect(readdirSync(FONTS).sort()).toEqual([
    "GlacialIndifference-Regular.otf",
    "Jost[wght].ttf",
    "Montserrat-Regular.ttf",
    "OFL-GlacialIndifference.txt",
    "OFL-Jost.txt",
    "OFL-Montserrat.txt",
    "Revive80Signature.otf",
  ]);
  expect(Object.keys(SHA256).sort()).toEqual(readdirSync(FONTS).sort());
  for (const [name, hash] of Object.entries(SHA256)) expect(createHash("sha256").update(readFileSync(join(FONTS, name))).digest("hex"), name).toBe(hash);
});

test("Jost's, Glacial Indifference's and Montserrat's licences are the SIL Open Font License 1.1 (Revive 80 Signature is licensed, not open: it has no OFL text)", () => {
  for (const [file, name] of [["OFL-Jost.txt", "Jost"], ["OFL-Montserrat.txt", "Montserrat"]] as const) {
    const text = readFileSync(join(FONTS, file), "utf8");
    expect(text, file).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(text, file).toContain(name);
  }
  // Font Squirrel's text names no font; the font itself carries its copyright and licence (the name table's licence description)
  expect(readFileSync(join(FONTS, "OFL-GlacialIndifference.txt"), "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
  // (fontkit reads the name table; its typings leave getName out)
  const glacial = fontkit.create(readFileSync(join(FONTS, CERT_FONTS.body))) as unknown as { getName(key: string): string | null };
  expect(glacial.getName("license")).toContain("with Reserved Font Name Glacial Indifference");
  expect(glacial.getName("license")).toContain("SIL Open Font License, Version 1.1");
});

test("pdf-lib and its fontkit are pinned exactly (no range), in package.json and in the lock", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
  expect([pkg.dependencies["pdf-lib"], pkg.dependencies["@pdf-lib/fontkit"]]).toEqual(["1.17.1", "1.1.1"]);
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { version: string }> };
  expect([lock.packages["node_modules/pdf-lib"].version, lock.packages["node_modules/@pdf-lib/fontkit"].version]).toEqual(["1.17.1", "1.1.1"]);
});

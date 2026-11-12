import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

// A registration's money is its total: the live list price less the euros frozen on it (domain/discount-codes.ts registrationTotal). A path that
// reads the list price itself (listPrice, or a course's `price`) would measure what is paid, due and offered against a number the student never
// saw once a discount code is on the registration. So the list price is read only where it is shown (the course page, the cart) or where the total
// is made, and these lists say where, by file. (Comments go first: they name the functions too.)
const LIST_PRICE_ALLOWED = ["src/app/[locale]/(site)/koolitused/[slug]/page.tsx", "src/app/[locale]/(site)/ostukorv/cart.tsx", "src/db/demo-data.ts", "src/domain/discount-codes.ts", "src/domain/registration.ts"];
const COURSE_PRICE_ALLOWED = ["src/domain/registration.ts", "src/app/[locale]/(site)/koolitused/[slug]/page.tsx", "src/app/[locale]/(site)/ostukorv/cart.tsx", "src/server/submit.ts", "src/lib/structured-data.ts" /* SEO G5: the list price shown in the course page's data */];

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
const sources = files(SRC).map((file) => ({
  file: relative(ROOT, file).replace(/\\/g, "/"),
  // (a "//" after a colon is a URL)
  text: readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, ""),
}));
const filesMatching = (pattern: RegExp): string[] => sources.filter((s) => pattern.test(s.text)).map((s) => s.file);

test("listPrice is called only where a list price is shown or the total is made", () => {
  const callers = filesMatching(/\blistPrice\(/);
  expect(callers.length, "the scan finds the calls").toBeGreaterThan(2);
  expect(callers.filter((f) => !LIST_PRICE_ALLOWED.includes(f))).toEqual([]);
});

test("registrationPrice is gone", () => {
  expect(filesMatching(/\bregistrationPrice\b/)).toEqual([]);
});

test("course.price is read directly only in the allowed files", () => {
  const readers = filesMatching(/\bcourse\.price\b/);
  expect(readers.length, "the scan finds the reads").toBeGreaterThan(2);
  expect(readers.filter((f) => !COURSE_PRICE_ALLOWED.includes(f))).toEqual([]);
});

test("in submit.ts, course.price is read only inside handleEcoursePurchase", () => {
  const text = sources.find((s) => s.file === "src/server/submit.ts")!.text;
  const start = text.indexOf("export function handleEcoursePurchase");
  const next = text.indexOf("export function", start + 1);
  expect(start).toBeGreaterThan(-1);
  const stray = [...text.matchAll(/\bcourse\.price\b/g)].filter((m) => m.index < start || (next !== -1 && m.index > next));
  expect(text.match(/\bcourse\.price\b/g)?.length, "the scan finds the reads").toBeGreaterThan(0);
  expect(stray.map((m) => m.index)).toEqual([]);
});

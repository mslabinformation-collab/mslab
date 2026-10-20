import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

// The day's count of every mail the site sends ("<day>:all", client-auth.ts countSentMail) is what a newsletter campaign measures its room by
// (domain/newsletter-campaign.ts CAMPAIGN_DAILY_ROOM): a mail path that forgets to pass its database to sendMail is a mail the count never sees,
// and the campaign would overshoot Resend's 100 a day. So every call of the functions that send a mail (sendMail, notifyMaria, and the two
// that call notifyMaria or sendMail for their callers, mailCompletion and notifyFeedback) must pass `count`. A caller with no database says so
// here, by name, with the reason.
const CALLS = /\b(sendMail|notifyMaria|mailCompletion|notifyFeedback)\(/g;
const WITHOUT_DATABASE: string[] = [];

const SRC = join(process.cwd(), "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });

/** The text of a call's arguments, from the opening parenthesis at `open` to its match. */
function argumentsAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error("an unclosed call");
}

test("every call that sends a mail passes the database of the day's mail count", () => {
  const found: string[] = [];
  const missing: string[] = [];
  for (const file of files(SRC)) {
    // (comments go first: they name the functions too; "//" after a colon is a URL)
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
    for (const match of source.matchAll(CALLS)) {
      const before = source.slice(Math.max(0, match.index - 10), match.index);
      if (/function\s+$/.test(before)) continue; // the definition
      const label = `${relative(SRC, file).replace(/\\/g, "/")}: ${match[1]}`;
      found.push(label);
      if (!/\bcount\b/.test(argumentsAt(source, match.index + match[0].length - 1)) && !WITHOUT_DATABASE.includes(label)) missing.push(label);
    }
  }
  expect(found.length, "the scan finds the calls").toBeGreaterThan(20);
  expect(missing).toEqual([]);
});

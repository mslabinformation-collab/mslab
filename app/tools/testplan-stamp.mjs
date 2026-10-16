// Stamps the test plan's "deploy" marks with the current instant (phase 4, piece 1, spec §6 "The plan follows the code").
//
//   node tools/testplan-stamp.mjs [file]   (run from app/; default src/data/testplan.json, wherever it is run from)
//
// A check that changed meaning carries "markedAt": "deploy" while it sits on a branch. A mark means the deploy that carried it (an answer given
// while the branch waited was about the old site), so right before the push to main this replaces every "markedAt": "deploy" with the current
// instant, and the result is committed with the merge. It rewrites the file in place and prints how many marks it replaced; a file without any
// is left untouched. Nothing else in the text changes, byte for byte (line endings, the BOM and the spacing around the colon included): it is a
// text replacement, not a JSON round trip. If it is skipped, the server reads a "deploy" it still finds as the running deployment's build time
// (next.config.ts TESTPLAN_BUILD_AT), which reopens the checks at that deploy and again at the next one, until this tool stamps them.
// docs/deploy.md names it in the deploy steps.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The plan the tool stamps when it is given no file. */
export const PLAN_FILE = fileURLToPath(new URL("../src/data/testplan.json", import.meta.url));

/** A markedAt whose value is exactly "deploy": the key and the colon with their spacing are kept (group 1), only the value is replaced. */
const DEPLOY_MARK = /("markedAt"\s*:\s*)"deploy"/g;

/** How many "markedAt": "deploy" marks the text holds: what `stamp` replaces. */
export function countDeploy(/** @type {string} */ text) {
  return [...text.matchAll(DEPLOY_MARK)].length;
}

/** The text with every "markedAt": "deploy" replaced by `now`'s ISO instant, and nothing else changed. */
export function stamp(/** @type {string} */ text, /** @type {Date} */ now) {
  const instant = now.toISOString();
  return text.replace(DEPLOY_MARK, (_mark, key) => `${key}"${instant}"`);
}

function main() {
  const file = process.argv[2] ?? PLAN_FILE;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    console.error(`testplan-stamp: cannot read ${file}: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  const n = countDeploy(text);
  const marks = `${n} "deploy" mark${n === 1 ? "" : "s"}`;
  if (n === 0) {
    console.log(`testplan-stamp: replaced ${marks} in ${file} (file untouched)`);
    return;
  }
  const now = new Date();
  writeFileSync(file, stamp(text, now));
  console.log(`testplan-stamp: replaced ${marks} with ${now.toISOString()} in ${file}`);
}

// Run as a command, not when a test imports it. (Both sides are real paths: node resolves the entry file's symlinks.)
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main();

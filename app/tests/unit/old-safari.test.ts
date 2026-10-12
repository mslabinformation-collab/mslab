import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// The course day's screen runs on Maria's tablet and the account's pages on the students' phones: iOS Safari before 16.4 cannot parse a
// regular expression with a lookbehind, and one such literal stops the whole script. The phase's browser files have none, and they never
// import src/lib/storable.ts, whose LONE_SURROGATE has one (older code, left as it is): lib/to-storable.ts is the browser's text cleaning.
// Each task adds its browser files here.

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
];
const LOOKBEHIND = new RegExp(["\\(\\?<", "="].join("") + "|" + ["\\(\\?<", "!"].join(""));
const STORABLE_IMPORT = /from "(@\/lib\/storable|(\.\.?\/)+(lib\/)?storable)"/;

test("no lookbehind in the phase's browser files, and none of them imports lib/storable", () => {
  for (const f of BROWSER_FILES) {
    const source = readFileSync(join(process.cwd(), f), "utf8");
    expect(source, f).not.toMatch(LOOKBEHIND);
    expect(source, f).not.toMatch(STORABLE_IMPORT);
  }
});

test("the check sees a lookbehind", () => {
  expect("/(?" + "<!x)y/").toMatch(LOOKBEHIND);
  expect('import { storable } from "@/lib/storable";').toMatch(STORABLE_IMPORT);
});

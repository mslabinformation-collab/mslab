import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// UX pass 11.11 A14 (the Vaiksed board): the admin's add buttons read one way, „Lisa … +“ — the „+“ after the words („Lisa koolitus +“,
// „Lisa rida +“), never before them („+ Lisa rida“) and never missing on a button that opens or adds a new thing. Read from the components' sources:
// no JSX text starts with „+ {…}“ (Seaded's contract chips „+ nimi“ are not add buttons: they put a word into the text).
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });

describe("add buttons: „Lisa … +“ (UX pass A14)", () => {
  it("no admin component writes the „+“ before an add button's words", () => {
    const before = files(join(process.cwd(), "src", "components", "admin"))
      .concat(files(join(process.cwd(), "src", "app", "admin")))
      .filter((p) => !p.endsWith("ContractTexts.tsx"))
      .flatMap((p) =>
        readFileSync(p, "utf8")
          .split(/\r?\n/)
          .map((line, i) => [p, i + 1, line] as const)
          .filter(([, , line]) => /^\s*\+ \{|`\+ \$\{/.test(line)),
      );
    expect(before).toEqual([]);
  });

  // UX audit 2 A27: „Uus sooduskood +“ (Sooduskoodid's page button) and „Lisa laekumine +“ (the registration drawer's Raha card) were ui.btn's 49 px; they
  // are the 44 px add button (ui.smallBtn), their words as they are. Read from the sources: the element that carries the data attribute has the class.
  it.each([
    ["„Uus sooduskood +“", join("src", "app", "admin", "(panel)", "sooduskoodid", "page.tsx"), "data-add-code"],
    ["„Lisa laekumine +“", join("src", "components", "admin", "MoneyCard.tsx"), "data-add-payment="],
  ])("%s is the 44 px add button (ui.smallBtn)", (_name, file, attr) => {
    const tag = readFileSync(join(process.cwd(), file), "utf8")
      .split(/\r?\n/)
      .find((line) => line.includes(attr));
    expect(tag, attr).toBeDefined();
    expect(tag).toMatch(/className=\{`\$\{ui\.btn\} \$\{ui\.smallBtn\}/);
  });

  // „Lisa moodul +“ / „Lisa punkt +“ of Moodulid stood 48 px tall beside its field; every add button is ui.smallBtn's 44 px
  it("no stylesheet makes the lessons' add button taller than the others", () => {
    const css = readFileSync(join(process.cwd(), "src", "components", "admin", "LessonsEditor.module.css"), "utf8");
    expect(css).not.toMatch(/\.add > button\s*\{[^}]*min-height/);
  });
});

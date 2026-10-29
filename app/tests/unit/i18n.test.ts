import { describe, expect, test } from "vitest";
import { pick, pickList } from "@/i18n/field";
import { href, publicPath, switchLocaleHref } from "@/i18n/href";
import { fill, formatSize, pluralForm } from "@/i18n/format";
import { LOCALES, getDict } from "@/i18n/locales";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";
import { adminEt } from "@/i18n/dict/admin";

const keys = (o: object, p = ""): string[] =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v, p + k + ".") : [p + k]));
const leaves = (o: object, p = ""): [string, string][] =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? leaves(v, p + k + ".") : [[p + k, String(v)] as [string, string]]));

describe("i18n", () => {
  test("pick falls back to et", () => {
    expect(pick({ et: "Tere", ru: "Привет" }, "ru")).toBe("Привет");
    expect(pick({ et: "Tere" }, "ru")).toBe("Tere");
    expect(pick({ et: "Tere", ru: "  " }, "ru")).toBe("Tere");
    expect(pick(null, "et")).toBe("");
  });
  test("pickList", () => expect(pickList([{ et: "a", ru: "б" }, { et: "c" }], "ru")).toEqual(["б", "c"]));
  test("href", () => {
    expect(href("et", "/koolitused")).toBe("/koolitused");
    expect(href("ru", "/koolitused")).toBe("/ru/koolitused");
    expect(href("ru", "/")).toBe("/ru");
  });
  test("switchLocaleHref", () => {
    expect(switchLocaleHref("/ru/praktika", "et")).toBe("/praktika");
    expect(switchLocaleHref("/praktika", "ru")).toBe("/ru/praktika");
    expect(switchLocaleHref("/", "ru")).toBe("/ru");
  });
  test("publicPath drops the internal /et prefix only", () => {
    expect(publicPath("/et")).toBe("/");
    expect(publicPath("/et/konto")).toBe("/konto");
    expect(publicPath("/konto")).toBe("/konto");
    expect(publicPath("/etude")).toBe("/etude");
    expect(publicPath("/ru/konto")).toBe("/ru/konto");
    expect(publicPath("/")).toBe("/");
  });
  test("ru dictionary has every et key", () => {
    expect(keys(ru).sort()).toEqual(keys(et).sort());
  });
  test("getDict returns the dictionary of the locale", () => {
    expect(LOCALES).toEqual(["et", "ru"]);
    expect(getDict("et")).toBe(et);
    expect(getDict("ru")).toBe(ru);
  });
});

describe("dictionary content", () => {
  test("no empty strings", () => {
    for (const [name, dict] of [["et", et], ["ru", ru]] as const)
      for (const [k, v] of leaves(dict)) expect(v.trim(), `${name}.${k}`).not.toBe("");
  });
  test("ru uses the same {placeholders} as et", () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    const ruLeaves = new Map(leaves(ru));
    for (const [k, v] of leaves(et)) expect(vars(ruLeaves.get(k)!), k).toEqual(vars(v));
  });
  test("ru is actually translated (Cyrillic) wherever et has five or more words", () => {
    const ruLeaves = new Map(leaves(ru));
    for (const [k, v] of leaves(et)) if (v.split(/\s+/).length > 4) expect(ruLeaves.get(k)!, k).toMatch(/[А-Яа-яЁё]/);
  });
  test("no AI tool names in client-facing strings", () => {
    for (const [k, v] of [...leaves(et), ...leaves(ru)]) expect(v, k).not.toMatch(/claude|anthropic|gpt|openai|lovable|chatgpt/i);
  });
});

describe("fill", () => {
  test("replaces known placeholders and leaves unknown ones", () => {
    expect(fill("© {year} MS LAB", { year: 2026 })).toBe("© 2026 MS LAB");
    expect(fill("{a}-{b}", { a: "x" })).toBe("x-{b}");
    expect(fill("no placeholders", {})).toBe("no placeholders");
  });
});

describe("pluralForm", () => {
  test("Estonian: the singular for 1 alone (1 päev, 21 päeva); Russian: 1, 21, 31 … „one“, 2–4, 22–24 … „few“, the rest (0, 5–20, 11–14, 25 …) „many“", () => {
    expect([1, 2, 5, 11, 21, 30, 101].map((n) => pluralForm(n, "et"))).toEqual(["one", "many", "many", "many", "many", "many", "many"]);
    expect([1, 21, 31, 101, 121].map((n) => pluralForm(n, "ru"))).toEqual(["one", "one", "one", "one", "one"]);
    expect([2, 3, 4, 22, 24, 102, 334].map((n) => pluralForm(n, "ru"))).toEqual(["few", "few", "few", "few", "few", "few", "few"]);
    expect([0, 5, 9, 10, 11, 12, 13, 14, 19, 20, 25, 30, 111, 112, 114, 365].map((n) => pluralForm(n, "ru"))).toEqual(Array(16).fill("many"));
  });
});

describe("formatSize", () => {
  test("formatSize: kB under a megabyte (at least 1), MB with one decimal, in the page's language", () => {
    expect(formatSize(820_000, "et")).toBe("820 kB");
    expect(formatSize(12, "et")).toBe("1 kB");
    expect(formatSize(1_400_000, "et")).toBe("1,4 MB");
    expect(formatSize(1_400_000, "ru")).toBe("1,4 МБ");
    expect(formatSize(820_000, "ru")).toBe("820 КБ");
  });

  test("the edges: nothing is 1 kB, a size that rounds to 1000 kB is 1 MB, whole megabytes have no decimal", () => {
    expect(formatSize(0, "et")).toBe("1 kB");
    expect(formatSize(999_499, "et")).toBe("999 kB");
    expect(formatSize(999_600, "et")).toBe("1 MB");
    expect(formatSize(4_000_000, "ru")).toBe("4 МБ");
    expect(formatSize(3_960_000, "et")).toBe("4 MB");
  });
});

describe("admin dictionary (Estonian only)", () => {
  test("no empty strings, no AI tool names, and the placeholders the code fills are there", () => {
    for (const [k, v] of leaves(adminEt)) {
      expect(v.trim(), k).not.toBe("");
      expect(v, k).not.toMatch(/claude|anthropic|gpt|openai|lovable|chatgpt/i);
    }
    expect(adminEt.mail.text).toContain("{link}");
    expect(adminEt.panel.hello).toBe("Tere, {name}.");
  });
  test("the login e-mail and the neutral answer say what the brief says", () => {
    expect(adminEt.mail.subject).toBe("MS LAB — sisselogimislink");
    // piece 4c, S4-47c: the sent state names the address typed, the same for any address (SPEC S4); {email} is filled by LoginForm
    expect(adminEt.login.sent).toBe("Saatsime lingi aadressile {email}. See kehtib 15 minutit.");
    expect(adminEt.login.submit).toBe("Saada sisselogimislink");
  });
});

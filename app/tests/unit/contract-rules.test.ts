import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CONTRACT_CONTACT_KEY, CONTRACT_CONTACT_VERSION_KEY, PLACEHOLDERS, contractDownloadHeaders, contractFileName, contractLocale, contractValues, fillContract,
  paymentText, schoolOf, sessionText,
  type ContractFields,
} from "@/domain/contract";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";

// The contract's pure rules (contracts, Task 1; spec §2 D1–D7, §3): the placeholders Maria may write and how they are filled, the language a
// contract is made in, the session and payment texts, the download's file name and headers, and the school block when Arve andmed is empty.

const VALUES = { nimi: "Kati Kask", "e-post": "kati@example.test", koolitus: "Kulmude kujundus", toimumine: "14.11.2026, Tallinn", hind: "350,00 €", ettemaks: "175,00 €" };

describe("the keys and the placeholders (spec §2 D2)", () => {
  test("as the spec and the plan name them", () => {
    expect(CONTRACT_CONTACT_KEY).toBe("contract_contact");
    expect(CONTRACT_CONTACT_VERSION_KEY).toBe("contractContactVersion");
    expect([...PLACEHOLDERS]).toEqual(["nimi", "e-post", "koolitus", "toimumine", "hind", "ettemaks"]);
  });
});

describe("fillContract: the placeholders filled at acceptance (D2)", () => {
  test("every placeholder is filled", () => {
    const text = "Õpilane {nimi} ({e-post}) osaleb koolitusel {koolitus}, {toimumine}. Hind {hind}, ettemaks {ettemaks}.";
    expect(fillContract(text, VALUES)).toBe(
      "Õpilane Kati Kask (kati@example.test) osaleb koolitusel Kulmude kujundus, 14.11.2026, Tallinn. Hind 350,00 €, ettemaks 175,00 €.",
    );
    for (const name of PLACEHOLDERS) expect(fillContract(`{${name}}`, VALUES)).toBe(VALUES[name]);
  });

  test("a placeholder used twice is filled twice, and a text without any is as it was", () => {
    expect(fillContract("{nimi} / {nimi}", VALUES)).toBe("Kati Kask / Kati Kask");
    const plain = "Pooled lepivad kokku.\n\nTeine lõik, ilma kohtadeta.";
    expect(fillContract(plain, VALUES)).toBe(plain);
    expect(fillContract("", VALUES)).toBe("");
  });

  test("an unknown {x} stays as typed", () => {
    expect(fillContract("Tere {kliendi nimi}, {nimi}! {x}{y}", VALUES)).toBe("Tere {kliendi nimi}, Kati Kask! {x}{y}");
    expect(fillContract("{}", VALUES)).toBe("{}");
    expect(fillContract("{ nimi }", VALUES)).toBe("{ nimi }");
  });

  test("the names are exact: another case or a word of the object's prototype stays as typed", () => {
    expect(fillContract("{Nimi} {NIMI} {E-post}", VALUES)).toBe("{Nimi} {NIMI} {E-post}");
    for (const own of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) expect(fillContract(`{${own}}`, VALUES), own).toBe(`{${own}}`);
  });

  test("a lone { or } and an unclosed placeholder stay as typed", () => {
    expect(fillContract("a { b", VALUES)).toBe("a { b");
    expect(fillContract("a } b", VALUES)).toBe("a } b");
    expect(fillContract("{nimi", VALUES)).toBe("{nimi");
    expect(fillContract("nimi}", VALUES)).toBe("nimi}");
    expect(fillContract("{ {nimi} }", VALUES)).toBe("{ Kati Kask }");
    expect(fillContract("{{nimi}}", VALUES)).toBe("{Kati Kask}");
    expect(fillContract("{nimi} {", VALUES)).toBe("Kati Kask {");
  });

  test("a value containing a placeholder is not filled again", () => {
    const tricky = { ...VALUES, nimi: "{hind}", koolitus: "{nimi}" };
    expect(fillContract("{nimi} / {hind}", tricky)).toBe("{hind} / 350,00 €");
    expect(fillContract("{koolitus} {nimi}", tricky)).toBe("{nimi} {hind}");
  });

  test("a value is inserted as it is: no $ pattern of String.replace works in it", () => {
    const dollars = { ...VALUES, nimi: "$& $1 $$ $` $'" };
    expect(fillContract("[{nimi}]", dollars)).toBe("[$& $1 $$ $` $']");
  });

  test("a line break in the text is kept, and a placeholder never reaches across one", () => {
    expect(fillContract("a\n{nimi}\nb", VALUES)).toBe("a\nKati Kask\nb");
    expect(fillContract("{ni\nmi}", VALUES)).toBe("{ni\nmi}");
  });
});

describe("contractValues: the fields of a contract as the placeholders' values", () => {
  const fields: ContractFields = {
    school: { company: "MS LAB OÜ", registryCode: "12345678", address: "Pärnu mnt 1, Tallinn" },
    student: { name: "Kati Kask", email: "kati@example.test" },
    course: "Kulmude kujundus", session: "14.11.2026, Tallinn", price: "350,00 €", payment: "50% registreerimisel + 50% koolituspäeval",
  };
  test("name, e-mail, course, session and price from the fields; the prepayment as given", () => {
    expect(contractValues(fields, "175,00 €")).toEqual(VALUES);
  });
  test("every placeholder has a value, and no other key is there", () => {
    expect(Object.keys(contractValues(fields, "")).sort()).toEqual([...PLACEHOLDERS].sort());
    expect(contractValues({ ...fields, session: "", price: "" }, "")).toEqual({ ...VALUES, toimumine: "", hind: "", ettemaks: "" });
  });
});

describe("contractLocale: the language she read (D6)", () => {
  test("RU only when she registered in RU and the RU text exists", () => {
    expect(contractLocale("ru", true)).toBe("ru");
    expect(contractLocale("ru", false)).toBe("et");
    expect(contractLocale("et", true)).toBe("et");
    expect(contractLocale("et", false)).toBe("et");
  });
});

describe("sessionText: the date and place of a session, Tallinn's calendar (D2 {toimumine})", () => {
  const at = (startsAt: string, more: { city?: string; venue?: string } = {}) => sessionText({ startsAt: new Date(startsAt), city: "Tallinn", ...more });

  test("none is empty", () => {
    expect(sessionText(null)).toBe("");
  });
  test("the date, a comma and the city", () => {
    expect(at("2026-11-14T08:00:00Z")).toBe("14.11.2026, Tallinn");
  });
  test("the date is Tallinn's: 21:59 UTC in winter is still the day, 22:00 UTC is the next", () => {
    expect(at("2026-11-14T21:59:00Z")).toBe("14.11.2026, Tallinn");
    expect(at("2026-11-14T22:00:00Z")).toBe("15.11.2026, Tallinn");
  });
  test("in summer time the turn is at 21:00 UTC", () => {
    expect(at("2027-06-05T20:59:00Z")).toBe("05.06.2027, Tallinn");
    expect(at("2027-06-05T21:00:00Z")).toBe("06.06.2027, Tallinn");
  });
  test("the year turns at Tallinn's midnight", () => {
    expect(at("2026-12-31T22:00:00Z")).toBe("01.01.2027, Tallinn");
  });
  test("the venue follows the city when there is one", () => {
    expect(at("2026-11-14T08:00:00Z", { venue: "Pärnu mnt 1" })).toBe("14.11.2026, Tallinn, Pärnu mnt 1");
    expect(at("2026-11-14T08:00:00Z", { venue: "" })).toBe("14.11.2026, Tallinn");
    expect(at("2026-11-14T08:00:00Z", { venue: "  " })).toBe("14.11.2026, Tallinn");
  });
  test("the texts are trimmed, and a session without a city is the date alone", () => {
    expect(at("2026-11-14T08:00:00Z", { city: "  Tartu ", venue: " Kesk 2 " })).toBe("14.11.2026, Tartu, Kesk 2");
    expect(at("2026-11-14T08:00:00Z", { city: "" })).toBe("14.11.2026");
    expect(at("2026-11-14T08:00:00Z", { city: " ", venue: "Kesk 2" })).toBe("14.11.2026, Kesk 2");
  });
});

describe("paymentText: the payment choice in the language of the contract", () => {
  test("the words of the registration form's two choices", () => {
    expect(paymentText("full", "et")).toBe(et.forms.payFull);
    expect(paymentText("half", "et")).toBe(et.forms.payHalf);
    expect(paymentText("full", "ru")).toBe(ru.forms.payFull);
    expect(paymentText("half", "ru")).toBe(ru.forms.payHalf);
    expect(paymentText("half", "et")).toBe("50% registreerimisel + 50% koolituspäeval");
  });
  test("no choice (an e-course) is empty", () => {
    expect(paymentText(null, "et")).toBe("");
    expect(paymentText(null, "ru")).toBe("");
  });
});

describe("the download: file name and headers", () => {
  test("MS-LAB-leping-{id}.pdf", () => {
    expect(contractFileName(7)).toBe("MS-LAB-leping-7.pdf");
    expect(contractFileName(1234)).toBe("MS-LAB-leping-1234.pdf");
  });
  test("the type, the file name and nosniff (the caller adds private, no-store)", () => {
    expect(contractDownloadHeaders(7)).toEqual({
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="MS-LAB-leping-7.pdf"',
      "x-content-type-options": "nosniff",
    });
  });
});

describe("schoolOf: the school block from Seaded → Arve andmed (spec §6)", () => {
  test("the company, its registry code and its address as set", () => {
    expect(schoolOf({ company: "MS LAB OÜ", registryCode: "12345678", address: "Pärnu mnt 1, Tallinn" })).toEqual({
      company: "MS LAB OÜ", registryCode: "12345678", address: "Pärnu mnt 1, Tallinn",
    });
  });
  test("an empty company is \"MS LAB\": the contract says nothing false", () => {
    expect(schoolOf({ company: "", registryCode: "", address: "" })).toEqual({ company: "MS LAB", registryCode: "", address: "" });
    expect(schoolOf({ company: "   ", registryCode: "", address: "" }).company).toBe("MS LAB");
  });
  test("only the three fields are taken from the whole setting", () => {
    const whole = { company: "MS LAB OÜ", registryCode: "1", address: "A", vatNumber: "EE1", vatOn: true, prefix: "MSL", footer: "Täname!" };
    expect(schoolOf(whole)).toEqual({ company: "MS LAB OÜ", registryCode: "1", address: "A" });
  });
});

describe("the module stays pure: the preview in the browser imports it (Task 4)", () => {
  const source = readFileSync("src/domain/contract.ts", "utf8");
  const imports = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);

  test("it imports no server, no database and no node module", () => {
    for (const spec of imports) {
      expect(spec, spec).not.toMatch(/^@\/server\b/);
      expect(spec, spec).not.toMatch(/^@\/db\b/);
      expect(spec, spec).not.toMatch(/^node:/);
    }
    expect(source).not.toMatch(/\brequire\(/);
  });
  test("it holds no lookbehind and no Object.hasOwn (iOS Safari before 16.4)", () => {
    expect(source).not.toMatch(new RegExp(["\\(\\?<", "="].join("") + "|" + ["\\(\\?<", "!"].join("")));
    expect(source).not.toContain(["Object", "hasOwn"].join("."));
  });
});

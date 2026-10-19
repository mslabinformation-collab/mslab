import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CAMPAIGN_LIMITS, CONTACTS_WARN_AT, RESEND_FREE_CONTACTS, campaignContentFor, checkCampaignDraft, ruFallsBack, type CampaignDraft,
} from "@/domain/newsletter-campaign";

// The newsletter campaign's pure rules (newsletter campaigns, Task 1; spec D4, D8, §5): the limits, the draft Maria's editor sends checked
// field by field, and the text a subscriber of each language gets (the Estonian one as a whole when the Russian subject or text is empty,
// Review Focus 5). The mail built from it is tests/unit/campaign-mail.test.ts. Not to be confused with domain/campaign.ts, the home page's popup.

const ok = (raw: unknown) => {
  const r = checkCampaignDraft(raw);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.fields)}`);
  return r.value;
};
const refused = (raw: unknown) => {
  const r = checkCampaignDraft(raw);
  if (r.ok) throw new Error("accepted");
  return r.fields;
};

/** What the editor sends for a campaign with only what is required. */
const minimal = { name: "Oktoobri pakkumine", subject: { et: "Sügispakkumine" }, body: { et: "Tere!" } };
/** A complete draft: every field filled in both languages. */
const full = {
  name: "Oktoobri pakkumine",
  subject: { et: "Sügispakkumine", ru: "Осеннее предложение" },
  preheader: { et: "−15% kõigile koolitustele", ru: "−15% на все курсы" },
  imageKey: "img/flyer.jpg",
  body: { et: "Esimene lõik.\n\nTeine lõik.", ru: "Первый абзац.\n\nВторой абзац." },
  code: "SUGIS15",
  buttonLabel: { et: "Vaata koolitusi", ru: "Смотреть курсы" },
  buttonHref: "/koolitused",
};
const draft = (over: Partial<CampaignDraft> = {}): CampaignDraft => ({ ...ok(full), ...over });

describe("the limits", () => {
  test("the brief's values, and Resend's free plan: 1000 contacts, a warning at 900", () => {
    expect(CAMPAIGN_LIMITS).toEqual({ name: 80, subject: 150, preheader: 150, body: 10000, buttonLabel: 40, href: 500 });
    expect(RESEND_FREE_CONTACTS).toBe(1000);
    expect(CONTACTS_WARN_AT).toBe(900);
  });
});

describe("checkCampaignDraft: what is accepted", () => {
  test("only the name, the Estonian subject and the Estonian text are required: the rest comes back empty (\"\" or null)", () => {
    expect(ok(minimal)).toEqual({
      name: "Oktoobri pakkumine",
      subject: { et: "Sügispakkumine", ru: "" },
      preheader: { et: "", ru: "" },
      imageKey: null,
      body: { et: "Tere!", ru: "" },
      code: null,
      buttonLabel: null,
      buttonHref: null,
    });
  });

  test("a complete draft comes back as it was written", () => {
    expect(ok(full)).toEqual(full);
  });

  test("texts are trimmed; blank optional fields become empty / null; keys it does not know are left out", () => {
    const value = ok({
      name: "  Nimi  ", subject: { et: " Teema ", ru: "   " }, preheader: { et: "\t", ru: "" }, imageKey: "  ", body: { et: "\n Tekst \n", ru: "" },
      code: "   ", buttonLabel: { et: "", ru: "" }, buttonHref: "", status: "sent", id: 7, extra: { a: 1 },
    });
    expect(value).toEqual({
      name: "Nimi", subject: { et: "Teema", ru: "" }, preheader: { et: "", ru: "" }, imageKey: null, body: { et: "Tekst", ru: "" },
      code: null, buttonLabel: null, buttonHref: null,
    });
  });

  test("null for every optional field is the same as leaving it out", () => {
    expect(ok({ ...minimal, preheader: null, imageKey: null, code: null, buttonLabel: null, buttonHref: null })).toEqual(ok(minimal));
  });

  test("every field may be exactly as long as its limit", () => {
    const value = ok({
      name: "n".repeat(80),
      subject: { et: "s".repeat(150), ru: "с".repeat(150) },
      preheader: { et: "p".repeat(150), ru: "п".repeat(150) },
      body: { et: "b".repeat(10000), ru: "б".repeat(10000) },
      buttonLabel: { et: "l".repeat(40), ru: "л".repeat(40) },
      buttonHref: `https://mslab.example/${"a".repeat(500 - "https://mslab.example/".length)}`,
    });
    expect(value.name).toHaveLength(80);
    expect(value.body.ru).toHaveLength(10000);
    expect(value.buttonHref).toHaveLength(500);
  });
});

describe("checkCampaignDraft: what is refused", () => {
  test("anything but an object is { form: invalid }", () => {
    for (const raw of [undefined, null, "x", 7, [], true]) expect(refused(raw)).toEqual({ form: "invalid" });
  });

  test("the name, the Estonian subject and the Estonian text are required (missing, empty or only white space)", () => {
    expect(refused({})).toEqual({ name: "required", "subject.et": "required", "body.et": "required" });
    expect(refused({ name: "   ", subject: { et: "" }, body: { et: "\n \n" } })).toEqual({ name: "required", "subject.et": "required", "body.et": "required" });
    expect(refused({ name: "n", subject: { ru: "Тема" }, body: { ru: "Текст" } })).toEqual({ "subject.et": "required", "body.et": "required" }); // (Russian alone is not enough)
    expect(refused({ ...minimal, name: undefined })).toEqual({ name: "required" });
  });

  test("a text over its limit is tooLong, named by field and language; one over is refused, never cut", () => {
    const over = {
      name: "n".repeat(81),
      subject: { et: "s".repeat(151), ru: "с".repeat(151) },
      preheader: { et: "p".repeat(151), ru: "п".repeat(151) },
      body: { et: "b".repeat(10001), ru: "б".repeat(10001) },
      buttonLabel: { et: "l".repeat(41), ru: "л".repeat(41) },
      buttonHref: `https://mslab.example/${"a".repeat(501 - "https://mslab.example/".length)}`,
    };
    expect(refused(over)).toEqual({
      name: "tooLong", "subject.et": "tooLong", "subject.ru": "tooLong", "preheader.et": "tooLong", "preheader.ru": "tooLong",
      "body.et": "tooLong", "body.ru": "tooLong", "buttonLabel.et": "tooLong", "buttonLabel.ru": "tooLong", buttonHref: "tooLong",
    });
  });

  test("the limit counts the text as it is kept (trimmed), not as typed", () => {
    expect(ok({ ...minimal, name: `  ${"n".repeat(80)}  ` }).name).toHaveLength(80);
    expect(refused({ ...minimal, name: `  ${"n".repeat(81)}  ` })).toEqual({ name: "tooLong" });
  });

  test("a value that is not a text is invalid", () => {
    expect(refused({ ...minimal, name: 7 })).toEqual({ name: "invalid" });
    expect(refused({ ...minimal, subject: { et: 7 } })).toEqual({ "subject.et": "invalid" });
    expect(refused({ ...minimal, body: { et: ["a"] } })).toEqual({ "body.et": "invalid" });
    expect(refused({ ...minimal, preheader: { et: "", ru: {} } })).toEqual({ "preheader.ru": "invalid" });
    expect(refused({ ...minimal, imageKey: 3 })).toEqual({ imageKey: "invalid" });
    expect(refused({ ...minimal, code: 12345 })).toEqual({ code: "invalid" });
    expect(refused({ ...minimal, buttonHref: ["/"], buttonLabel: { et: "Ava" } })).toEqual({ buttonHref: "invalid" });
  });

  test("a bilingual field that is not an object is invalid as a whole (a plain string is not { et, ru })", () => {
    expect(refused({ ...minimal, subject: "Teema" })).toEqual({ subject: "invalid" });
    expect(refused({ ...minimal, body: ["a"] })).toEqual({ body: "invalid" });
    expect(refused({ ...minimal, preheader: 5 })).toEqual({ preheader: "invalid" });
    expect(refused({ ...minimal, buttonLabel: "Ava", buttonHref: "/" })).toEqual({ buttonLabel: "invalid" });
  });

  test("every wrong field is named at once", () => {
    expect(refused({ name: "", subject: { et: "s".repeat(151) }, body: { et: "t" }, code: "tere 10" })).toEqual({ name: "required", "subject.et": "tooLong", code: "invalid" });
  });
});

describe("the code", () => {
  test("it has the welcome code's shape (A–Z, 0–9 and -, at most 30), in capitals as stored: what is typed in small letters is raised", () => {
    expect(ok({ ...minimal, code: "SUGIS15" }).code).toBe("SUGIS15");
    expect(ok({ ...minimal, code: " sugis-15 " }).code).toBe("SUGIS-15");
    expect(ok({ ...minimal, code: "A".repeat(30) }).code).toBe("A".repeat(30));
  });

  test("a space inside, other punctuation, a letter outside A–Z and more than 30 characters are refused", () => {
    for (const code of ["TERE 10", "TERE_10", "TERE.10", "TERE+10", "ÕUN10", "КОД", "TERE10!", "<b>"]) expect(refused({ ...minimal, code }), code).toEqual({ code: "invalid" });
    expect(refused({ ...minimal, code: "A".repeat(31) })).toEqual({ code: "tooLong" });
  });
});

describe("the button", () => {
  test("it needs both the Estonian label and the address; with neither there is no button", () => {
    expect(ok({ ...minimal, buttonLabel: { et: "Ava" }, buttonHref: "/koolitused" })).toMatchObject({ buttonLabel: { et: "Ava", ru: "" }, buttonHref: "/koolitused" });
    expect(refused({ ...minimal, buttonLabel: { et: "Ava" } })).toEqual({ buttonHref: "required" });
    expect(refused({ ...minimal, buttonHref: "/koolitused" })).toEqual({ "buttonLabel.et": "required" });
    expect(refused({ ...minimal, buttonLabel: { et: "", ru: "" }, buttonHref: "/koolitused" })).toEqual({ "buttonLabel.et": "required" });
    // a Russian label alone starts a button too: the Estonian label and the address are then missing
    expect(refused({ ...minimal, buttonLabel: { et: "", ru: "Открыть" } })).toEqual({ "buttonLabel.et": "required", buttonHref: "required" });
    expect(ok({ ...minimal, buttonLabel: { et: "", ru: "" }, buttonHref: "" })).toMatchObject({ buttonLabel: null, buttonHref: null });
  });

  test("the address is an https:// address or a path of this site that starts with a single /", () => {
    for (const href of ["https://mslab.ee/koolitused", "https://www.example.com/a?b=1&c=2#d", "/koolitused", "/praktika#taotlus", "/", "/koolitused/kulmud?x=1"]) {
      expect(ok({ ...minimal, buttonLabel: { et: "Ava" }, buttonHref: href }).buttonHref, href).toBe(href);
    }
    const bad = [
      "javascript:alert(1)", "data:text/html,x", "mailto:maria@example.test", "http://mslab.ee/", "//evil.example/x", "/\\evil.example", "koolitused", "www.mslab.ee",
      "https://", "https://nodot", "https://user:pw@mslab.ee/", "/a b", "/a\"b", "/a<b", "https://mslab.ee/a b", "ftp://mslab.ee/",
    ];
    for (const href of bad) expect(refused({ ...minimal, buttonLabel: { et: "Ava" }, buttonHref: href }), href).toEqual({ buttonHref: "invalid" });
  });
});

describe("control characters are cleaned and newlines are kept", () => {
  test("a control character pasted into any text is dropped (NUL, BEL, ESC, DEL), the text around it stays", () => {
    const value = ok({
      name: "Ni\u0000mi", subject: { et: "Te\u0007ema", ru: "Те\u001bма" }, preheader: { et: "Ee\u007fl", ru: "" },
      body: { et: "Te\u0000kst", ru: "Текст\u0008" }, buttonLabel: { et: "A\u0001va", ru: "" }, buttonHref: "/koolitused", code: "AB\u0000C",
    });
    expect(value).toMatchObject({ name: "Nimi", subject: { et: "Teema", ru: "Тема" }, preheader: { et: "Eel" }, body: { et: "Tekst", ru: "Текст" }, buttonLabel: { et: "Ava" }, code: "ABC" });
  });

  test("the text keeps its line breaks, a blank line between paragraphs included; Windows line breaks become \\n; Word's line and page breaks become line breaks", () => {
    expect(ok({ ...minimal, body: { et: "Üks\r\n\r\nKaks\rKolm\u000bNeli\u000cViis" } }).body.et).toBe("Üks\n\nKaks\nKolm\nNeli\nViis");
    expect(ok({ ...minimal, body: { et: "Üks\n\n\nKaks" } }).body.et).toBe("Üks\n\n\nKaks");
  });

  test("a one-line text (name, subject, preview line, button label) has no line break in it: a break or a tab becomes one space", () => {
    const value = ok({ ...minimal, name: "Üks\nkaks", subject: { et: "Teema\r\nteine\trida", ru: "" }, preheader: { et: "Eel\n\neel", ru: "" }, buttonLabel: { et: "Ava\nsiit" }, buttonHref: "/" });
    expect(value).toMatchObject({ name: "Üks kaks", subject: { et: "Teema teine rida" }, preheader: { et: "Eel eel" }, buttonLabel: { et: "Ava siit" } });
  });

  test("a no-break space stays (Russian typography), and a surrogate that stands alone is dropped while a pair stays", () => {
    expect(ok({ ...minimal, subject: { et: "Teema", ru: "Скидка на курс" } }).subject.ru).toBe("Скидка на курс");
    expect(ok({ ...minimal, body: { et: "a\ud800b \u{1f338}" } }).body.et).toBe("ab \u{1f338}");
  });

  test("a text that is only control characters is empty: a required one is then missing", () => {
    expect(refused({ ...minimal, name: "\u0000\u0007" })).toEqual({ name: "required" });
  });
});

describe("campaignContentFor: the text a subscriber gets", () => {
  test("Estonian: the Estonian texts; the body in paragraphs (a blank line starts a new one), the button label", () => {
    expect(campaignContentFor(draft(), "et")).toEqual({
      locale: "et",
      subject: "Sügispakkumine",
      preheader: "−15% kõigile koolitustele",
      paragraphs: ["Esimene lõik.", "Teine lõik."],
      buttonLabel: "Vaata koolitusi",
    });
  });

  test("Russian: the Russian texts, all of them", () => {
    expect(campaignContentFor(draft(), "ru")).toEqual({
      locale: "ru",
      subject: "Осеннее предложение",
      preheader: "−15% на все курсы",
      paragraphs: ["Первый абзац.", "Второй абзац."],
      buttonLabel: "Смотреть курсы",
    });
  });

  test("paragraphs: single line breaks stay inside a paragraph, any number of blank lines is one split, nothing empty is left", () => {
    const c = draft({ body: { et: "Rida üks\nrida kaks\n\n\n\nTeine\n \nKolmas\n\n", ru: "" } });
    expect(campaignContentFor(c, "et").paragraphs).toEqual(["Rida üks\nrida kaks", "Teine", "Kolmas"]);
  });

  test("a Russian subscriber gets the Estonian mail as a whole when the Russian subject is empty: no Russian preview line or label is mixed into it", () => {
    const c = draft({ subject: { et: "Sügispakkumine", ru: "" } });
    expect(campaignContentFor(c, "ru")).toEqual(campaignContentFor(c, "et"));
    expect(campaignContentFor(c, "ru").locale).toBe("et");
    expect(campaignContentFor(c, "ru").preheader).toBe("−15% kõigile koolitustele");
    expect(campaignContentFor(c, "ru").buttonLabel).toBe("Vaata koolitusi");
  });

  test("the same when the Russian text is empty, or only white space (and the Russian subject is there)", () => {
    for (const ru of ["", "  \n \n ", undefined]) {
      const c = draft({ body: { et: "Esimene lõik.\n\nTeine lõik.", ru } });
      expect(campaignContentFor(c, "ru"), String(ru)).toEqual(campaignContentFor(c, "et"));
    }
    expect(campaignContentFor(draft({ subject: { et: "S" } }), "ru").locale).toBe("et"); // (a Russian subject that is missing altogether)
  });

  test("the Estonian subscriber is never moved: Estonian stays Estonian whatever the Russian fields hold", () => {
    expect(campaignContentFor(draft({ subject: { et: "Sügispakkumine", ru: "" } }), "et").locale).toBe("et");
    expect(campaignContentFor(draft({ body: { et: "Tere", ru: "" } }), "et").paragraphs).toEqual(["Tere"]);
  });

  test("the Russian mail with its own subject and text but no Russian preview line or label has none: nothing Estonian is borrowed", () => {
    const c = draft({ preheader: { et: "Eesti eelrida", ru: "" }, buttonLabel: { et: "Vaata", ru: "" } });
    const content = campaignContentFor(c, "ru");
    expect(content.locale).toBe("ru");
    expect(content.subject).toBe("Осеннее предложение");
    expect(content.preheader).toBe("");
    expect(content.buttonLabel).toBeNull();
  });

  test("a campaign with no button has no label", () => {
    expect(campaignContentFor(draft({ buttonLabel: null, buttonHref: null }), "et").buttonLabel).toBeNull();
    expect(campaignContentFor(draft({ buttonLabel: null, buttonHref: null }), "ru").buttonLabel).toBeNull();
  });

  test("a row as the database returns it (a Russian side that was never stored) works too", () => {
    const stored = { ...draft(), subject: { et: "Teema" }, preheader: { et: "" }, body: { et: "Tekst" } } as CampaignDraft;
    expect(campaignContentFor(stored, "ru")).toMatchObject({ locale: "et", subject: "Teema", preheader: "", paragraphs: ["Tekst"] });
  });
});

describe("ruFallsBack: Maria is told before sending", () => {
  test("true when the Russian subject or the Russian text is empty, false when both are written", () => {
    expect(ruFallsBack(draft())).toBe(false);
    expect(ruFallsBack(draft({ subject: { et: "S", ru: "" } }))).toBe(true);
    expect(ruFallsBack(draft({ body: { et: "T", ru: " " } }))).toBe(true);
    expect(ruFallsBack(draft({ subject: { et: "S" }, body: { et: "T" } }))).toBe(true);
    expect(ruFallsBack(ok(minimal))).toBe(true);
  });

  test("the preview line and the button label do not decide it (they are optional)", () => {
    expect(ruFallsBack(draft({ preheader: { et: "E", ru: "" } }))).toBe(false);
    expect(ruFallsBack(draft({ buttonLabel: { et: "Ava", ru: "" } }))).toBe(false);
  });

  test("it agrees with campaignContentFor: the Russian mail is the Estonian one exactly when it is true", () => {
    for (const c of [draft(), draft({ subject: { et: "S", ru: "" } }), draft({ body: { et: "T", ru: "" } }), ok(minimal)]) {
      expect(campaignContentFor(c, "ru").locale === "et").toBe(ruFallsBack(c));
    }
  });
});

describe("the module stays pure: the editor imports it in the browser", () => {
  const source = readFileSync("src/domain/newsletter-campaign.ts", "utf8");
  const imports = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);

  test("it imports no server, no database and no node module", () => {
    expect(imports.length).toBeGreaterThan(0);
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

  test("it takes the code's shape from domain/welcome-code.ts and the paragraph split from domain/catalogue.ts, not copies of them", () => {
    expect(imports).toContain("./welcome-code");
    expect(imports).toContain("./catalogue");
    expect(source).not.toContain("A-Z0-9");
  });
});

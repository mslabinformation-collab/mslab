import { describe, expect, test } from "vitest";
import { missingCase, partChangeLabels, sameSiteValue, siteFieldLabel } from "@/domain/site-changes";

// The site editors' field labels (admin UX pass piece 4a; piece4-texts S4-1, S4-2, S4-12, S4-17, S4-34; ruling R-i): the first version, which the
// publish's blocked answer uses (server/site-drafts.ts); the PublishBar's row-by-row differ builds on it.

describe("siteFieldLabel: S4-1's label of a field, by its path in the part's editor value", () => {
  test("Avaleht (S4-12): a slide's fields by its place from 1, its focal points as its picture; the FAQ's rows; the lists and the texts by their card", () => {
    const home = (part: string, path: string) => siteFieldLabel("home", part, path);
    expect(home("slides", "slides.2.imageKey")).toBe("Slaid 3 pilt");
    expect(home("slides", "slides.0.imagePos")).toBe("Slaid 1 pilt");
    expect(home("slides", "slides.0.imagePosMobile")).toBe("Slaid 1 pilt");
    expect(["kicker", "title", "text", "ctaLabel", "ctaHref", "tone", "active"].map((f) => home("slides", `slides.1.${f}`))).toEqual([
      "Slaid 2 väike pealkiri",
      "Slaid 2 pealkiri",
      "Slaid 2 alapealkiri",
      "Slaid 2 nupu tekst",
      "Slaid 2 nupp viib",
      "Slaid 2 toon",
      "Slaid 2 näidatakse avalehel",
    ]);
    expect(home("slides", "slides")).toBe("Slaidid");
    expect(home("slides", "slides.2")).toBe("Slaidid");
    expect(home("statement", "body")).toBe("MS LABi lause");
    expect(home("teaser", "body")).toBe("Koolitaja kaart");
    expect(home("faq", "faq.3.q")).toBe("KKK küsimus 4");
    expect(home("faq", "faq.5.a")).toBe("KKK vastus 6");
    expect(home("faq", "faq")).toBe("KKK");
  });

  test("Koolitaja (S4-17): the portrait with its focal point, name, role, every stat as „Numbrid“; the bio, the gallery and the stories by their names", () => {
    const trainer = (part: string, path: string) => siteFieldLabel("trainer", part, path);
    expect(["portraitKey", "portraitPos", "name", "role", "stats", "stats.1.label"].map((f) => trainer("trainer", f))).toEqual(["Portree", "Portree", "Nimi", "Amet", "Numbrid", "Numbrid"]);
    expect(trainer("bio", "body")).toBe("Tutvustus");
    expect(trainer("works", "works.4.key")).toBe("Galerii");
    expect(trainer("works", "works")).toBe("Galerii");
    expect(trainer("center_story", "title")).toBe("Koolituskeskuse lugu");
    expect(trainer("trainer_journey", "body")).toBe("Koolitaja teekond");
  });

  test("Praktika (S4-34): the package's code before each field; a point by its place from 1; the points as a whole", () => {
    expect(["name", "tagline", "models", "durationLabel", "price"].map((f) => siteFieldLabel("practice", "MAXI", f))).toEqual(["MAXI nimi", "MAXI lühitekst", "MAXI modelle", "MAXI kestus", "MAXI hind"]);
    expect(siteFieldLabel("practice", "MAXI", "items.3")).toBe("MAXI punkt 4");
    expect(siteFieldLabel("practice", "MINI", "items")).toBe("MINI punktid");
  });
});

describe("missingCase: S4-2's casing for „Puudub: …“", () => {
  test("the first letter in lower case, except a first word in capitals (KKK, MINI, MAXI, MS LAB)", () => {
    expect(["Slaid 3 pilt", "KKK vastus 6", "MAXI hind", "MINI punkt 2", "Nimi", "MS LABi lause", "Koolitaja kaart", "Portree"].map(missingCase)).toEqual([
      "slaid 3 pilt",
      "KKK vastus 6",
      "MAXI hind",
      "MINI punkt 2",
      "nimi",
      "MS LABi lause",
      "koolitaja kaart",
      "portree",
    ]);
  });
});

describe("sameSiteValue and partChangeLabels", () => {
  test("a text with no Russian side and one with it empty are the same; any other difference is not", () => {
    expect(sameSiteValue({ name: { et: "MINI" } }, { name: { et: "MINI", ru: "" } })).toBe(true);
    expect(sameSiteValue({ faq: [{ uid: "f1", q: { et: "A" } }] }, { faq: [{ uid: "f1", q: { et: "A", ru: "" } }] })).toBe(true);
    expect(sameSiteValue({ name: { et: "MINI" } }, { name: { et: "MINI", ru: " " } })).toBe(false);
    expect(sameSiteValue({ name: { et: "MINI" } }, { name: { et: "MAXI" } })).toBe(false);
    expect(sameSiteValue({ price: "100" }, { price: "100", models: "2" })).toBe(false);
  });

  test("the changed fields' labels, in the fields' order, once each; a changed list by its card's title", () => {
    const live = { portraitKey: "/seed/a.jpg", portraitPos: "50% 50%", name: { et: "Maria" }, role: { et: "" }, stats: [] };
    expect(partChangeLabels("trainer", "trainer", live, { ...live, portraitPos: "40% 30%", portraitKey: "img/x.jpg", name: { et: "Maria S." } })).toEqual(["Portree", "Nimi"]);
    expect(partChangeLabels("trainer", "trainer", live, { ...live, role: { et: "", ru: "" } })).toEqual([]);
    const pkg = { name: { et: "MAXI" }, tagline: { et: "" }, models: "4", durationLabel: { et: "8 ak" }, price: "150", items: [{ et: "a" }] };
    expect(partChangeLabels("practice", "MAXI", pkg, { ...pkg, price: "155", items: [{ et: "a" }, { et: "b" }] })).toEqual(["MAXI hind", "MAXI punktid"]);
    expect(partChangeLabels("home", "slides", { slides: [{ uid: "s1" }] }, { slides: [] })).toEqual(["Slaidid"]);
  });
});

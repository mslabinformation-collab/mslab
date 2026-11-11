import { describe, expect, test } from "vitest";
import {
  bookableCities,
  catalogueSearch,
  firstSentence,
  hasPickableSession,
  initialSession,
  matchesCatalogue,
  normalizeSearch,
  paragraphs,
  parseCatalogueQuery,
} from "@/domain/catalogue";
import { parseFavourites, toggleFavourite } from "@/lib/favourites";

describe("catalogue query", () => {
  test("parses vorm and tase, ignores anything else", () => {
    expect(parseCatalogueQuery({})).toEqual({ vorm: "all", tase: "all", otsi: "", valdkond: "", hybrid: false });
    expect(parseCatalogueQuery({ vorm: "e", tase: "baas", otsi: "lami" })).toEqual({ vorm: "e", tase: "baas", otsi: "lami", valdkond: "", hybrid: false });
    expect(parseCatalogueQuery({ vorm: "k", tase: "taiend" })).toEqual({ vorm: "k", tase: "taiend", otsi: "", valdkond: "", hybrid: false });
    expect(parseCatalogueQuery({ vorm: ["k", "e"], tase: "x" })).toEqual({ vorm: "k", tase: "all", otsi: "", valdkond: "", hybrid: false });
    expect(parseCatalogueQuery({ otsi: "x".repeat(300) }).otsi).toHaveLength(100);
  });
  test("?valdkond is read as written (the chips decide whether it is one of theirs: domain/course-areas.ts parseArea); a long one is cut", () => {
    expect(parseCatalogueQuery({ valdkond: "kulmukoolitused" })).toEqual({ vorm: "all", tase: "all", otsi: "", valdkond: "kulmukoolitused", hybrid: false });
    expect(parseCatalogueQuery({ valdkond: ["ripsmekoolitused", "kulmukoolitused"] }).valdkond).toBe("ripsmekoolitused");
    expect(parseCatalogueQuery({ valdkond: "x".repeat(300) }).valdkond).toHaveLength(100);
  });
  test("vorm=h is not a filter: all courses, hybrid explanation open (K1)", () => {
    expect(parseCatalogueQuery({ vorm: "h" })).toEqual({ vorm: "all", tase: "all", otsi: "", valdkond: "", hybrid: true });
  });
  test("search string", () => {
    expect(catalogueSearch({ vorm: "all", tase: "all" })).toBe("");
    expect(catalogueSearch({ vorm: "e", tase: "all" })).toBe("?vorm=e");
    expect(catalogueSearch({ vorm: "k", tase: "taiend" })).toBe("?vorm=k&tase=taiend");
    expect(catalogueSearch({ vorm: "all", tase: "baas" })).toBe("?tase=baas");
    expect(catalogueSearch({ vorm: "e", tase: "all", otsi: "kulmude lami" })).toBe("?vorm=e&otsi=kulmude+lami");
    expect(catalogueSearch({ vorm: "all", tase: "all", otsi: "  " })).toBe("");
    // the area after the level (the chip rows' order), the search last
    expect(catalogueSearch({ vorm: "k", tase: "baas", valdkond: "kulmukoolitused", otsi: "lami" })).toBe("?vorm=k&tase=baas&valdkond=kulmukoolitused&otsi=lami");
    expect(catalogueSearch({ vorm: "all", tase: "all", valdkond: "" })).toBe("");
  });
});

describe("catalogue filter", () => {
  const brow = { type: "contact" as const, level: "basic" as const, text: normalizeSearch("Kulmumeistri baaskoolitus Tugev vundament") };
  const shape = { type: "e_learning" as const, level: "advanced" as const, text: normalizeSearch("Kulmukuju ja sümmeetria") };
  test("format and level", () => {
    expect(matchesCatalogue(brow, { vorm: "all", tase: "all", search: "" })).toBe(true);
    expect(matchesCatalogue(brow, { vorm: "e", tase: "all", search: "" })).toBe(false);
    expect(matchesCatalogue(brow, { vorm: "k", tase: "baas", search: "" })).toBe(true);
    expect(matchesCatalogue(brow, { vorm: "k", tase: "taiend", search: "" })).toBe(false);
    expect(matchesCatalogue(shape, { vorm: "e", tase: "taiend", search: "" })).toBe(true);
  });
  test("search ignores case, diacritics and extra spaces", () => {
    expect(matchesCatalogue(shape, { vorm: "all", tase: "all", search: "SUMMEETRIA" })).toBe(true);
    expect(matchesCatalogue(shape, { vorm: "all", tase: "all", search: "  kulmukuju   ja " })).toBe(true);
    expect(matchesCatalogue(brow, { vorm: "all", tase: "all", search: "vundament" })).toBe(true);
    expect(matchesCatalogue(brow, { vorm: "all", tase: "all", search: "ripsmed" })).toBe(false);
  });
  test("the area (?valdkond): only the courses of that area; a course without one only under „Kõik“; combined with the others (AND)", () => {
    const browArea = { ...brow, area: "kulmukoolitused" };
    const lash = { type: "e_learning" as const, level: "basic" as const, text: normalizeSearch("Ripsmete laminatsiooni alused"), area: "ripsmekoolitused" };
    const none = { ...shape, area: null };
    const all = { vorm: "all" as const, tase: "all" as const, search: "" };
    expect([browArea, lash, none].map((c) => matchesCatalogue(c, { ...all, area: null }))).toEqual([true, true, true]);
    expect([browArea, lash, none].map((c) => matchesCatalogue(c, { ...all, area: "kulmukoolitused" }))).toEqual([true, false, false]);
    expect(matchesCatalogue(lash, { ...all, vorm: "e", area: "ripsmekoolitused" })).toBe(true);
    expect(matchesCatalogue(lash, { ...all, vorm: "k", area: "ripsmekoolitused" })).toBe(false);
    expect(matchesCatalogue(lash, { ...all, search: "kulm", area: "ripsmekoolitused" })).toBe(false);
    // an item that names no area is one without
    expect(matchesCatalogue(brow, { ...all, area: "kulmukoolitused" })).toBe(false);
  });
  test("normalizeSearch", () => expect(normalizeSearch(" Õppevorm  ÄÖÜ š ")).toBe("oppevorm aou s"));
});

describe("course page rules", () => {
  test("firstSentence", () => {
    expect(firstSentence("E-õpe tähendab videokoolitust. Ostuga luuakse konto.")).toBe("E-õpe tähendab videokoolitust.");
    expect(firstSentence("Üks lause ilma punktita")).toBe("Üks lause ilma punktita");
  });
  test("group registration needs a pickable session", () => {
    expect(hasPickableSession([])).toBe(false);
    expect(hasPickableSession([{ disabled: true }, { disabled: true }])).toBe(false);
    expect(hasPickableSession([{ disabled: true }, { disabled: false }])).toBe(true);
  });
  test("bookable cities keep date order, once each, without cancelled sessions", () => {
    expect(
      bookableCities([
        { city: "Pärnu", status: "scheduled" },
        { city: "Tartu", status: "cancelled" },
        { city: "Pärnu", status: "scheduled" },
        { city: "Tallinn ", status: "scheduled" },
      ]),
    ).toEqual(["Pärnu", "Tallinn"]);
  });
  test("initial session from ?sessioon only when it can be picked", () => {
    const s = [
      { id: 5, disabled: false },
      { id: 6, disabled: true },
    ];
    expect(initialSession(s, "5")).toBe(5);
    expect(initialSession(s, ["5"])).toBe(5);
    expect(initialSession(s, "6")).toBeNull();
    expect(initialSession(s, "7")).toBeNull();
    expect(initialSession(s, "abc")).toBeNull();
    expect(initialSession(s, undefined)).toBeNull();
  });
  test("paragraphs", () => expect(paragraphs("Üks.\n\n  Kaks.\n \nKolm.")).toEqual(["Üks.", "Kaks.", "Kolm."]));
});

describe("favourites", () => {
  test("parse is defensive", () => {
    expect(parseFavourites(null)).toEqual([]);
    expect(parseFavourites("not json")).toEqual([]);
    expect(parseFavourites('{"a":1}')).toEqual([]);
    expect(parseFavourites('["a", 3, "", "b", "a"]')).toEqual(["a", "b"]);
  });
  test("toggle adds and removes", () => {
    expect(toggleFavourite([], "lami")).toEqual(["lami"]);
    expect(toggleFavourite(["x", "lami"], "lami")).toEqual(["x"]);
  });
});

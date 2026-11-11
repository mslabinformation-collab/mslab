import { describe, expect, test } from "vitest";
import { AREA_LIMITS, areaChips, areaNameProblems, areaSlug, cleanAreaName, parseArea } from "@/domain/course-areas";

// The training areas' pure rules (spec 2026-11-11-course-areas-filter-design.md §4.1, §5): the slug in the URL (?valdkond=), a name's check (both
// languages required, at most 60 characters, one line), the filter chips (only the areas the list has, shown only for two or more, in Maria's order)
// and the address read back (an unknown or old slug is „Kõik“).

const kulm = { id: 1, slug: "kulmukoolitused", label: "Kulmukoolitused" };
const rips = { id: 2, slug: "ripsmekoolitused", label: "Ripsmekoolitused" };
const meik = { id: 3, slug: "meigikoolitused", label: "Meigikoolitused" };

describe("the slug", () => {
  test("is the Estonian name as the city's (lowercase, no diacritics, spaces as dashes); the Russian page uses the same", () => {
    expect(areaSlug({ et: "Kulmukoolitused" })).toBe("kulmukoolitused");
    expect(areaSlug({ et: " Ripsmed ja  kulmud " })).toBe("ripsmed-ja-kulmud");
    expect(areaSlug({ et: "Näo- ja Kehahooldus" })).toBe("nao--ja-kehahooldus");
    expect(areaSlug({ et: "Šõõž" })).toBe("sooz");
  });
});

describe("a name", () => {
  test("is one line, trimmed, without what Postgres cannot store", () => {
    expect(cleanAreaName("  Kulmu\nkoolitused \u0000")).toBe("Kulmu koolitused");
    expect(cleanAreaName("\r\n")).toBe("");
    // (a run of spaces is one: a pasted „Kulmud\n ja …“ is „Kulmud ja …“)
    expect(cleanAreaName("Kulmud \n  ja\tlaminatsioon")).toBe("Kulmud ja laminatsioon");
  });
  test("both languages are required and at most 60 characters (after the clean-up)", () => {
    expect(AREA_LIMITS.name).toBe(60);
    expect(areaNameProblems({ et: "Kulmukoolitused", ru: "Курсы по бровям" })).toEqual({});
    expect(areaNameProblems({ et: "  ", ru: "" })).toEqual({ et: "required", ru: "required" });
    expect(areaNameProblems({ et: "x".repeat(60), ru: `  ${"ы".repeat(60)}  ` })).toEqual({});
    expect(areaNameProblems({ et: "x".repeat(61), ru: "ы" })).toEqual({ et: "tooLong" });
    // only the languages it is given are judged (a save of one field)
    expect(areaNameProblems({ ru: "" })).toEqual({ ru: "required" });
    expect(areaNameProblems({})).toEqual({});
  });
});

describe("the filter chips", () => {
  test("only the areas the list has, in Maria's order (the order given), each once", () => {
    expect(areaChips([kulm, rips, meik], [2, 3, 3, null, 2])).toEqual([rips, meik]);
    expect(areaChips([meik, kulm, rips], [1, 2, 3])).toEqual([meik, kulm, rips]);
  });
  test("none at all when fewer than two areas are in the list: a row that offers one choice besides „Kõik“ is not shown", () => {
    expect(areaChips([kulm, rips], [1, 1, null])).toEqual([]);
    expect(areaChips([kulm, rips], [null, null])).toEqual([]);
    expect(areaChips([kulm, rips], [])).toEqual([]);
    expect(areaChips([], [1, 2])).toEqual([]);
  });
  test("an id that is no area (deleted meanwhile) counts for nothing; two areas with one slug make one chip", () => {
    expect(areaChips([kulm, rips], [1, 9])).toEqual([]);
    expect(areaChips([kulm, { ...kulm, id: 7 }, rips], [1, 7, 2])).toEqual([kulm, rips]);
  });
});

describe("?valdkond", () => {
  test("picks a chip's slug, written any way; anything else (unknown, old, empty, no chips) is „Kõik“", () => {
    const chips = [kulm, rips];
    expect(parseArea("kulmukoolitused", chips)).toBe("kulmukoolitused");
    expect(parseArea("Ripsmekoolitused", chips)).toBe("ripsmekoolitused");
    expect(parseArea(["ripsmekoolitused", "kulmukoolitused"], chips)).toBe("ripsmekoolitused");
    expect(parseArea("meigikoolitused", chips)).toBeNull();
    expect(parseArea("", chips)).toBeNull();
    expect(parseArea(null, chips)).toBeNull();
    expect(parseArea(undefined, chips)).toBeNull();
    expect(parseArea("kulmukoolitused", [])).toBeNull();
  });
});

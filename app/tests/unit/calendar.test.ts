import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { calendarCities, calendarQuery, citySlug, contactSessions, filterCalendar, parseCity, startOfDayTallinn, upcomingFrom } from "@/domain/calendar";
import { parsePackage } from "@/domain/practice";

describe("calendar city filter", () => {
  test("citySlug drops case and diacritics", () => {
    expect(citySlug("Pärnu")).toBe("parnu");
    expect(citySlug(" Kohtla-Järve ")).toBe("kohtla-jarve");
    expect(citySlug("Uus  Linn")).toBe("uus-linn");
  });
  test("chips: Maria's four first, other session cities appended once", () => {
    expect(calendarCities([])).toEqual(["Pärnu", "Tallinn", "Tartu", "Viljandi"]);
    expect(calendarCities(["Tartu", "Narva", " narva ", "PÄRNU", ""])).toEqual(["Pärnu", "Tallinn", "Tartu", "Viljandi", "Narva"]);
  });
  test("?linn picks a known city, anything else means all", () => {
    const cities = calendarCities(["Narva"]);
    expect(parseCity("parnu", cities)).toBe("parnu");
    expect(parseCity("Pärnu", cities)).toBe("parnu");
    expect(parseCity(["tallinn", "tartu"], cities)).toBe("tallinn");
    expect(parseCity("narva", cities)).toBe("narva");
    expect(parseCity("rakvere", cities)).toBeNull();
    expect(parseCity("", cities)).toBeNull();
    expect(parseCity(null, cities)).toBeNull();
    expect(parseCity(undefined, cities)).toBeNull();
  });
  test("only contact-course sessions", () => {
    const s = [{ id: 1, course: { type: "contact" as const } }, { id: 2, course: { type: "e_learning" as const } }];
    expect(contactSessions(s).map((x) => x.id)).toEqual([1]);
  });
});

// The area row (course areas, spec 2026-11-11-course-areas-filter-design.md §5.1): the city and the area combine (AND), a course without an area is
// only under „Kõik“, and „Näita kõiki“ clears both filters, keeping the address's other parameters.
describe("calendar city and area filters together", () => {
  const rows = [
    { id: 1, cityKey: "parnu", areaKey: "kulmukoolitused" },
    { id: 2, cityKey: "tallinn", areaKey: "ripsmekoolitused" },
    { id: 3, cityKey: "parnu", areaKey: "ripsmekoolitused" },
    { id: 4, cityKey: "tallinn", areaKey: null },
  ];
  const ids = (f: { city: string | null; area: string | null }) => filterCalendar(rows, f).map((r) => r.id);
  test("no filter: every row; a city or an area alone; both: only the rows that match both", () => {
    expect(ids({ city: null, area: null })).toEqual([1, 2, 3, 4]);
    expect(ids({ city: "tallinn", area: null })).toEqual([2, 4]);
    expect(ids({ city: null, area: "ripsmekoolitused" })).toEqual([2, 3]);
    expect(ids({ city: "parnu", area: "ripsmekoolitused" })).toEqual([3]);
    expect(ids({ city: "tartu", area: "kulmukoolitused" })).toEqual([]);
  });
  test("a course without an area is never under an area's chip", () => {
    expect(ids({ city: "tallinn", area: "kulmukoolitused" })).toEqual([]);
  });
  test("a chip writes its own parameter and keeps the others; „Näita kõiki“ removes both", () => {
    const live = new URLSearchParams("linn=parnu&utm_source=fb");
    expect(calendarQuery(live, { valdkond: "kulmukoolitused" }).toString()).toBe("linn=parnu&utm_source=fb&valdkond=kulmukoolitused");
    expect(calendarQuery(new URLSearchParams("linn=parnu&valdkond=kulmukoolitused"), { linn: null }).toString()).toBe("valdkond=kulmukoolitused");
    expect(calendarQuery(new URLSearchParams("linn=parnu&valdkond=kulmukoolitused&utm_source=fb"), { linn: null, valdkond: null }).toString()).toBe("utm_source=fb");
    // the live address is not changed itself
    expect(live.toString()).toBe("linn=parnu&utm_source=fb");
  });
});

describe("startOfDayTallinn", () => {
  test("winter (UTC+2) and summer (UTC+3)", () => {
    expect(startOfDayTallinn(new Date("2026-11-14T15:30:12.345Z")).toISOString()).toBe("2026-11-13T22:00:00.000Z");
    expect(startOfDayTallinn(new Date("2026-07-01T09:00:00Z")).toISOString()).toBe("2026-06-30T21:00:00.000Z");
  });
  test("just after local midnight is still that local day", () => {
    // 00:30 in Tallinn on 15.11 is 22:30 UTC on 14.11.
    expect(startOfDayTallinn(new Date("2026-11-14T22:30:00Z")).toISOString()).toBe("2026-11-14T22:00:00.000Z");
  });
  test("a session later today is not before the boundary", () => {
    const now = new Date("2026-11-14T12:00:00Z");
    const session = new Date("2026-11-14T08:00:00Z"); // 10:00 local, already started
    expect(session.getTime()).toBeGreaterThanOrEqual(startOfDayTallinn(now).getTime());
  });
});

describe("upcomingFrom: one 'upcoming' for the calendar, the course page, the cards and booking (item 10, ruling)", () => {
  test("a session counts until it begins (startsAt > now)", () => {
    const now = new Date("2026-11-14T08:00:00Z");
    expect(upcomingFrom(now).toISOString()).toBe("2026-11-14T08:00:00.001Z");
    const at10 = new Date("2026-11-14T08:00:00Z"); // 10:00 in Tallinn
    const isUpcoming = (startsAt: Date, at: Date) => startsAt >= upcomingFrom(at);
    expect(isUpcoming(at10, new Date("2026-11-14T07:59:59Z"))).toBe(true); // 09:59:59
    expect(isUpcoming(at10, at10)).toBe(false); // it begins
    expect(isUpcoming(at10, new Date("2026-11-14T18:00:00Z"))).toBe(false); // 20:00 the same day
  });
  test("every public page and the registration check use it (no other definition of 'today')", () => {
    const files = [
      "src/app/[locale]/(site)/page.tsx",
      "src/app/[locale]/(site)/koolitused/page.tsx",
      "src/app/[locale]/(site)/koolitused/[slug]/page.tsx",
      "src/app/[locale]/(site)/koolituskalender/page.tsx",
      "src/server/submit.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).toMatch(/upcomingFrom\(/);
      expect(src, f).not.toMatch(/listUpcomingSessions\(\w+(\(\))?, new Date\(\)\)|sessionsFrom:\s*new Date\(\)|startsAt < deps\.now/);
    }
  });
});

describe("parsePackage", () => {
  test("matches the code without regard to case", () => {
    expect(parsePackage("MAXI", ["MINI", "MAXI"])).toBe("MAXI");
    expect(parsePackage("mini", ["MINI", "MAXI"])).toBe("MINI");
    expect(parsePackage([" maxi "], ["MINI", "MAXI"])).toBe("MAXI");
    expect(parsePackage("MIDI", ["MINI", "MAXI"])).toBeNull();
    expect(parsePackage(undefined, ["MINI"])).toBeNull();
    expect(parsePackage("", ["MINI"])).toBeNull();
  });
});

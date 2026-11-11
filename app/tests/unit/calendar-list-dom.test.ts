// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CalendarList, type CalendarTexts } from "@/components/site/CalendarList";
import type { CalendarRowData } from "@/components/site/CalendarRow";
import type { AreaChip } from "@/domain/course-areas";

// The public calendar's filters (/koolituskalender; course areas, spec 2026-11-11-course-areas-filter-design.md §5.1): the city chips, and below them
// the area chips („Kõik“, then the areas its sessions have, in Maria's order; role="group", aria-label „Valdkond“, no heading), shown only for two
// or more areas. City and area together (AND); the address is the single source of truth (?linn, ?valdkond), a chip writes it in place and keeps every
// other parameter; an unknown area reads as „Kõik“. When the filters leave nothing: „Valitud filtritega hetkel koolitusi pole.“ and „Näita kõiki“,
// which clears both. The address hook (lib/url-query.ts) is stood in for by one that reads and writes the happy-dom address bar.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/server/actions/public", () => ({ submitWaitlist: vi.fn() }));
vi.mock("@/lib/url-query", async () => {
  const { useSyncExternalStore } = await import("react");
  const listeners = new Set<() => void>();
  return {
    useUrlQuery: () => {
      const query = useSyncExternalStore(
        (cb: () => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        () => window.location.search,
      );
      const write = (next: URLSearchParams) => {
        const qs = next.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
        for (const l of listeners) l();
      };
      return [new URLSearchParams(query), write];
    },
  };
});

const t: CalendarTexts = {
  all: "Kõik",
  cityLabel: "Linn",
  areaLabel: "Valdkond",
  showAll: "Näita kõiki",
  results: "Kuupäevi: {n}",
  empty: "Valitud filtritega hetkel koolitusi pole.",
  none: "Uued kuupäevad avaldatakse peagi.",
  register: "Registreeru",
  waitlist: "Liitu ootenimekirjaga",
  others: "Vaata teisi",
  languageLabel: "Õppekeel",
  waitlistForm: {
    title: "Ootenimekiri",
    lead: "Anname teada.",
    name: "Nimi",
    email: "E-post",
    newsletterConsent: "Uudiskiri",
    submit: "Saada",
    sending: "Saadan…",
    sent: "Saadetud.",
    errorRequired: "Kohustuslik.",
    errorEmail: "E-post.",
    errorTooMany: "Liiga palju.",
    errorGeneric: "Viga.",
  },
};

const row = (id: number, title: string, city: string, areaKey: string | null): CalendarRowData => ({
  id,
  cityKey: city.toLowerCase().replace("ä", "a"),
  areaKey,
  city,
  venue: "Stuudio",
  day: `1${id}.12`,
  weekday: "laupäev",
  dateTime: `2026-12-1${id}T08:00:00.000Z`,
  title,
  courseHref: `/koolitused/k${id}`,
  registerHref: `/koolitused/k${id}?sessioon=${id}`,
  format: "Kontaktõpe",
  language: "ET",
  state: "open",
  stateLabel: "Vabu kohti · 4",
});
const ROWS = [
  row(1, "Kulmude laminatsioon", "Pärnu", "kulmukoolitused"),
  row(2, "Ripsmepikendus", "Tallinn", "ripsmekoolitused"),
  row(3, "Kulmude värvimine", "Tallinn", "kulmukoolitused"),
  row(4, "Meigi alused", "Pärnu", null),
];
const AREAS: AreaChip[] = [
  { id: 1, slug: "kulmukoolitused", label: "Kulmukoolitused" },
  { id: 2, slug: "ripsmekoolitused", label: "Ripsmekoolitused" },
];

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(s: string) => container.querySelector<E>(s);
const $$ = <E extends Element = HTMLElement>(s: string) => [...container.querySelectorAll<E>(s)];
const titles = () => $$("[data-course-name]").map((e) => e.textContent?.trim());
const chips = (row: string) => $$<HTMLButtonElement>(`[${row}] button`).map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
const chip = (row: string, name: string) => $$<HTMLButtonElement>(`[${row}] button`).find((b) => b.textContent === name)!;
const press = async (b: HTMLElement) => {
  await act(async () => b.click());
};
const mount = async (query: string, props: { rows?: CalendarRowData[]; areas?: AreaChip[] } = {}) => {
  window.history.replaceState(null, "", `/koolituskalender${query}`);
  await act(async () =>
    root.render(createElement(CalendarList, { rows: props.rows ?? ROWS, cities: ["Pärnu", "Tallinn"], areas: props.areas ?? AREAS, locale: "et", t })),
  );
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the calendar's area chips (course areas §5.1)", () => {
  test("below the city chips, with no heading: a group named „Valdkond“, „Kõik“ first, then the areas in their order", async () => {
    await mount("");
    const groups = $$("[role='group']");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Linn", "Valdkond"]);
    expect(groups[1].hasAttribute("data-area-filter")).toBe(true);
    expect(chips("data-area-filter")).toEqual([
      ["Kõik", "true"],
      ["Kulmukoolitused", "false"],
      ["Ripsmekoolitused", "false"],
    ]);
    expect(container.querySelectorAll("h2, h3").length).toBe(ROWS.length); // the rows' course names, no heading of the row's own
    expect(titles()).toHaveLength(4);
  });

  test("no area row without two areas (the page passes none): the calendar looks as before", async () => {
    await mount("?valdkond=kulmukoolitused", { areas: [] });
    expect($("[data-area-filter]")).toBeNull();
    expect($$("[role='group']")).toHaveLength(1);
    // the address's area is then nobody's: every date is shown
    expect(titles()).toHaveLength(4);
  });

  test("an area chip shows its courses' dates and writes ?valdkond in place, keeping the city and every other parameter", async () => {
    await mount("?utm=kiri");
    await press(chip("data-area-filter", "Kulmukoolitused"));
    expect(titles()).toEqual(["Kulmude laminatsioon", "Kulmude värvimine"]);
    expect(window.location.search).toBe("?utm=kiri&valdkond=kulmukoolitused");
    expect(chips("data-area-filter")[1]).toEqual(["Kulmukoolitused", "true"]);
    expect($("[aria-live]")?.textContent).toBe("Kuupäevi: 2");
    // the city on top of it: both hold (AND)
    await press(chip("data-city-filter", "Tallinn"));
    expect(titles()).toEqual(["Kulmude värvimine"]);
    expect(new URLSearchParams(window.location.search).get("linn")).toBe("tallinn");
    expect(new URLSearchParams(window.location.search).get("valdkond")).toBe("kulmukoolitused");
    // „Kõik“ of the area row clears only the area
    await press(chip("data-area-filter", "Kõik"));
    expect(window.location.search).toBe("?utm=kiri&linn=tallinn");
    expect(titles()).toEqual(["Ripsmepikendus", "Kulmude värvimine"]);
  });

  test("a course without an area is listed only under „Kõik“", async () => {
    await mount("?valdkond=ripsmekoolitused");
    expect(titles()).toEqual(["Ripsmepikendus"]);
    await mount("");
    expect(titles()).toContain("Meigi alused");
  });

  test("an unknown or old ?valdkond reads as „Kõik“: every date, „Kõik“ pressed", async () => {
    await mount("?valdkond=vana-valdkond");
    expect(titles()).toHaveLength(4);
    expect(chips("data-area-filter")[0]).toEqual(["Kõik", "true"]);
  });

  test("filters that leave nothing: „Valitud filtritega hetkel koolitusi pole.“ and „Näita kõiki“, which clears both filters and keeps the rest", async () => {
    await mount("?linn=parnu&valdkond=ripsmekoolitused&utm=kiri");
    expect(titles()).toEqual([]);
    const empty = $("[data-calendar-empty]")!;
    expect(empty.querySelector("p")?.textContent).toBe("Valitud filtritega hetkel koolitusi pole.");
    const all = empty.querySelector("button")!;
    expect(all.textContent).toBe("Näita kõiki");
    await press(all);
    expect(window.location.search).toBe("?utm=kiri");
    expect(titles()).toHaveLength(4);
    expect(chips("data-city-filter")[0]).toEqual(["Kõik", "true"]);
    expect(chips("data-area-filter")[0]).toEqual(["Kõik", "true"]);
  });

  test("no dates at all: „Uued kuupäevad avaldatakse peagi.“ and no button", async () => {
    await mount("?valdkond=kulmukoolitused", { rows: [], areas: [] });
    const empty = $("[data-calendar-empty]")!;
    expect(empty.textContent).toBe("Uued kuupäevad avaldatakse peagi.");
    expect(empty.querySelector("button")).toBeNull();
  });
});

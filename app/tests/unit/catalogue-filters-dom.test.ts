// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CatalogueFilters, type CatalogueCourse, type CatalogueTexts } from "@/components/site/CatalogueFilters";
import type { AreaChip } from "@/domain/course-areas";

// The catalogue's area chips (/koolitused; course areas, spec 2026-11-11-course-areas-filter-design.md §5.2): a „Valdkond“ row after the level chips,
// in the same pill style, „Kõik“ first (the format row's text), then the areas its courses have in Maria's order; shown only for two or more (the page
// passes none otherwise). ?valdkond=<slug> combines with vorm, tase and otsi (AND), is written in place with the others kept, and „Lähtesta filtrid“
// clears it with them; an unknown area reads as „Kõik“. The address hook (lib/url-query.ts) is stood in for by one on the happy-dom address bar.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/image", () => ({ default: () => null }));
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

const t: CatalogueTexts = {
  overview: "Õppevormid",
  journey: "Kuidas õpe käib",
  howItWorks: "Kuidas see käib",
  readMore: "Loe lähemalt",
  hybridNote: "Soovid kombineerida?",
  search: "Otsi koolitust",
  formatLabel: "Õppevorm",
  levelLabel: "Tase",
  areaLabel: "Valdkond",
  filterAll: "Kõik",
  allLevels: "Kõik tasemed",
  levelBasic: "Baaskoolitused",
  levelAdvanced: "Täiendkoolitused",
  emptyTitle: "Sobivat koolitust ei leitud",
  emptyText: "Muuda otsingut või vaata kõiki koolitusi.",
  resetFilters: "Lähtesta filtrid",
  explainToggle: "Mis vahe on e-õppel, kontaktõppel ja hübriidõppel?",
  count: { one: "{n} koolitus", few: "{n} koolitust", many: "{n} koolitust" },
};
const format = (name: string) => ({ name, question: `${name}?`, definition: `${name}.`, card: `${name}.` });
const FORMATS = { e: format("E-õpe"), k: format("Kontaktõpe"), h: format("Hübriidõpe") };

const course = (id: number, title: string, type: "e_learning" | "contact", level: "basic" | "advanced", area: string | null): CatalogueCourse => ({
  card: { id, type, href: `/koolitused/k${id}`, title, summary: "", image: "", imageAlt: "", badge: null, tags: [], meta: { text: "" }, price: "100 €" },
  level,
  text: title.toLowerCase(),
  area,
});
const COURSES = [
  course(1, "Kulmude laminatsioon", "contact", "basic", "kulmukoolitused"),
  course(2, "Ripsmepikendus", "contact", "advanced", "ripsmekoolitused"),
  course(3, "Kulmude e-kursus", "e_learning", "basic", "kulmukoolitused"),
  course(4, "Meigi alused", "e_learning", "basic", null),
];
const AREAS: AreaChip[] = [
  { id: 1, slug: "kulmukoolitused", label: "Kulmukoolitused" },
  { id: 2, slug: "ripsmekoolitused", label: "Ripsmekoolitused" },
];

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(s: string) => container.querySelector<E>(s);
const $$ = <E extends Element = HTMLElement>(s: string) => [...container.querySelectorAll<E>(s)];
const titles = () => $$("[data-course-card] h3").map((e) => e.textContent);
const chips = (row: string) => $$<HTMLButtonElement>(`[data-filter-row="${row}"] button`).map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
const chip = (row: string, name: string) => $$<HTMLButtonElement>(`[data-filter-row="${row}"] button`).find((b) => b.textContent === name)!;
const press = async (b: HTMLElement) => {
  await act(async () => b.click());
};
const mount = async (query: string, areas: AreaChip[] = AREAS, courses: CatalogueCourse[] = COURSES) => {
  window.history.replaceState(null, "", `/koolitused${query}`);
  await act(async () => root.render(createElement(CatalogueFilters, { courses, areas, formats: FORMATS, t, locale: "et" })));
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

describe("the catalogue's area chips (course areas §5.2)", () => {
  test("after the level chips: a group named „Valdkond“, „Kõik“ first, then the areas in their order", async () => {
    await mount("");
    const rows = $$("[data-filter-row]").map((r) => [r.getAttribute("data-filter-row"), r.getAttribute("aria-label")]);
    expect(rows).toEqual([
      ["format", "Õppevorm"],
      ["level", "Tase"],
      ["area", "Valdkond"],
    ]);
    expect(chips("area")).toEqual([
      ["Kõik", "true"],
      ["Kulmukoolitused", "false"],
      ["Ripsmekoolitused", "false"],
    ]);
  });

  test("no area row without two areas (the page passes none): the catalogue looks as before", async () => {
    await mount("?valdkond=kulmukoolitused", []);
    expect($('[data-filter-row="area"]')).toBeNull();
    expect(titles()).toHaveLength(4);
  });

  test("an area chip shows its courses and writes ?valdkond in place, after vorm and tase, every other parameter kept", async () => {
    await mount("?utm=kiri");
    await press(chip("area", "Kulmukoolitused"));
    expect(titles()).toEqual(["Kulmude laminatsioon", "Kulmude e-kursus"]);
    expect(window.location.search).toBe("?valdkond=kulmukoolitused&utm=kiri");
    expect($("[aria-live]")?.textContent).toBe("2 koolitust");
    // with the format: both hold (AND), the address in its order
    await press(chip("format", "E-õpe"));
    expect(titles()).toEqual(["Kulmude e-kursus"]);
    expect(window.location.search).toBe("?vorm=e&valdkond=kulmukoolitused&utm=kiri");
    // „Kõik“ of the area row clears only the area
    await press(chip("area", "Kõik"));
    expect(window.location.search).toBe("?vorm=e&utm=kiri");
    expect(titles()).toEqual(["Kulmude e-kursus", "Meigi alused"]);
  });

  test("a course without an area is listed only under „Kõik“; an unknown ?valdkond reads as „Kõik“", async () => {
    await mount("?valdkond=ripsmekoolitused");
    expect(titles()).toEqual(["Ripsmepikendus"]);
    await mount("?valdkond=vana-valdkond");
    expect(titles()).toHaveLength(4);
    expect(chips("area")[0]).toEqual(["Kõik", "true"]);
  });

  test("filters that leave nothing: „Lähtesta filtrid“ clears the area with the format, the level and the search", async () => {
    await mount("?tase=taiend&valdkond=kulmukoolitused&otsi=kulm&utm=kiri");
    expect(titles()).toEqual([]);
    await press($$<HTMLButtonElement>("button").find((b) => b.textContent === "Lähtesta filtrid")!);
    expect(window.location.search).toBe("?utm=kiri");
    expect(titles()).toHaveLength(4);
    expect(chips("area")[0]).toEqual(["Kõik", "true"]);
  });

  // review round 1, item 2: the names are Maria's, so a long one (Russian runs long) must not make a chip wider than a 390 px screen
  // (catalogue.spec.ts measures it at 390). The format and level chips keep their own rules.
  test("the stylesheet: the area chips wrap within the page; the other chips stay nowrap", () => {
    const css = readFileSync("src/components/site/CatalogueFilters.module.css", "utf8");
    const area = css.match(/\n\.areas \.pill\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(area).toMatch(/max-width:\s*100%/);
    expect(area).toMatch(/white-space:\s*normal/);
    expect(area).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css.match(/\n\.pill\s*\{([^}]*)\}/)?.[1]).toMatch(/white-space:\s*nowrap/);
  });
});

// UX pass 11.11 P6 (the Telefon-koolitused board): the chip rows together right above the courses, „Õppevormid“ (the three explainer cards) behind one
// line „Mis vahe on e-õppel, kontaktõppel ja hübriidõppel?“ that opens them, and a visible count „6 koolitust“ above the grid. A picked format still
// shows its journey with the steps (the intro promises it, K5), now under the chips.
describe("the catalogue's filters together, „Õppevormid“ behind one line (UX pass P6)", () => {
  const toggle = () => $<HTMLButtonElement>("[data-explainer-toggle]")!;
  const panel = () => $("[data-explainer-panel]")!;
  /** where each marker first stands in the page, in document order */
  const order = (...sel: string[]) => sel.map((x) => [...container.querySelectorAll("*")].indexOf($(x)!));

  test("„Kõik“: the rows, then the closed line, then „4 koolitust“, then the courses; the line opens and closes the three cards", async () => {
    await mount("");
    const at = order('[data-filter-row="format"]', '[data-filter-row="level"]', '[data-filter-row="area"]', "[data-explainer-toggle]", "[data-catalogue-count]", "[data-course-card]");
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(at.every((n) => n >= 0)).toBe(true);
    expect(toggle().textContent).toContain("Mis vahe on e-õppel, kontaktõppel ja hübriidõppel?");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-controls")).toBe(panel().id);
    expect(panel().hidden).toBe(true);
    expect($("[data-catalogue-count]")!.textContent).toBe("4 koolitust");
    expect($("[data-catalogue-count]")!.getAttribute("aria-live")).toBe("polite");
    expect($("[data-catalogue-count]")!.className).not.toMatch(/srOnly/);
    await press(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(panel().hidden).toBe(false);
    expect(panel().textContent).toContain("Õppevormid");
    expect(panel().querySelectorAll("[data-format-card]")).toHaveLength(3);
    await press(toggle());
    expect(panel().hidden).toBe(true);
  });

  test("a format picked: its journey shows under the chips at once, no line; the count follows", async () => {
    await mount("");
    await press(chip("format", "E-õpe"));
    expect($("[data-explainer-toggle]")).toBeNull();
    expect($("[data-explainer] h2")?.textContent).toBe("E-õpe?");
    const at = order('[data-filter-row="area"]', "[data-explainer]", "[data-catalogue-count]", "[data-course-card]");
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect($("[data-catalogue-count]")!.textContent).toBe("2 koolitust");
  });

  test("the hybrid note in a format's journey opens the line with the hybrid explanation, focused; ?vorm=h opens it too", async () => {
    await mount("?vorm=k");
    await press($$<HTMLButtonElement>("[data-explainer] button").find((b) => b.textContent === "Hübriidõpe")!);
    expect(window.location.search).toBe("");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(panel().hidden).toBe(false);
    expect($("[data-hybrid-panel]")!.hidden).toBe(false);
    expect(document.activeElement).toBe($("[data-hybrid-panel] h2"));
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount("?vorm=h");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect($("[data-hybrid-panel]")!.hidden).toBe(false);
  });

  test("one course: „1 koolitus“", async () => {
    await mount("", AREAS, COURSES.slice(0, 1));
    expect($("[data-catalogue-count]")!.textContent).toBe("1 koolitus");
  });
});

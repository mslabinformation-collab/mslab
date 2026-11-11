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
  results: "Leitud koolitusi: {n}",
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
const mount = async (query: string, areas: AreaChip[] = AREAS) => {
  window.history.replaceState(null, "", `/koolitused${query}`);
  await act(async () => root.render(createElement(CatalogueFilters, { courses: COURSES, areas, formats: FORMATS, t })));
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
    expect($("[aria-live]")?.textContent).toBe("Leitud koolitusi: 2");
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

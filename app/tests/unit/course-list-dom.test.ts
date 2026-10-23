// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CourseList } from "@/components/admin/CourseList";
import type { CourseRowData } from "@/components/admin/course-rows";

// CourseList (B1 Koolitused, piece 3a Task 3; README B1): the course list as a DragList of rows. Each row has the handle ⋮⋮, the arrows ↑ / ↓, the
// thumbnail, the title with „{tase} · /{slug}“, the type tag, the price on its lines, the badge and the status; on a phone a „↕“ menu stands for the
// arrows. A move shows at once (the list is reordered in the same tick) and goes to the server as one `moveCourseToAction({ id, index })`; the
// server's answer is the page's refresh, or, when it fails, the old order back and „Järjekorra muutmine ei õnnestunud. Proovi uuesti.“.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const move = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/admin-content", () => ({ moveCourseToAction: move }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/admin/koolitused",
  useSearchParams: () => new URLSearchParams(),
}));

const row = (id: number, slug: string, name: string, over: Partial<CourseRowData> = {}): CourseRowData => ({
  id,
  slug,
  name,
  image: null,
  sub: "Baaskoolitus · /" + slug,
  type: "contact",
  typeLabel: "Kontaktõpe",
  price: ["Grupp 350 €", "Individuaal 450 €"],
  badge: null,
  status: "published",
  statusLabel: "Avaldatud",
  sample: false,
  ...over,
});
const A = row(1, "kulmumeistri-baaskoolitus", "Kulmumeistri baaskoolitus", { badge: { label: "Populaarne", bg: "#ddd4dc", fg: "#000000" }, image: "/seed/brow.jpg" });
const B = row(2, "lash-lift", "Lash Lift BOTOX", { status: "changes", statusLabel: "Avaldamata muudatused" });
const C = row(3, "kulmumeistri-e-koolitus", "Kulmumeistri e-koolitus", { type: "e_learning", typeLabel: "E-õpe", price: ["190 €"], sample: true, status: "draft", statusLabel: "Mustand" });
const ROWS = [A, B, C];

let container: HTMLDivElement;
let root: Root;
let props: { courses: CourseRowData[]; ordered: boolean };

const draw = (courses: CourseRowData[] = ROWS, ordered = true) => {
  props = { courses, ordered };
  return act(async () => root.render(createElement(CourseList, props)));
};
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => Array.from(container.querySelectorAll<E>(selector));
const slugs = () => $$("[data-course-row]").map((li) => li.getAttribute("data-course-row"));
const button = (name: string) => $$<HTMLButtonElement>("button").find((b) => b.getAttribute("aria-label") === name)!;
const click = (el: Element) => act(async () => void (el as HTMLElement).click());
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () => act(async () => void (await Promise.resolve()));

beforeEach(() => {
  move.mockReset();
  move.mockResolvedValue({ ok: true, id: 1 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("CourseList: the rows", () => {
  it("one li per course in the given order, each with its row hook, and a header over the columns", async () => {
    await draw();
    expect(slugs()).toEqual(ROWS.map((r) => r.slug));
    expect($$("ol > li")).toHaveLength(3);
    expect($$("[data-course-head] > *").map((c) => text(c))).toEqual(["", "Järjekord", "", "Koolitus", "Õppevorm", "Hind", "Märgis", "Staatus"]);
    expect(text($("[data-course-head]"))).not.toContain("Muudetud");
  });

  it("the title is the row's one link (Muuda: {nimi}) to the editor, with „{tase} · /{slug}“ under it", async () => {
    await draw();
    const li = $('[data-course-row="lash-lift"]')!;
    const link = li.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe("/admin/koolitused/2");
    expect(link.getAttribute("aria-label")).toBe("Muuda: Lash Lift BOTOX");
    expect(text(li.querySelector("[data-course-sub]"))).toBe("Baaskoolitus · /lash-lift");
    expect(li.querySelectorAll("a")).toHaveLength(1);
  });

  it("the type tag, the price on its own lines, the badge as the card shows it (a dash without one) and the status", async () => {
    await draw();
    const a = $('[data-course-row="kulmumeistri-baaskoolitus"]')!;
    expect(text(a.querySelector("[data-course-type]"))).toBe("Kontaktõpe");
    expect(Array.from(a.querySelectorAll("[data-course-price] > span")).map((s) => text(s))).toEqual(["Grupp 350 €", "Individuaal 450 €"]);
    const badge = a.querySelector<HTMLElement>("[data-badge]")!;
    expect(text(badge)).toBe("Populaarne");
    expect(badge.style.background).not.toBe("");
    const b = $('[data-course-row="lash-lift"]')!;
    expect(b.querySelector("[data-badge]")).toBeNull();
    expect(text(b.querySelector("[data-course-badge]"))).toContain("—");
    expect(text($('[data-course-row="kulmumeistri-e-koolitus"] [data-course-price]'))).toBe("190 €");
  });

  it("the status tag says Avaldatud, Avaldamata muudatused or Mustand; the sample mark stays beside it", async () => {
    await draw();
    expect($$("[data-course-state]").map((s) => [text(s), s.getAttribute("data-status")])).toEqual([
      ["Avaldatud", "published"],
      ["Avaldamata muudatused", "changes"],
      ["Mustand", "draft"],
    ]);
    expect($$("[data-sample]").map((s) => text(s))).toEqual(["Näidis"]);
    expect($('[data-course-row="kulmumeistri-e-koolitus"] [data-sample]')).not.toBeNull();
  });

  it("the thumbnail is the first picture, 56 px, with no alt text of its own (the title says it); a course without one has a plain square", async () => {
    await draw();
    const img = $<HTMLImageElement>('[data-course-row="kulmumeistri-baaskoolitus"] img')!;
    expect(img.getAttribute("src")).toContain("brow.jpg");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("width")).toBe("56");
    expect($('[data-course-row="lash-lift"] img')).toBeNull();
    expect($('[data-course-row="lash-lift"] [data-course-thumb]')).not.toBeNull();
  });

  it("the phone's second line says „{Õppevorm} · {Staatus}“ (and „Näidis“), in words the tags have; it is the only copy that is drawn on a phone", async () => {
    await draw();
    expect($$("[data-course-line]").map((l) => text(l))).toEqual(["Kontaktõpe · Avaldatud", "Kontaktõpe · Avaldamata muudatused", "E-õpe · Mustand · Näidis"]);
    // (the tags carry the hooks; the line has none, so a row has one [data-course-state] and one [data-sample])
    expect($$('[data-course-row="kulmumeistri-e-koolitus"] [data-course-state]')).toHaveLength(1);
    expect($$('[data-course-row="kulmumeistri-e-koolitus"] [data-sample]')).toHaveLength(1);
  });

  it("the badge cell names itself for a screen reader (the list has no column headers of its own to read)", async () => {
    await draw();
    expect(text($('[data-course-row="lash-lift"] [data-course-badge]'))).toBe("Märgis: —");
  });

  it("the header is for the eyes: the list is a list", async () => {
    await draw();
    expect($("[data-course-head]")!.getAttribute("aria-hidden")).toBe("true");
    expect($("ol")).not.toBeNull();
    expect($("table")).toBeNull();
  });
});

describe("CourseList: the order controls", () => {
  it("each row has a handle, ↑ / ↓ and the „↕“ menu; the first row's ↑ and the last row's ↓ are aria-disabled", async () => {
    await draw();
    expect($$("button[data-drag-tool=handle]")).toHaveLength(3);
    expect($$("button[data-drag-tool=handle]").map((h) => h.getAttribute("aria-label"))).toEqual(ROWS.map((r) => `Lohista: ${r.name}`));
    expect($$("button[data-drag-tool=handle]").every((h) => h.getAttribute("aria-roledescription") === "lohistatav")).toBe(true);
    expect(button("Liiguta üles: Kulmumeistri baaskoolitus").getAttribute("aria-disabled")).toBe("true");
    expect(button("Liiguta alla: Kulmumeistri e-koolitus").getAttribute("aria-disabled")).toBe("true");
    expect(button("Liiguta alla: Kulmumeistri baaskoolitus").hasAttribute("aria-disabled")).toBe(false);
    expect($$("[data-more-menu]")).toHaveLength(3);
    expect(button("Liiguta: Lash Lift BOTOX").textContent).toBe(String.fromCodePoint(0x2195, 0xfe0e)); // (the arrow as text, never as a colour emoji)
  });

  it("in a filtered view (ordered=false) there are no handles, no arrows and no menus, and the columns close up", async () => {
    await draw([A, C], false);
    expect(slugs()).toEqual([A.slug, C.slug]);
    expect($$("button")).toHaveLength(0);
    expect($("[data-drag-tool]")).toBeNull();
    expect($("[data-more-menu]")).toBeNull();
    expect($("[data-course-list]")!.getAttribute("data-ordered")).toBe("false");
    expect($$("[data-course-head] > *").map((c) => text(c))).toEqual(["", "Koolitus", "Õppevorm", "Hind", "Märgis", "Staatus"]);
  });
});

describe("CourseList: a move", () => {
  it("↓ reorders the list at once and sends one moveCourseToAction({ id, index }); the answer leaves the order as it is", async () => {
    let answer!: (r: unknown) => void;
    move.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await draw();
    await click(button("Liiguta alla: Kulmumeistri baaskoolitus"));
    // at once: before the server has answered
    expect(slugs()).toEqual([B.slug, A.slug, C.slug]);
    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith({ id: A.id, index: 1 });
    expect(text($("[role=status]"))).toBe("„Kulmumeistri baaskoolitus“ on nüüd 2. kohal.");
    // the focus stays on the ↓ that was pressed, in its row's new place
    expect(document.activeElement).toBe(button("Liiguta alla: Kulmumeistri baaskoolitus"));
    // the server answers and the page refreshes with the new order
    await act(async () => answer({ ok: true, id: A.id }));
    await draw([B, A, C]);
    expect(slugs()).toEqual([B.slug, A.slug, C.slug]);
    expect($("[role=alert]")).toBeNull();
  });

  it("a failed move snaps the list back and says so; the next move clears the message", async () => {
    move.mockResolvedValueOnce({ ok: false, error: "server" });
    await draw();
    await click(button("Liiguta alla: Kulmumeistri baaskoolitus"));
    await settle();
    expect(slugs()).toEqual(ROWS.map((r) => r.slug));
    expect(text($("[role=alert]"))).toBe("Järjekorra muutmine ei õnnestunud. Proovi uuesti.");
    await click(button("Liiguta alla: Kulmumeistri baaskoolitus"));
    await settle();
    expect($("[role=alert]")).toBeNull();
  });

  it("an action that throws is a failed move too", async () => {
    move.mockRejectedValueOnce(new Error("network"));
    await draw();
    await click(button("Liiguta üles: Lash Lift BOTOX"));
    await settle();
    expect(slugs()).toEqual(ROWS.map((r) => r.slug));
    expect(text($("[role=alert]"))).toContain("ei õnnestunud");
  });

  it("two moves in a row each go to the server with their place in the list as it was drawn", async () => {
    const answers: Array<(r: unknown) => void> = [];
    move.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    await draw();
    await click(button("Liiguta alla: Kulmumeistri baaskoolitus")); // A to 1: B A C
    await click(button("Liiguta alla: Kulmumeistri baaskoolitus")); // A to 2: B C A
    expect(slugs()).toEqual([B.slug, C.slug, A.slug]);
    expect(move.mock.calls.map((c) => c[0])).toEqual([
      { id: A.id, index: 1 },
      { id: A.id, index: 2 },
    ]);
    await act(async () => answers.forEach((a) => a({ ok: true })));
    await draw([B, C, A]);
    expect(slugs()).toEqual([B.slug, C.slug, A.slug]);
  });

  it("the phone's „↕“ menu: Esimeseks / Viimaseks / Üles / Alla send the place they name", async () => {
    move.mockReturnValue(new Promise(() => {})); // (not answered: the order on the screen is the optimistic one throughout)
    await draw();
    await click(button("Liiguta: Kulmumeistri e-koolitus"));
    const items = () => $$("[role=menuitem]");
    expect(items().map((i) => text(i))).toEqual(["Üles", "Alla", "Esimeseks", "Viimaseks"]);
    await click(items()[2]); // Esimeseks: C A B
    expect(slugs()).toEqual([C.slug, A.slug, B.slug]);
    expect(move).toHaveBeenLastCalledWith({ id: C.id, index: 0 });
    expect(text($("[role=status]"))).toBe("„Kulmumeistri e-koolitus“ on nüüd 1. kohal.");
    // the focus is back on the row's „↕“
    expect(document.activeElement).toBe(button("Liiguta: Kulmumeistri e-koolitus"));
    await click(button("Liiguta: Lash Lift BOTOX"));
    await click(items()[0]); // Üles: B (last) goes before A: C B A
    expect(slugs()).toEqual([C.slug, B.slug, A.slug]);
    expect(move).toHaveBeenLastCalledWith({ id: B.id, index: 1 });
    await click(button("Liiguta: Kulmumeistri e-koolitus"));
    await click(items()[3]); // Viimaseks: B A C
    expect(slugs()).toEqual([B.slug, A.slug, C.slug]);
    expect(move).toHaveBeenLastCalledWith({ id: C.id, index: 2 });
    await click(button("Liiguta: Lash Lift BOTOX"));
    await click(items()[1]); // Alla: A B C
    expect(slugs()).toEqual([A.slug, B.slug, C.slug]);
    expect(move).toHaveBeenLastCalledWith({ id: B.id, index: 1 });
    expect(move).toHaveBeenCalledTimes(4);
  });

  it("in the menu the first row's Üles and Esimeseks and the last row's Alla and Viimaseks are aria-disabled, and choosing one moves nothing", async () => {
    await draw();
    await click(button("Liiguta: Kulmumeistri baaskoolitus"));
    expect($$("[role=menuitem]").map((i) => i.getAttribute("aria-disabled"))).toEqual(["true", null, "true", null]);
    await click($$("[role=menuitem]")[0]);
    await click($$("[role=menuitem]")[2]);
    expect(move).not.toHaveBeenCalled();
    expect(slugs()).toEqual(ROWS.map((r) => r.slug));
    await act(async () => void document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await click(button("Liiguta: Kulmumeistri e-koolitus"));
    expect($$("[role=menuitem]").map((i) => i.getAttribute("aria-disabled"))).toEqual([null, "true", null, "true"]);
  });
});

describe("CourseList: the whole row opens the editor", () => {
  it("a click on the tag or the thumbnail follows the title link; the handle, the arrows and the menu keep their clicks", async () => {
    await draw();
    const li = $('[data-course-row="lash-lift"]')!;
    const link = li.querySelector<HTMLAnchorElement>("a")!;
    const seen: Element[] = [];
    link.addEventListener("click", (e) => {
      e.preventDefault();
      seen.push(e.target as Element);
    });
    await click(li.querySelector("[data-course-type]")!);
    await click(li.querySelector("[data-course-thumb]")!);
    await click(li);
    expect(seen).toHaveLength(3);
    await click(li.querySelector("[data-drag-tool=handle]")!);
    await click(li.querySelector("[data-drag-tool=up]")!);
    expect(seen).toHaveLength(3);
  });
});

describe("CourseList: the layout (the stylesheet)", () => {
  const css = readFileSync(join(process.cwd(), "src/components/admin/CourseList.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("switches to the phone card at the shared 760 px of the list card, and not at the old 900", () => {
    expect(css).toMatch(/@container \(max-width: 760px\)/);
    expect(css).not.toMatch(/max-width: 900px/);
  });

  it("the README's columns on a wide card: 8 tracks with the title taking what is left; the middle card has two lines, from 1039 px down", () => {
    expect(css).toMatch(/grid-template-columns:\s*44px 96px 56px minmax\(0, 1fr\) 120px 150px 120px 180px;/);
    expect(css).toMatch(/@container \(max-width: 1039px\)/);
  });
});

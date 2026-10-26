// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SectionMap, sectionCard } from "@/components/admin/SectionMap";

// SectionMap (the B screens, Task 1; README B2): from 1180 px a 190 px sticky list of links to the cards of the page, each with its count, „RU puudub“ or
// „Kontrolli“ (#6b4f5c); below it a „Jaotised ▾“ select that scrolls to the chosen card. The page's cards carry the id of their entry and the class
// `sectionCard`, which keeps a card's top clear of the phone top bar (64 px) when it is scrolled to.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
type Props = Parameters<typeof SectionMap>[0];
const SECTIONS: Props["sections"] = [
  { id: "pohiinfo", label: "Põhiinfo" },
  { id: "hind", label: "Õppevorm ja hind", count: 1 },
  { id: "tulemused", label: "Õpiväljundid", count: 4 },
  { id: "test", label: "Teadmiste test", flag: "ru" },
  { id: "tunnistus", label: "Tunnistus", flag: "check" },
  { id: "kkk", label: "KKK", count: 6, flag: "ru" },
];
const draw = (sections: Props["sections"] = SECTIONS) => act(async () => root.render(createElement(SectionMap, { sections })));

const nav = () => container.querySelector<HTMLElement>("nav")!;
const links = () => Array.from(container.querySelectorAll<HTMLAnchorElement>("nav a"));
const link = (id: string) => container.querySelector<HTMLAnchorElement>(`nav a[href="#${id}"]`)!;
const select = () => container.querySelector<HTMLSelectElement>("select")!;
const options = () => Array.from(select().querySelectorAll("option"));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** A card of the page with an id: scrollIntoView is not in the test DOM's layout, so it is a spy. */
function card(id: string, attrs: Record<string, string> = {}) {
  const el = document.createElement("section");
  el.id = id;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.scrollIntoView = vi.fn();
  document.body.append(el);
  return el;
}
const click = async (el: Element, init: MouseEventInit = {}) => {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  await act(async () => void el.dispatchEvent(e));
  return e;
};
const choose = (value: string) =>
  act(async () => {
    select().value = value;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("section[id]").forEach((el) => el.remove());
  vi.restoreAllMocks();
});

describe("SectionMap: the list of links (from 1180 px)", () => {
  it("is a nav named „Jaotised“ with a link to each entry's card, in the order given", async () => {
    await draw();
    expect(nav().getAttribute("aria-label")).toBe("Jaotised");
    expect(links().map((a) => a.getAttribute("href"))).toEqual(["#pohiinfo", "#hind", "#tulemused", "#test", "#tunnistus", "#kkk"]);
    expect(links().map((a) => text(a.querySelector("[data-section-label]")))).toEqual(["Põhiinfo", "Õppevorm ja hind", "Õpiväljundid", "Teadmiste test", "Tunnistus", "KKK"]);
  });

  it("an entry shows its count, or „RU puudub“, or „Kontrolli“; one with none shows nothing", async () => {
    await draw();
    expect(text(link("pohiinfo").querySelector("[data-section-status]"))).toBe("");
    expect(text(link("hind").querySelector("[data-section-status]"))).toBe("1");
    expect(text(link("tulemused").querySelector("[data-section-status]"))).toBe("4");
    expect(text(link("test").querySelector("[data-section-status]"))).toBe("RU puudub");
    expect(text(link("tunnistus").querySelector("[data-section-status]"))).toBe("Kontrolli");
  });

  it("a count and a flag come together as the home page's KKK draws them: „6 · RU puudub“", async () => {
    await draw();
    expect(text(link("kkk").querySelector("[data-section-status]"))).toBe("6 · RU puudub");
  });

  it("„{n} avaldamata“ (Seaded's legal texts waiting for their publish, piece3-texts P-11), marked for the accent, also in the select; none at 0", async () => {
    await draw([
      { id: "lepingud", label: "Lepingud ja tingimused", unpublished: 2 },
      { id: "kkk", label: "KKK", count: 6, unpublished: 1 },
      { id: "x", label: "Muu", unpublished: 0 },
    ]);
    expect(text(link("lepingud").querySelector("[data-section-status]"))).toBe("2 avaldamata");
    expect(link("lepingud").querySelector("[data-unpublished]")).not.toBeNull();
    expect(text(link("kkk").querySelector("[data-section-status]"))).toBe("6 · 1 avaldamata");
    expect(text(link("x").querySelector("[data-section-status]"))).toBe("");
    expect(options().map((o) => o.textContent)).toEqual(["Lepingud ja tingimused · 2 avaldamata", "KKK · 6 · 1 avaldamata", "Muu"]);
  });

  it("a count of 0 is shown (the page decides whether to pass one)", async () => {
    await draw([{ id: "a", label: "Galerii", count: 0 }]);
    expect(text(link("a").querySelector("[data-section-status]"))).toBe("0");
  });

  it("the flags are marked for the stylesheet (the accent), the count is not", async () => {
    await draw();
    expect(link("test").querySelector("[data-flag]")!.getAttribute("data-flag")).toBe("ru");
    expect(link("tunnistus").querySelector("[data-flag]")!.getAttribute("data-flag")).toBe("check");
    expect(link("hind").querySelector("[data-flag]")).toBeNull();
    expect(link("kkk").querySelector("[data-count]")!.textContent).toBe("6");
  });

  it("the first entry is the current one to begin with", async () => {
    await draw();
    expect(links().map((a) => a.getAttribute("aria-current"))).toEqual(["true", null, null, null, null, null]);
  });

  it("a click scrolls to the card (to its top, which the card's scroll-margin keeps clear) and makes the entry the current one", async () => {
    const target = card("tulemused");
    await draw();
    const e = await click(link("tulemused"));
    expect(e.defaultPrevented).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(links().map((a) => a.getAttribute("aria-current"))).toEqual([null, null, "true", null, null, null]);
  });

  it("under reduced motion it jumps", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: q.includes("prefers-reduced-motion"), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    const target = card("hind");
    await draw();
    await click(link("hind"));
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

  it("the focus follows to a card that can take it (tabindex=-1), so a keyboard user starts reading there", async () => {
    const target = card("hind", { tabindex: "-1" });
    const focus = vi.spyOn(target, "focus");
    await draw();
    await click(link("hind"));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("a click with Ctrl, Shift, Cmd or a middle button is the browser's own (a new tab keeps the link)", async () => {
    const target = card("hind");
    await draw();
    for (const init of [{ ctrlKey: true }, { shiftKey: true }, { metaKey: true }, { button: 1 }]) {
      const e = await click(link("hind"), init);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(target.scrollIntoView).not.toHaveBeenCalled();
  });

  it("an entry whose card is not on the page does nothing, and breaks nothing", async () => {
    await draw();
    const e = await click(link("hind"));
    expect(e.defaultPrevented).toBe(true);
  });

  it("is sticky, so the bubble's lift sees it (data-fab-avoid)", async () => {
    await draw();
    expect(nav().hasAttribute("data-fab-avoid")).toBe(true);
  });

  it("is 190 px wide unless the page asks for 170 px (the C screens, piece 4a): `width={170}` sets the modifier class", async () => {
    await draw();
    expect(nav().className).not.toContain("narrow");
    await act(async () => root.render(createElement(SectionMap, { sections: SECTIONS, width: 190 })));
    expect(nav().className).not.toContain("narrow");
    await act(async () => root.render(createElement(SectionMap, { sections: SECTIONS, width: 170 })));
    expect(nav().className).toContain("narrow");
    // the select below 1180 px is the same either way
    expect(container.querySelector("[data-section-select]")!.className).not.toContain("narrow");
  });
});

describe("SectionMap: the select (below 1180 px)", () => {
  it("is a select named „Jaotised“, one option per entry, the entry's status after its name", async () => {
    await draw();
    expect(select().getAttribute("aria-label")).toBe("Jaotised");
    expect(options().map((o) => [o.value, text(o)])).toEqual([
      ["pohiinfo", "Põhiinfo"],
      ["hind", "Õppevorm ja hind · 1"],
      ["tulemused", "Õpiväljundid · 4"],
      ["test", "Teadmiste test · RU puudub"],
      ["tunnistus", "Tunnistus · Kontrolli"],
      ["kkk", "KKK · 6 · RU puudub"],
    ]);
  });

  it("its face reads „Jaotised · {the current entry}“ and a ▾ that only decorates", async () => {
    await draw();
    const face = container.querySelector<HTMLElement>("[data-section-face]")!;
    expect(text(face)).toBe("Jaotised · Põhiinfo ▾");
    expect(face.getAttribute("aria-hidden")).toBe("true");
    expect(face.querySelector("[aria-hidden=true]")!.textContent).toBe("▾");
  });

  it("choosing an entry scrolls to its card, and the face and the list's current entry follow", async () => {
    const target = card("tulemused");
    await draw();
    await choose("tulemused");
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(text(container.querySelector("[data-section-face]"))).toBe("Jaotised · Õpiväljundid ▾");
    expect(select().value).toBe("tulemused");
    expect(link("tulemused").getAttribute("aria-current")).toBe("true");
  });

  it("an entry whose card is not on the page does nothing, and breaks nothing", async () => {
    await draw();
    await choose("hind");
    expect(text(container.querySelector("[data-section-face]"))).toBe("Jaotised · Õppevorm ja hind ▾");
  });

  it("the entries may change (the card follows the draft „Õppevorm“): a current entry that is gone falls back to the first", async () => {
    await draw();
    await choose("test");
    await draw(SECTIONS.filter((s) => s.id !== "test"));
    expect(select().value).toBe("pohiinfo");
    expect(text(container.querySelector("[data-section-face]"))).toBe("Jaotised · Põhiinfo ▾");
    expect(links().map((a) => a.getAttribute("aria-current"))).toEqual(["true", null, null, null, null]);
  });
});

describe("SectionMap: the cards' class", () => {
  it("sectionCard is the class of the stylesheet's .card", () => {
    expect(typeof sectionCard).toBe("string");
    expect(sectionCard.length).toBeGreaterThan(0);
  });
});

describe("SectionMap: the stylesheet", () => {
  const raw = readFileSync(join(process.cwd(), "src/components/admin/SectionMap.module.css"), "utf8");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  };
  const tokens = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");

  it("the list is 190 px wide (170 px with the modifier) and sticky, and it shows from 1180 px, where the select goes", () => {
    expect(rule(".nav")).toMatch(/width:\s*190px;/);
    expect(rule(".narrow")).toMatch(/width:\s*170px;/);
    expect(rule(".nav")).toMatch(/position:\s*sticky;/);
    expect(css).toMatch(/@media \(min-width: 1180px\)\s*\{[^@]*\.nav\s*\{[^}]*display:\s*flex;[^}]*\}[^@]*\.select\s*\{[^}]*display:\s*none;/);
    expect(rule(".nav")).toMatch(/display:\s*none;/);
  });

  it("a link is a 44 px target with the admin's focus ring", () => {
    expect(rule(".link")).toMatch(/min-height:\s*44px;/);
    expect(css).toMatch(/\.link:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--rose\);[^}]*outline-offset:\s*2px;/);
  });

  it("„RU puudub“ and „Kontrolli“ are in #6b4f5c (the token --warn), a count in the muted grey", () => {
    expect(tokens).toMatch(/--warn:\s*#6b4f5c;/);
    expect(css).toMatch(/\[data-flag\]\s*\{[^}]*color:\s*var\(--warn\);/);
    expect(css).toMatch(/\[data-count\]\s*\{[^}]*color:\s*var\(--muted\);/);
  });

  it("a card keeps 24 px clear of the top when scrolled to, and 64 px more below 900 px (the phone top bar)", () => {
    expect(rule(".card")).toMatch(/scroll-margin-top:\s*24px;/);
    expect(css).toMatch(/@media \(max-width: 899\.98px\)\s*\{[^@]*\.card\s*\{[^}]*scroll-margin-top:\s*calc\(64px \+ 24px\);/);
  });

  it("the select is a 48 px box in the prototype's look, over which the real select lies invisible (a tap anywhere opens it)", () => {
    expect(rule(".select")).toMatch(/min-height:\s*48px;/);
    expect(css).toMatch(/\.select\s*>\s*select\s*\{[^}]*opacity:\s*0;/);
    expect(css).toMatch(/\.select\s*>\s*select:focus-visible\s*\+\s*\.face\s*\{[^}]*outline:\s*2px solid var\(--rose\);/);
  });
});

// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { menuPlacement, MoreMenu } from "@/components/admin/MoreMenu";

// MoreMenu (the A screens, Task 1; the prototype's „Veel ▾“ and „Pikenda ▾“): a button that opens a role=menu list. It opens on click, Enter and
// Space (the button's own click) and on ArrowDown; it closes on Esc, on a click outside, on a choice and on Tab; focus goes into the list when it
// opens and back to the button when it closes by Esc or a choice. It keeps inside the viewport: below and to the left of the button when it fits,
// above it when it does not fit below, to the button's right edge when it does not fit to the right.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
type Props = Parameters<typeof MoreMenu>[0];

const draw = (props: Partial<Props> = {}) =>
  act(async () => root.render(createElement(MoreMenu, { items: [{ label: "Ava järgmine õppetund" }, { label: "Lõpeta ligipääs", tone: "danger" }], ...props })));

const button = () => container.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]")!;
const menu = () => container.querySelector<HTMLElement>("[role=menu]");
const items = () => Array.from(container.querySelectorAll<HTMLElement>("[role=menuitem]"));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })));
const click = (el: Element) => act(async () => void (el as HTMLElement).click());
const mouseDownOutside = () => act(async () => void document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("MoreMenu: the button", () => {
  it("reads „Veel ▾“ unless the page names it; the menu is closed to begin with", async () => {
    await draw();
    expect(text(button())).toBe("Veel ▾");
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(button().getAttribute("aria-haspopup")).toBe("menu");
    expect(button().type).toBe("button");
    expect(menu()).toBeNull();
    await draw({ label: "Pikenda" });
    expect(text(button())).toBe("Pikenda ▾");
  });

  it("the ▾ is decoration: the button's name is the label", async () => {
    await draw();
    expect(button().querySelector("[aria-hidden=true]")!.textContent).toBe("▾");
  });
});

describe("MoreMenu: opening", () => {
  it("a click opens the list: role=menu, named by the button, one menuitem per item", async () => {
    await draw();
    await click(button());
    expect(menu()).not.toBeNull();
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(menu()!.getAttribute("aria-labelledby")).toBe(button().id);
    expect(button().getAttribute("aria-controls")).toBe(menu()!.id);
    expect(items().map((i) => text(i))).toEqual(["Ava järgmine õppetund", "Lõpeta ligipääs"]);
  });

  it("Enter opens it, and the focus goes to the first item", async () => {
    await draw();
    await act(async () => void button().focus());
    await key(button(), "Enter");
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(items()[0]);
  });

  it("a click on the button again closes it", async () => {
    await draw();
    await click(button());
    await click(button());
    expect(menu()).toBeNull();
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  it("ArrowDown on the button opens it onto the first item, ArrowUp onto the last", async () => {
    await draw();
    await key(button(), "ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
    await key(items()[0], "Escape");
    await key(button(), "ArrowUp");
    expect(document.activeElement).toBe(items()[1]);
  });

  it("Space is the button's own click: the click opens it", async () => {
    await draw();
    await click(button()); // (a browser fires the click for Space on keyup)
    expect(menu()).not.toBeNull();
  });
});

describe("MoreMenu: a title", () => {
  it("a page's title (the prototype's „Pikenda ligipääsu (praegu kuni …)“) is the first line of the list, not an item; it names the menu", async () => {
    await draw({ label: "Pikenda", title: "Pikenda ligipääsu (praegu kuni 17.03.2027)" });
    await click(button());
    const title = menu()!.firstElementChild!;
    expect(text(title)).toBe("Pikenda ligipääsu (praegu kuni 17.03.2027)");
    expect(title.getAttribute("role")).toBe("presentation");
    expect(menu()!.getAttribute("aria-labelledby")).toBe(title.id);
    expect(items()).toHaveLength(2); // the arrows and the focus see the items only
    expect(document.activeElement).toBe(items()[0]);
    await key(items()[0], "ArrowUp");
    expect(document.activeElement).toBe(items()[1]);
  });

  it("without a title the button names the menu", async () => {
    await draw();
    await click(button());
    expect(menu()!.querySelector("[role=presentation]")).toBeNull();
    expect(menu()!.getAttribute("aria-labelledby")).toBe(button().id);
  });
});

describe("MoreMenu: closing", () => {
  it("Esc closes it and the focus is back on the button", async () => {
    await draw();
    await click(button());
    expect(document.activeElement).toBe(items()[0]);
    await key(items()[0], "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  it("Esc closes only the menu: it goes no further (a drawer around it stays open)", async () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    await draw();
    await click(button());
    await key(items()[0], "Escape");
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outer);
  });

  it("a click outside closes it", async () => {
    await draw();
    await click(button());
    await mouseDownOutside();
    expect(menu()).toBeNull();
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  it("a click inside the menu's own box (its padding) does not close it", async () => {
    await draw();
    await click(button());
    await act(async () => void menu()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(menu()).not.toBeNull();
  });

  it("Tab closes it, and leaves the focus on the button for the Tab to move on from", async () => {
    await draw();
    await click(button());
    await key(items()[0], "Tab");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("leaving the screen takes the listeners with it: nothing is left listening", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    await draw();
    await click(button());
    await act(async () => root.unmount());
    expect(remove.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["mousedown", "touchstart"]));
    root = createRoot(container); // (afterEach unmounts it)
  });
});

describe("MoreMenu: the items", () => {
  it("choosing one calls its onSelect, closes the menu and puts the focus back on the button", async () => {
    const onSelect = vi.fn();
    await draw({ items: [{ label: "Ava järgmine õppetund", onSelect }, { label: "Lõpeta ligipääs" }] });
    await click(button());
    await click(items()[0]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("an item is a button (a browser turns Enter and Space on it into the click)", async () => {
    const onSelect = vi.fn();
    await draw({ items: [{ label: "A", onSelect }, { label: "B" }] });
    await click(button());
    expect(items()[0].tagName).toBe("BUTTON");
    expect((items()[0] as HTMLButtonElement).type).toBe("button");
  });

  it("a danger item carries data-tone=danger; the others do not", async () => {
    await draw();
    await click(button());
    expect(items().map((i) => i.getAttribute("data-tone"))).toEqual([null, "danger"]);
  });

  it("an item with an href is a link (a menuitem all the same); choosing it closes the menu", async () => {
    await draw({ items: [{ label: "Vaata tema vaadet", href: "/admin/vaata?id=5" }, { label: "Testi katsed", onSelect: () => {} }] });
    await click(button());
    container.addEventListener("click", (e) => e.preventDefault()); // happy-dom must not try to follow the link
    const link = items()[0];
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/admin/vaata?id=5");
    expect(link.getAttribute("role")).toBe("menuitem");
    await click(link);
    expect(menu()).toBeNull();
  });

  it("every item is tabindex -1 (the arrows move between them; Tab leaves)", async () => {
    await draw();
    await click(button());
    expect(items().map((i) => i.getAttribute("tabindex"))).toEqual(["-1", "-1"]);
  });

  it("ArrowDown and ArrowUp move between the items and wrap round; Home and End go to the ends", async () => {
    await draw({ items: [{ label: "A" }, { label: "B" }, { label: "C" }] });
    await click(button());
    const [a, b, c] = items();
    await key(a, "ArrowDown");
    expect(document.activeElement).toBe(b);
    await key(b, "ArrowDown");
    expect(document.activeElement).toBe(c);
    await key(c, "ArrowDown");
    expect(document.activeElement).toBe(a);
    await key(a, "ArrowUp");
    expect(document.activeElement).toBe(c);
    await key(c, "Home");
    expect(document.activeElement).toBe(a);
    await key(a, "End");
    expect(document.activeElement).toBe(c);
  });

  it("an item without onSelect or href just closes the menu", async () => {
    await draw({ items: [{ label: "A" }] });
    await click(button());
    await click(items()[0]);
    expect(menu()).toBeNull();
  });

  it("two menus: pressing in the second closes the first (a press outside it)", async () => {
    await act(async () =>
      root.render(
        createElement("div", null, createElement(MoreMenu, { items: [{ label: "A1" }] }), createElement(MoreMenu, { label: "Pikenda", items: [{ label: "B1" }] })),
      ),
    );
    const [first, second] = Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-haspopup=menu]"));
    await click(first);
    expect(container.querySelectorAll("[role=menu]")).toHaveLength(1);
    await act(async () => void second.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await click(second);
    expect(Array.from(container.querySelectorAll("[role=menuitem]")).map((i) => i.textContent)).toEqual(["B1"]);
  });
});

describe("MoreMenu: Space on a link item", () => {
  // An <a> activates on Enter by itself; Space would scroll the page or the drawer. The menu pattern wants both, so Space on a link is taken here:
  // the keydown is default-prevented and the link is clicked. A button item needs nothing (the browser clicks it on Space).
  const press = async (el: Element, k: string) => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    await act(async () => void el.dispatchEvent(e));
    return e;
  };

  it("Space on a link item prevents the scroll and clicks the link: its onSelect runs, the menu closes, the focus is on the button", async () => {
    const onSelect = vi.fn();
    await draw({ items: [{ label: "Vaata tema vaadet", href: "/admin/vaata?id=5", onSelect }, { label: "Testi katsed" }] });
    await click(button());
    const clicked = vi.fn((e: Event) => e.preventDefault()); // happy-dom must not try to follow the link
    container.addEventListener("click", clicked);
    const link = items()[0];
    expect(link.tagName).toBe("A");
    const e = await press(link, " ");
    expect(e.defaultPrevented).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(clicked.mock.calls[0][0].target).toBe(link);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button());
    container.removeEventListener("click", clicked);
  });

  it("Space on a link to another site (a plain <a>) does the same", async () => {
    await draw({ items: [{ label: "Vasta e-kirjaga", href: "mailto:kati@example.test" }] });
    await click(button());
    const clicked = vi.fn((e: Event) => e.preventDefault());
    container.addEventListener("click", clicked);
    const e = await press(items()[0], " ");
    expect(e.defaultPrevented).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    container.removeEventListener("click", clicked);
  });

  it("Space on a button item is left to the browser (it clicks on its own): not prevented, nothing clicked by the menu", async () => {
    const onSelect = vi.fn();
    await draw({ items: [{ label: "A", onSelect }, { label: "B" }] });
    await click(button());
    const clicked = vi.fn();
    container.addEventListener("click", clicked);
    const e = await press(items()[0], " ");
    expect(e.defaultPrevented).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
    container.removeEventListener("click", clicked);
  });

  it("Enter on a link item is the browser's too: the menu does not click it a second time", async () => {
    await draw({ items: [{ label: "Vaata tema vaadet", href: "/admin/vaata?id=5" }] });
    await click(button());
    const clicked = vi.fn((e: Event) => e.preventDefault());
    container.addEventListener("click", clicked);
    const e = await press(items()[0], "Enter");
    expect(e.defaultPrevented).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
    container.removeEventListener("click", clicked);
  });
});

describe("MoreMenu: the trigger's name and its look", () => {
  it("buttonLabel is the trigger's aria-label (a row names its menu: „Veel: Kati Kask“); the drawn text stays „Veel ▾“", async () => {
    await draw({ buttonLabel: "Veel: Kati Kask" });
    expect(button().getAttribute("aria-label")).toBe("Veel: Kati Kask");
    expect(text(button())).toBe("Veel ▾");
    await click(button());
    expect(menu()!.getAttribute("aria-labelledby")).toBe(button().id); // the list is named by it too
  });

  it("without buttonLabel there is no aria-label: the drawn text is the name", async () => {
    await draw();
    expect(button().hasAttribute("aria-label")).toBe(false);
    await draw({ label: "Pikenda" });
    expect(button().hasAttribute("aria-label")).toBe(false);
  });

  it("variant: text to begin with (data-variant=text); pill is the outlined pill of „Pikenda ▾“", async () => {
    await draw();
    expect(button().getAttribute("data-variant")).toBe("text");
    await draw({ label: "Pikenda", variant: "pill" });
    expect(button().getAttribute("data-variant")).toBe("pill");
    expect(text(button())).toBe("Pikenda ▾");
    await draw({ variant: "text" });
    expect(button().getAttribute("data-variant")).toBe("text");
  });

  it("the variant changes the trigger only: the list and its keys are the same", async () => {
    await draw({ label: "Pikenda", variant: "pill", items: [{ label: "+1 kuu" }, { label: "+3 kuud" }] });
    await click(button());
    expect(menu()!.getAttribute("role")).toBe("menu");
    expect(items().map((i) => text(i))).toEqual(["+1 kuu", "+3 kuud"]);
    expect(menu()!.hasAttribute("data-variant")).toBe(false);
    await key(items()[0], "Escape");
    expect(document.activeElement).toBe(button());
  });

  it("the pill is the prototype's: a 44 px outlined pill, 1px ink border on first-light, 0 16px, still 600 12px (the stylesheet)", () => {
    const css = readFileSync(join(process.cwd(), "src/components/admin/MoreMenu.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    };
    const pill = rule('.button[data-variant="pill"]');
    expect(pill).toMatch(/border:\s*1px solid var\(--ink\);/);
    expect(pill).toMatch(/background:\s*var\(--first\);/);
    expect(pill).toMatch(/padding:\s*0 16px;/);
    expect(pill).not.toMatch(/min-height/); // the 44 px of .button stays
    expect(rule(".button")).toMatch(/min-height:\s*44px;/);
    expect(rule(".button")).toMatch(/border-radius:\s*99px;/);
    expect(rule(".button")).toMatch(/font:\s*600 12px/);
  });
});

describe("MoreMenu: the round „↕“ (variant icon, B1 Koolitused on a phone)", () => {
  it("draws its label alone (no ▾), as an icon button; the page names it with buttonLabel", async () => {
    await draw({ label: "↕", variant: "icon", buttonLabel: "Liiguta: Kulmude LAMI", items: [{ label: "Üles" }, { label: "Alla" }] });
    expect(button().getAttribute("data-variant")).toBe("icon");
    expect(text(button())).toBe("↕");
    expect(button().getAttribute("aria-label")).toBe("Liiguta: Kulmude LAMI");
    expect(button().querySelector("[aria-hidden=true]")!.textContent).toBe("↕");
    await click(button());
    expect(items().map((i) => text(i))).toEqual(["Üles", "Alla"]);
  });

  it("is the prototype's circle: 44 px wide and tall, a 1px #d5d0d3 outline, no padding (the stylesheet)", () => {
    const css = readFileSync(join(process.cwd(), "src/components/admin/MoreMenu.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /\.button\[data-variant="icon"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/width:\s*44px;/);
    expect(rule).toMatch(/height:\s*44px;/);
    expect(rule).toMatch(/border:\s*1px solid var\(--heather\);/);
    expect(rule).toMatch(/border-radius:\s*50%;/);
    expect(rule).toMatch(/padding:\s*0;/);
  });
});

describe("MoreMenu: an item that cannot be chosen now (disabled)", () => {
  it("is aria-disabled but stays a button the arrows reach; choosing it does nothing and the menu stays open", async () => {
    const first = vi.fn();
    const second = vi.fn();
    await draw({ items: [{ label: "Üles", disabled: true, onSelect: first }, { label: "Alla", onSelect: second }] });
    await click(button());
    expect(items().map((i) => i.getAttribute("aria-disabled"))).toEqual(["true", null]);
    expect(items()[0].hasAttribute("disabled")).toBe(false);
    await click(items()[0]);
    expect(first).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
    // the arrows still pass over it
    await act(async () => items()[0].focus());
    await key(items()[0], "ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
    await click(items()[1]);
    expect(second).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it("a disabled link item does not go anywhere either", async () => {
    const onSelect = vi.fn();
    await draw({ items: [{ label: "Ava", href: "/admin/x", disabled: true, onSelect }] });
    await click(button());
    const link = items()[0] as HTMLAnchorElement;
    expect(link.getAttribute("aria-disabled")).toBe("true");
    const clicked = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => void link.dispatchEvent(clicked));
    expect(clicked.defaultPrevented).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("is dimmed in the stylesheet (35 %, as the DragList arrows at the ends of a list)", () => {
    const css = readFileSync(join(process.cwd(), "src/components/admin/MoreMenu.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/\.item\[aria-disabled="true"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "").toMatch(/opacity:\s*0\.35;/);
  });
});

describe("MoreMenu: it stays inside the viewport", () => {
  const rect = (x: number, y: number, w: number, h: number): DOMRect => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
  const VIEW = { width: 400, height: 700 };

  describe("menuPlacement", () => {
    it("below and from the button's left edge when it fits", () => {
      expect(menuPlacement(rect(20, 100, 80, 44), { width: 200, height: 120 }, VIEW)).toEqual({ up: false, right: false });
    });

    it("above when it does not fit below and there is more room above", () => {
      expect(menuPlacement(rect(20, 600, 80, 44), { width: 200, height: 160 }, VIEW)).toEqual({ up: true, right: false });
    });

    it("below when it fits neither way but there is more room below", () => {
      expect(menuPlacement(rect(20, 100, 80, 44), { width: 200, height: 900 }, VIEW)).toEqual({ up: false, right: false });
    });

    it("aligned to the button's right edge when it would pass the viewport's right edge", () => {
      expect(menuPlacement(rect(300, 100, 80, 44), { width: 220, height: 120 }, VIEW)).toEqual({ up: false, right: true });
    });

    it("both at once: a button in the bottom right corner", () => {
      expect(menuPlacement(rect(320, 640, 70, 44), { width: 220, height: 160 }, VIEW)).toEqual({ up: true, right: true });
    });

    it("stays left-aligned when aligning right would put the left edge outside the viewport and there is more room to the right", () => {
      expect(menuPlacement(rect(50, 100, 40, 44), { width: 380, height: 100 }, VIEW)).toEqual({ up: false, right: false });
    });

    it("fits neither way: it takes the side with more room — to the left of the button's right edge when that is the roomier", () => {
      // room to the right of the left edge: 400 - 8 - 250 = 142; to the left of the right edge: 290 - 8 = 282
      expect(menuPlacement(rect(250, 100, 40, 44), { width: 380, height: 100 }, VIEW)).toEqual({ up: false, right: true });
    });

    it("fits neither way and the rooms are equal: left-aligned, as when it fits", () => {
      // 400 - 8 - 180 = 212 and 220 - 8 = 212
      expect(menuPlacement(rect(180, 100, 40, 44), { width: 380, height: 100 }, VIEW)).toEqual({ up: false, right: false });
    });

    it("the phone card's two-column grid (pill at 195-343 of 375) lets right alignment fit; the old flex row (pill at 112-206) fits neither way and, with more room to the right, stays left", () => {
      const phone = { width: 375, height: 812 };
      expect(menuPlacement(rect(195, 300, 148, 44), { width: 269, height: 230 }, phone)).toEqual({ up: false, right: true });
      expect(menuPlacement(rect(112, 300, 94, 44), { width: 269, height: 230 }, phone)).toEqual({ up: false, right: false });
    });
  });

  const viewport = () => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: VIEW.width });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: VIEW.height });
  };

  it("the open list carries data-flip=up and data-align=right as measured", async () => {
    vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue(rect(320, 640, 70, 44));
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue(rect(0, 0, 220, 160));
    viewport();
    await draw();
    await click(button());
    expect(menu()!.getAttribute("data-flip")).toBe("up");
    expect(menu()!.getAttribute("data-align")).toBe("right");
  });

  it("with room it opens below and to the left (no attributes)", async () => {
    vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue(rect(20, 100, 80, 44));
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue(rect(0, 0, 200, 100));
    viewport();
    await draw();
    await click(button());
    expect(menu()!.hasAttribute("data-flip")).toBe(false);
    expect(menu()!.hasAttribute("data-align")).toBe(false);
  });
});

describe("MoreMenu: the stylesheet", () => {
  const css = readFileSync(join(process.cwd(), "src/components/admin/MoreMenu.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  };

  it("the button and every item are 44 px targets", () => {
    expect(rule(".button")).toMatch(/min-height:\s*44px;/);
    expect(rule(".item")).toMatch(/min-height:\s*44px;/);
  });

  it("the list is as wide as its longest item, never wider than 320 px nor than the screen leaves room for (100vw - 16px)", () => {
    expect(rule(".menu")).toMatch(/max-width:\s*min\(320px, calc\(100vw - 16px\)\);/);
  });

  it("the list sits under the button and flips up / aligns right on the attributes the component sets", () => {
    expect(rule(".menu")).toMatch(/position:\s*absolute;/);
    expect(rule('.menu[data-flip="up"]')).toMatch(/bottom:\s*100%;/);
    expect(rule('.menu[data-align="right"]')).toMatch(/right:\s*0;/);
  });

  it("a danger item is in the admin's red", () => {
    expect(rule('.item[data-tone="danger"]')).toMatch(/color:\s*var\(--bad\);/);
  });

  it("the keyboard ring is the admin's: 2px rose, offset 2", () => {
    expect(rule(".button:focus-visible")).toMatch(/outline:\s*2px solid var\(--rose\);/);
    expect(rule(".item:focus-visible")).toMatch(/outline:\s*2px solid var\(--rose\);/);
  });
});

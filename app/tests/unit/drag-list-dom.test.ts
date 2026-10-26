// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DragList, type DragRowTools } from "@/components/admin/DragList";

// DragList (the B screens, Task 1; README B1 „⋮⋮ (pointer + touch, aria-roledescription="lohistatav")“ | ↑/↓, B2 „drag + ↑/↓“): the shared order control of the
// course list, the module rows and the list editors. A row is moved three ways, and each one calls `onMove(from, to)` once and announces it (piece 3
// texts S3-P3-m): by dragging the handle (pointer events with capture, so a finger works on an old iPad), by the ↑ / ↓ buttons, and by the arrow keys
// on the handle. The focus stays on the control that moved the row, even when the browser drops it as the row's node is moved.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Item = { id: string; name: string };
const ITEMS: Item[] = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
  { id: "c", name: "C" },
];
const ROW = 100; // the height of a row in the faked layout

let container: HTMLDivElement;
let root: Root;
let restoreRect: () => void;

type Over = {
  items?: Item[];
  label?: (item: Item, index: number) => string;
  disabled?: boolean;
  /** Called with the move before the harness reorders its list (a test makes the browser drop the focus here). */
  before?: () => void;
  /** false: the parent keeps the order as it is (a failed move, or a parent that does not reorder). */
  reorder?: boolean;
  /** The reordering waits here until the test runs it (a move that waits for the server). */
  defer?: Array<() => void>;
  className?: string;
  rowClassName?: string;
  onMove?: (from: number, to: number) => void;
  seen?: (args: { item: Item; index: number; handle: ReactNode; arrows: ReactNode; tools: DragRowTools }) => void;
  /** The page's own trigger in each row (the phone's „↕“ menu): a button marked data-drag-tool="menu", or a wrapper with a button in it. It moves its row to `menuTo`. */
  menu?: "button" | "wrapper";
  menuTo?: number;
  arrowNames?: (n: number) => { up: string; down: string };
  /** "grid": the rows stand in a grid (Koolitaja's gallery tiles); `after`: a last cell that is no row (its „+ Lisa“ tile). */
  layout?: "list" | "grid";
  after?: ReactNode;
};

/** A parent that keeps the order, as the editors do. */
function Harness({ items: initial = ITEMS, label = (item) => item.name, disabled, before, reorder = true, defer, className, rowClassName, onMove, seen, menu, menuTo = 0, arrowNames, layout, after }: Over) {
  const [items, setItems] = useState(initial);
  return createElement(DragList<Item>, {
    items,
    keyOf: (item) => item.id,
    label,
    arrowNames,
    layout,
    after,
    disabled,
    className,
    rowClassName,
    onMove: (from, to) => {
      onMove?.(from, to);
      before?.();
      if (!reorder) return;
      const apply = () =>
        setItems((list) => {
          const next = [...list];
          next.splice(to, 0, next.splice(from, 1)[0]);
          return next;
        });
      if (defer) defer.push(apply);
      else apply();
    },
    renderRow: (item, index, handle, arrows, tools) => {
      seen?.({ item, index, handle, arrows, tools });
      const trigger = createElement("button", { type: "button", "data-menu-button": "", ...(menu === "button" ? { "data-drag-tool": "menu" } : {}), onClick: () => tools.moveTo(menuTo) }, "↕");
      return createElement(
        "div",
        { "data-test-row": item.id },
        createElement("span", { "data-name": "" }, item.name),
        handle,
        arrows,
        menu === "button" ? trigger : menu === "wrapper" ? createElement("span", { "data-drag-tool": "menu" }, trigger) : null,
      );
    },
  });
}

const draw = (over: Over = {}) => act(async () => root.render(createElement(Harness, over)));

const rows = () => Array.from(container.querySelectorAll<HTMLElement>("[data-drag-row]"));
const order = () => rows().map((r) => r.querySelector("[data-name]")!.textContent);
const row = (id: string) => container.querySelector<HTMLElement>(`[data-drag-row="${id}"]`)!;
const tool = (id: string, which: "handle" | "up" | "down") => row(id).querySelector<HTMLButtonElement>(`[data-drag-tool="${which}"]`)!;
const live = () => container.querySelector<HTMLElement>("[role=status]")!;
const list = () => container.querySelector<HTMLElement>("[data-drag-list]")!;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element) => act(async () => void (el as HTMLElement).click());
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })));
const menuButton = (id: string) => row(id).querySelector<HTMLButtonElement>("[data-menu-button]")!;

type Pointer = { pointerId?: number; pointerType?: string; button?: number; clientX?: number; clientY?: number };
const pointer = (el: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", init: Pointer = {}) =>
  act(async () => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", button: 0, isPrimary: true, ...init })));
/** A finger on the handle of `id`: down at the middle of its row, then to `y`, then up (or not: `release: false`). */
async function drag(id: string, y: number, init: Pointer & { release?: boolean } = {}) {
  const { release = true, ...p } = init;
  const handle = tool(id, "handle");
  const start = rows().indexOf(row(id)) * ROW + ROW / 2;
  await pointer(handle, "pointerdown", { clientY: start, ...p });
  await pointer(handle, "pointermove", { clientY: y, ...p });
  if (release) await pointer(handle, "pointerup", { clientY: y, ...p });
}

beforeEach(() => {
  // no layout in happy-dom: a row is 100 px tall and sits at its place among its siblings
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (!this.hasAttribute("data-drag-row")) return original.call(this);
    const top = Array.prototype.indexOf.call(this.parentElement!.children, this) * ROW;
    return { top, bottom: top + ROW, left: 0, right: 300, width: 300, height: ROW, x: 0, y: top, toJSON: () => ({}) };
  };
  restoreRect = () => void (HTMLElement.prototype.getBoundingClientRect = original);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restoreRect();
  vi.restoreAllMocks();
});

describe("DragList: the handle and the arrows", () => {
  it("a handle „⋮⋮“ is a button named „Lohista: {nimi}“ and called „lohistatav“; the arrows name the row too", async () => {
    await draw();
    const handle = tool("b", "handle");
    expect(handle.tagName).toBe("BUTTON");
    expect(handle.type).toBe("button");
    expect(text(handle)).toBe("⋮⋮");
    expect(handle.getAttribute("aria-roledescription")).toBe("lohistatav");
    expect(handle.getAttribute("aria-label")).toBe("Lohista: B");
    expect(tool("b", "up").getAttribute("aria-label")).toBe("Liiguta üles: B");
    expect(tool("b", "down").getAttribute("aria-label")).toBe("Liiguta alla: B");
    expect(text(tool("b", "up"))).toBe("↑");
    expect(text(tool("b", "down"))).toBe("↓");
  });

  it("a row with no name of its own is „rida {n}“, counted from 1", async () => {
    await draw({ label: () => "" });
    expect(tool("b", "handle").getAttribute("aria-label")).toBe("Lohista rida 2");
    expect(tool("b", "up").getAttribute("aria-label")).toBe("Liiguta rida 2 üles");
    expect(tool("b", "down").getAttribute("aria-label")).toBe("Liiguta rida 2 alla");
  });

  it("`arrowNames` gives the arrows a list's own words (the gallery's „Liiguta pilt {n} ettepoole“); the handle and the announcement keep the row forms", async () => {
    await draw({ label: () => "", arrowNames: (n) => ({ up: `Liiguta pilt ${n} ettepoole`, down: `Liiguta pilt ${n} tahapoole` }) });
    expect(tool("b", "up").getAttribute("aria-label")).toBe("Liiguta pilt 2 ettepoole");
    expect(tool("b", "down").getAttribute("aria-label")).toBe("Liiguta pilt 2 tahapoole");
    expect(tool("b", "handle").getAttribute("aria-label")).toBe("Lohista rida 2");
    await click(tool("b", "up"));
    expect(text(live())).toBe("Rida 2 on nüüd 1. kohal.");
  });

  it("the label is asked for each row with its current index", async () => {
    const label = vi.fn<(item: Item, index: number) => string>((item) => item.name);
    await draw({ label });
    expect(label.mock.calls.map(([item, index]) => [item.id, index])).toEqual(expect.arrayContaining([["a", 0], ["b", 1], ["c", 2]]));
  });

  it("the page's row gets the item, its index, the handle and the arrows; the list is an ordered list of rows", async () => {
    const seen = vi.fn();
    await draw({ seen });
    const b = seen.mock.calls.map(([x]) => x).find((x) => x.item.id === "b");
    expect(b.index).toBe(1);
    expect(b.handle).not.toBeNull();
    expect(b.arrows).not.toBeNull();
    expect(list().tagName).toBe("OL");
    expect(rows().map((r) => r.tagName)).toEqual(["LI", "LI", "LI"]);
    expect(order()).toEqual(["A", "B", "C"]);
  });

  it("the page's classes go on the list and on each row, next to the component's own", async () => {
    await draw({ className: "page-list", rowClassName: "page-row" });
    expect(list().classList.contains("page-list")).toBe(true);
    expect(rows().every((r) => r.classList.contains("page-row"))).toBe(true);
    expect(list().classList.length).toBe(2);
    expect(rows()[0].classList.length).toBe(2);
  });

  it("↑ on the second row moves it first: onMove(1, 0), once; ↓ moves it down: onMove(1, 2)", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    await click(tool("b", "up"));
    expect(onMove.mock.calls).toEqual([[1, 0]]);
    onMove.mockClear();
    await click(tool("b", "down"));
    expect(onMove.mock.calls).toEqual([[1, 2]]);
  });

  it("the arrows are aria-disabled at the ends (↑ of the first row, ↓ of the last), never disabled, and do nothing", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    expect(tool("a", "up").getAttribute("aria-disabled")).toBe("true");
    expect(tool("a", "down").getAttribute("aria-disabled")).toBeNull();
    expect(tool("c", "down").getAttribute("aria-disabled")).toBe("true");
    expect(tool("c", "up").getAttribute("aria-disabled")).toBeNull();
    expect(tool("b", "up").getAttribute("aria-disabled")).toBeNull();
    expect(tool("b", "down").getAttribute("aria-disabled")).toBeNull();
    expect(tool("a", "up").disabled).toBe(false);
    expect(tool("c", "down").disabled).toBe(false);
    await click(tool("a", "up"));
    await click(tool("c", "down"));
    expect(onMove).not.toHaveBeenCalled();
    expect(live().textContent).toBe("");
  });

  it("a list of one row has no move to make", async () => {
    await draw({ items: [ITEMS[0]] });
    expect(tool("a", "up").getAttribute("aria-disabled")).toBe("true");
    expect(tool("a", "down").getAttribute("aria-disabled")).toBe("true");
  });

  it("the arrow keys on the handle move the row one place, as the arrows do", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    await key(tool("b", "handle"), "ArrowUp");
    await key(tool("b", "handle"), "ArrowDown");
    expect(onMove.mock.calls).toEqual([[1, 0], [1, 2]]);
    onMove.mockClear();
    await key(tool("a", "handle"), "ArrowUp");
    await key(tool("c", "handle"), "ArrowDown");
    expect(onMove).not.toHaveBeenCalled();
  });

  it("with Ctrl, Cmd, Alt or Shift down the arrow keys are the browser's and the screen reader's: no move, and the key is not taken", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
      for (const k of ["ArrowUp", "ArrowDown"]) {
        const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
        await act(async () => void tool("b", "handle").dispatchEvent(e));
        expect(e.defaultPrevented).toBe(false);
      }
    }
    expect(onMove).not.toHaveBeenCalled();
    expect(live().textContent).toBe("");
    const plain = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    await act(async () => void tool("b", "handle").dispatchEvent(plain));
    expect(plain.defaultPrevented).toBe(true);
    expect(onMove.mock.calls).toEqual([[1, 0]]);
  });
});

describe("DragList: a move the page draws itself (tools.moveTo, the phone's „↕“ menu)", () => {
  it("renderRow gets a fifth argument with moveTo, also while the list is disabled", async () => {
    const seen = vi.fn();
    await draw({ seen });
    expect(seen.mock.calls.every(([x]) => typeof x.tools.moveTo === "function")).toBe(true);
    seen.mockClear();
    await draw({ seen, disabled: true });
    expect(seen.mock.calls.every(([x]) => typeof x.tools.moveTo === "function")).toBe(true);
  });

  it("moveTo(0) on the last row is onMove(2, 0), once, announced as any move is", async () => {
    const onMove = vi.fn();
    await draw({ onMove, menu: "button", menuTo: 0 });
    await click(menuButton("c"));
    expect(onMove.mock.calls).toEqual([[2, 0]]);
    expect(order()).toEqual(["C", "A", "B"]);
    expect(text(live())).toBe("„C“ on nüüd 1. kohal.");
  });

  it("the move to the last place is announced by number for a row with no name", async () => {
    const onMove = vi.fn();
    await draw({ onMove, menu: "button", menuTo: 2, label: () => "" });
    await click(menuButton("a"));
    expect(onMove.mock.calls).toEqual([[0, 2]]);
    expect(text(live())).toBe("Rida 1 on nüüd 3. kohal.");
  });

  it("the focus comes back to the row's trigger marked data-drag-tool=\"menu\", where the browser drops it as the row moves", async () => {
    await draw({ menu: "button", menuTo: 0, before: () => (document.activeElement as HTMLElement | null)?.blur() });
    menuButton("c").focus();
    await click(menuButton("c"));
    expect(order()).toEqual(["C", "A", "B"]);
    expect(document.activeElement).toBe(menuButton("c"));
  });

  it("a marked wrapper will do: the button inside it takes the focus", async () => {
    await draw({ menu: "wrapper", menuTo: 0, before: () => (document.activeElement as HTMLElement | null)?.blur() });
    menuButton("b").focus();
    await click(menuButton("b"));
    expect(order()).toEqual(["B", "A", "C"]);
    expect(document.activeElement).toBe(menuButton("b"));
  });

  it("and a reorder that waits for the server gives it back later", async () => {
    const later: Array<() => void> = [];
    await draw({ menu: "button", menuTo: 0, defer: later });
    menuButton("c").focus();
    await click(menuButton("c"));
    expect(order()).toEqual(["A", "B", "C"]);
    (document.activeElement as HTMLElement).blur();
    await act(async () => later.forEach((run) => run()));
    expect(order()).toEqual(["C", "A", "B"]);
    expect(document.activeElement).toBe(menuButton("c"));
  });

  it("no move for the row's own place, a place outside the list, or a disabled list", async () => {
    const onMove = vi.fn();
    const seen = vi.fn();
    await draw({ onMove, seen, reorder: false });
    const b = seen.mock.calls.map(([x]) => x).find((x) => x.item.id === "b");
    b.tools.moveTo(1);
    b.tools.moveTo(-1);
    b.tools.moveTo(3);
    expect(onMove).not.toHaveBeenCalled();
    expect(live().textContent).toBe("");
    seen.mockClear();
    await draw({ onMove, seen, reorder: false, disabled: true });
    seen.mock.calls.map(([x]) => x).find((x) => x.item.id === "b").tools.moveTo(0);
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe("DragList: disabled", () => {
  it("hides the handles and the arrows (a filtered view): the rows stay, and the page's row is handed nothing to draw", async () => {
    const seen = vi.fn();
    await draw({ disabled: true, seen });
    expect(order()).toEqual(["A", "B", "C"]);
    expect(container.querySelectorAll("[data-drag-tool]")).toHaveLength(0);
    expect(container.querySelector("[aria-roledescription]")).toBeNull();
    expect(seen.mock.calls.every(([x]) => x.handle === null && x.arrows === null)).toBe(true);
  });

  it("turning it on during a drag ends the drag without a move", async () => {
    const onMove = vi.fn();
    await draw({ onMove });
    await drag("a", 290, { release: false });
    await draw({ onMove, disabled: true });
    expect(onMove).not.toHaveBeenCalled();
    expect(container.querySelector("[data-dragging]")).toBeNull();
  });
});

describe("DragList: dragging the handle", () => {
  it("dragging the first row below the third calls onMove(0, 2) once, on the drop", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    const capture = vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => {});
    const handle = tool("a", "handle");
    await pointer(handle, "pointerdown", { clientY: 50, pointerId: 7 });
    expect(capture).toHaveBeenCalledWith(7);
    await pointer(handle, "pointermove", { clientY: 150, pointerId: 7 });
    await pointer(handle, "pointermove", { clientY: 300, pointerId: 7 });
    expect(onMove).not.toHaveBeenCalled();
    await pointer(handle, "pointerup", { clientY: 300, pointerId: 7 });
    expect(onMove.mock.calls).toEqual([[0, 2]]);
  });

  it("the parent's order follows the drop", async () => {
    await draw();
    await drag("a", 300);
    expect(order()).toEqual(["B", "C", "A"]);
  });

  it("dragging the last row to the top calls onMove(2, 0)", async () => {
    const onMove = vi.fn();
    await draw({ onMove });
    await drag("c", 10);
    expect(onMove.mock.calls).toEqual([[2, 0]]);
    expect(order()).toEqual(["C", "A", "B"]);
  });

  it("the row lands in the place whose middle is nearest to its own: just over half a row's way is one place, less is none", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    await drag("a", 50 + 49); // its middle is at 99: nearer to A's own middle (50) than to B's (150)
    expect(onMove).not.toHaveBeenCalled();
    await drag("a", 50 + 51); // 101: nearer to B's
    expect(onMove.mock.calls).toEqual([[0, 1]]);
    onMove.mockClear();
    await drag("b", 150 - 49); // 101 again, seen from below
    expect(onMove).not.toHaveBeenCalled();
    await drag("b", 150 - 51); // 99
    expect(onMove.mock.calls).toEqual([[1, 0]]);
  });

  it("a drag past the ends of the list stops at the first and the last place", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    await drag("b", 9999);
    await drag("b", -9999);
    expect(onMove.mock.calls).toEqual([[1, 2], [1, 0]]);
  });

  it("a drop on the row's own place is no move", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    await drag("b", 150 + 30);
    await pointer(tool("b", "handle"), "pointerdown", { clientY: 150 });
    await pointer(tool("b", "handle"), "pointermove", { clientY: 290 });
    await pointer(tool("b", "handle"), "pointermove", { clientY: 150 }); // down and back
    await pointer(tool("b", "handle"), "pointerup", { clientY: 150 });
    expect(onMove).not.toHaveBeenCalled();
    expect(live().textContent).toBe("");
  });

  it("a touch that hardly moves is a tap, not a drag: nothing lifts, nothing moves", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    const handle = tool("a", "handle");
    await pointer(handle, "pointerdown", { clientY: 50 });
    await pointer(handle, "pointermove", { clientY: 53 });
    expect(container.querySelector("[data-dragging]")).toBeNull();
    await pointer(handle, "pointerup", { clientY: 53 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("while a row is dragged it is marked, and the rows it passes make room: up when it goes down, down when it goes up; all of it ends on the drop", async () => {
    await draw({ reorder: false });
    await drag("a", 250, { release: false }); // as far down as the list goes: the third place
    expect(list().hasAttribute("data-dragging")).toBe(true);
    expect(row("a").hasAttribute("data-dragging")).toBe(true);
    expect(row("a").hasAttribute("data-shift")).toBe(false);
    expect(row("b").getAttribute("data-shift")).toBe("up");
    expect(row("c").getAttribute("data-shift")).toBe("up");
    await pointer(tool("a", "handle"), "pointermove", { clientY: 120 }); // back to the second place
    expect(row("b").getAttribute("data-shift")).toBe("up");
    expect(row("c").getAttribute("data-shift")).toBeNull();
    await pointer(tool("a", "handle"), "pointerup", { clientY: 120 });
    expect(container.querySelector("[data-dragging]")).toBeNull();
    expect(container.querySelector("[data-shift]")).toBeNull();

    await drag("c", 20, { release: false });
    expect(row("c").hasAttribute("data-dragging")).toBe(true);
    expect(row("a").getAttribute("data-shift")).toBe("down");
    expect(row("b").getAttribute("data-shift")).toBe("down");
    await pointer(tool("c", "handle"), "pointerup", { clientY: 20 });
    expect(container.querySelector("[data-shift]")).toBeNull();
  });

  it("the dragged row follows the finger: it carries the distance (--drag-dy), the list the step the others make room by (--drag-step)", async () => {
    await draw({ reorder: false });
    await drag("a", 170, { release: false });
    expect(row("a").style.getPropertyValue("--drag-dy")).toBe("120px");
    expect(list().style.getPropertyValue("--drag-step")).toBe(`${ROW}px`);
    // only the dragged row is restyled as the pointer moves, not every row through the list's inheritance
    expect(list().style.getPropertyValue("--drag-dy")).toBe("");
    expect(row("b").style.getPropertyValue("--drag-dy")).toBe("");
    await pointer(tool("a", "handle"), "pointerup", { clientY: 170 });
    expect(row("a").style.getPropertyValue("--drag-dy")).toBe("");
    expect(list().style.getPropertyValue("--drag-step")).toBe("");
  });

  it("the dragged row stays inside the list: it does not follow the finger past the first or the last row", async () => {
    await draw({ reorder: false });
    await drag("a", 5000, { release: false });
    expect(row("a").style.getPropertyValue("--drag-dy")).toBe("200px"); // up to the last row's place
    await pointer(tool("a", "handle"), "pointermove", { clientY: -5000 });
    expect(row("a").style.getPropertyValue("--drag-dy")).toBe("0px");
  });

  it("pointercancel ends the drag with no move (the browser took the touch)", async () => {
    const onMove = vi.fn();
    await draw({ onMove });
    await drag("a", 300, { release: false });
    await pointer(tool("a", "handle"), "pointercancel", { clientY: 300 });
    expect(onMove).not.toHaveBeenCalled();
    expect(container.querySelector("[data-dragging]")).toBeNull();
    expect(order()).toEqual(["A", "B", "C"]);
  });

  it("Esc ends the drag with no move, and the pointer's release after it moves nothing either", async () => {
    const onMove = vi.fn();
    await draw({ onMove });
    await drag("a", 300, { release: false });
    await key(tool("a", "handle"), "Escape");
    expect(container.querySelector("[data-dragging]")).toBeNull();
    await pointer(tool("a", "handle"), "pointerup", { clientY: 300 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("a second finger or another pointer does not steer the drag", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    const handle = tool("a", "handle");
    await pointer(handle, "pointerdown", { clientY: 50, pointerId: 1 });
    await pointer(handle, "pointermove", { clientY: 150, pointerId: 1 });
    await pointer(handle, "pointermove", { clientY: 300, pointerId: 2 });
    await pointer(handle, "pointerup", { clientY: 300, pointerId: 2 });
    expect(onMove).not.toHaveBeenCalled();
    await pointer(handle, "pointerup", { clientY: 150, pointerId: 1 });
    expect(onMove.mock.calls).toEqual([[0, 1]]);
  });

  it("a second press while the first holds its pointer does not take the drag over", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => {});
    const handle = tool("a", "handle");
    await pointer(handle, "pointerdown", { clientY: 50, pointerId: 1 });
    await pointer(tool("b", "handle"), "pointerdown", { clientY: 150, pointerId: 2 });
    await pointer(handle, "pointermove", { clientY: 150, pointerId: 1 });
    await pointer(handle, "pointerup", { clientY: 150, pointerId: 1 });
    expect(onMove.mock.calls).toEqual([[0, 1]]);
  });

  it("a pointer the browser would not capture may never end: the next press takes the drag over instead of being ignored", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => {
      throw new Error("InvalidStateError");
    });
    const handle = tool("a", "handle");
    await pointer(handle, "pointerdown", { clientY: 50, pointerId: 1 });
    await pointer(handle, "pointermove", { clientY: 150, pointerId: 1 }); // (and no pointerup ever comes)
    expect(row("a").hasAttribute("data-dragging")).toBe(true);
    await pointer(handle, "pointerdown", { clientY: 50, pointerId: 2 });
    expect(container.querySelector("[data-dragging]")).toBeNull(); // the first drag ended with no move
    expect(onMove).not.toHaveBeenCalled();
    await pointer(handle, "pointermove", { clientY: 300, pointerId: 2 });
    await pointer(handle, "pointerup", { clientY: 300, pointerId: 2 });
    expect(onMove.mock.calls).toEqual([[0, 2]]);
  });

  it("a mouse drags with its main button only", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    await drag("a", 300, { pointerType: "mouse", button: 2 });
    expect(onMove).not.toHaveBeenCalled();
    await drag("a", 300, { pointerType: "mouse", button: 0 });
    expect(onMove.mock.calls).toEqual([[0, 2]]);
  });

  it("only the handle starts a drag: a press on the row, on an arrow or on a field in it does not", async () => {
    const onMove = vi.fn();
    await draw({ onMove, reorder: false });
    for (const el of [row("a"), tool("a", "down"), row("a").querySelector("[data-name]")!]) {
      await pointer(el, "pointerdown", { clientY: 50 });
      await pointer(el, "pointermove", { clientY: 300 });
      await pointer(el, "pointerup", { clientY: 300 });
    }
    expect(onMove).not.toHaveBeenCalled();
    expect(container.querySelector("[data-dragging]")).toBeNull();
  });

  it("a changed order under a drag (the page moved a row meanwhile) ends it without a move", async () => {
    const onMove = vi.fn();
    await draw({ onMove });
    await drag("a", 300, { release: false });
    expect(container.querySelector("[data-dragging]")).not.toBeNull();
    await click(tool("c", "up"));
    expect(container.querySelector("[data-dragging]")).toBeNull();
    await pointer(tool("a", "handle"), "pointerup", { clientY: 300 });
    expect(onMove.mock.calls).toEqual([[2, 1]]);
  });
});

describe("DragList: the announcement (S3-P3-m)", () => {
  it("is a polite status region that is there from the start", async () => {
    await draw();
    expect(live().getAttribute("aria-live")).toBe("polite");
    expect(live().getAttribute("aria-atomic")).toBe("true");
    expect(live().textContent).toBe("");
  });

  it("after ↑ on B it reads „B“ on nüüd 1. kohal.", async () => {
    await draw();
    await click(tool("b", "up"));
    expect(text(live())).toBe("„B“ on nüüd 1. kohal.");
  });

  it("after ↓ and after a drop it gives the new place", async () => {
    await draw();
    await click(tool("a", "down"));
    expect(text(live())).toBe("„A“ on nüüd 2. kohal.");
    await drag("a", 300);
    expect(text(live())).toBe("„A“ on nüüd 3. kohal.");
  });

  it("after a key on the handle too", async () => {
    await draw();
    await key(tool("c", "handle"), "ArrowUp");
    expect(text(live())).toBe("„C“ on nüüd 2. kohal.");
  });

  it("a row with no name is „Rida {n} on nüüd {k}. kohal.“, n the row's number before the move", async () => {
    await draw({ label: () => "" });
    await click(tool("c", "up"));
    expect(text(live())).toBe("Rida 3 on nüüd 2. kohal.");
    await drag("a", 300);
    expect(text(live())).toBe("Rida 1 on nüüd 3. kohal.");
  });

  it("the same words twice are read twice: the region gets a new node each time", async () => {
    await draw({ reorder: false });
    await click(tool("a", "down"));
    const first = live().firstElementChild;
    expect(text(live())).toBe("„A“ on nüüd 2. kohal.");
    await click(tool("a", "down"));
    expect(text(live())).toBe("„A“ on nüüd 2. kohal.");
    expect(live().firstElementChild).not.toBe(first);
  });
});

describe("DragList: the focus", () => {
  /** What a browser does when it moves a focused node in the DOM: the focus is gone. */
  const dropFocus = () => (document.activeElement as HTMLElement | null)?.blur();

  it("stays on the ↑ that moved the row, even where the browser drops it, also when the row is at the top now", async () => {
    await draw({ before: dropFocus });
    tool("b", "up").focus();
    await click(tool("b", "up"));
    expect(order()).toEqual(["B", "A", "C"]);
    expect(document.activeElement).toBe(tool("b", "up"));
    expect(tool("b", "up").getAttribute("aria-disabled")).toBe("true");
  });

  it("stays on the ↓ that moved the row", async () => {
    await draw({ before: dropFocus });
    tool("b", "down").focus();
    await click(tool("b", "down"));
    expect(order()).toEqual(["A", "C", "B"]);
    expect(document.activeElement).toBe(tool("b", "down"));
  });

  it("stays on the handle after a drop, and after a key on it", async () => {
    await draw({ before: dropFocus });
    await drag("a", 300);
    expect(order()).toEqual(["B", "C", "A"]);
    expect(document.activeElement).toBe(tool("a", "handle"));
    dropFocus();
    await key(tool("a", "handle"), "ArrowUp");
    expect(order()).toEqual(["B", "A", "C"]);
    expect(document.activeElement).toBe(tool("a", "handle"));
  });

  it("is given back when the parent reorders later than the click (a move that waits for the server)", async () => {
    const later: Array<() => void> = [];
    await draw({ defer: later });
    tool("b", "up").focus();
    await click(tool("b", "up"));
    expect(order()).toEqual(["A", "B", "C"]);
    dropFocus();
    await act(async () => later.forEach((run) => run()));
    expect(order()).toEqual(["B", "A", "C"]);
    expect(document.activeElement).toBe(tool("b", "up"));
  });

  it("is not given back to a reader who has gone on to a field elsewhere while the page was reordering", async () => {
    const later: Array<() => void> = [];
    const other = document.createElement("input");
    document.body.append(other);
    try {
      await draw({ defer: later });
      tool("b", "up").focus();
      await click(tool("b", "up"));
      other.focus();
      await act(async () => later.forEach((run) => run()));
      expect(order()).toEqual(["B", "A", "C"]);
      expect(document.activeElement).toBe(other);
    } finally {
      other.remove();
    }
  });

  it("is given back when it is still in the moved row (the arrow that was pressed) or on the body", async () => {
    const later: Array<() => void> = [];
    await draw({ defer: later });
    tool("b", "down").focus();
    await click(tool("b", "down"));
    tool("b", "up").focus(); // another control of the same row
    await act(async () => later.forEach((run) => run()));
    expect(order()).toEqual(["A", "C", "B"]);
    expect(document.activeElement).toBe(tool("b", "down"));
  });
});

// layout "grid" (piece 4a, Task 5, R-g: Koolitaja's gallery tiles): the rows stand in a grid, so a drag goes in both directions — the place it lands
// in is the one whose middle is nearest in both; a row it passes moves to its neighbour's place (which may be on the row above or below); ArrowLeft and
// ArrowRight on the handle move one place too. `after` is a last cell of the list that is no row (the „+ Lisa“ tile): no drag lands on it.
describe("DragList: layout „grid“", () => {
  /** Three columns of 150 × 100 px, row after row (only the rows: the `after` cell is no row). */
  const gridRects = () => {
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (!this.hasAttribute("data-drag-row")) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
      const i = Array.prototype.filter.call(this.parentElement!.children, (el: Element) => el.hasAttribute("data-drag-row")).indexOf(this);
      const left = (i % 3) * 150;
      const top = Math.floor(i / 3) * ROW;
      return { top, bottom: top + ROW, left, right: left + 150, width: 150, height: ROW, x: left, y: top, toJSON: () => ({}) };
    };
  };
  const FIVE: Item[] = ["a", "b", "c", "d", "e"].map((id) => ({ id, name: id.toUpperCase() }));
  const at = (el: Element, type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number) => pointer(el, type, { clientX, clientY });

  it("a row dragged across and down lands on the place nearest in both directions, once; the `after` cell stays last and is no row", async () => {
    gridRects();
    const onMove = vi.fn();
    await draw({ items: FIVE, layout: "grid", onMove, after: createElement("span", { "data-after": "" }, "+ Lisa") });
    expect(list().lastElementChild!.hasAttribute("data-drag-row")).toBe(false);
    expect(text(list().lastElementChild)).toBe("+ Lisa");
    const handle = tool("a", "handle");
    await at(handle, "pointerdown", 75, 50);
    // to the middle of the second row's second place (d, e on the row under a b c): e's place
    await at(handle, "pointermove", 230, 160);
    expect(row("a").style.getPropertyValue("--drag-dx")).toBe("155px");
    expect(row("a").style.getPropertyValue("--drag-dy")).toBe("100px");
    // the rows it passes move to their neighbour's place: b to a's, d (first on the row below) up to c's
    expect(row("b").getAttribute("data-shift")).toBe("up");
    expect(row("b").style.getPropertyValue("--to-prev-x")).toBe("-150px");
    expect(row("d").style.getPropertyValue("--to-prev-x")).toBe("300px");
    expect(row("d").style.getPropertyValue("--to-prev-y")).toBe("-100px");
    await at(handle, "pointerup", 230, 160);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(0, 4);
    expect(order()).toEqual(["B", "C", "D", "E", "A"]);
    expect(text(live())).toBe("„A“ on nüüd 5. kohal.");
    // the drag leaves nothing behind
    for (const id of ["a", "b", "d"]) for (const p of ["--drag-dx", "--drag-dy", "--to-prev-x", "--to-prev-y", "--to-next-x", "--to-next-y"]) expect(row(id).style.getPropertyValue(p)).toBe("");
  });

  it("in a list the same move across is no move (a list's drag goes up and down only)", async () => {
    gridRects();
    const onMove = vi.fn();
    await draw({ items: FIVE, onMove });
    const handle = tool("a", "handle");
    await at(handle, "pointerdown", 75, 50);
    await at(handle, "pointermove", 380, 55);
    await at(handle, "pointerup", 380, 55);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("ArrowRight and ArrowLeft on the handle move one place in a grid (in a list they do nothing)", async () => {
    const onMove = vi.fn();
    await draw({ layout: "grid", onMove });
    await key(tool("a", "handle"), "ArrowRight");
    expect(order()).toEqual(["B", "A", "C"]);
    await key(tool("a", "handle"), "ArrowLeft");
    expect(order()).toEqual(["A", "B", "C"]);
    expect(onMove.mock.calls).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(document.activeElement).toBe(tool("a", "handle"));
    await act(async () => root.unmount());
    root = createRoot(container);
    onMove.mockClear();
    await draw({ onMove });
    await key(tool("a", "handle"), "ArrowRight");
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe("DragList: the stylesheet", () => {
  const raw = readFileSync(join(process.cwd(), "src/components/admin/DragList.module.css"), "utf8");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  };

  it("touch-action: none is on the handle and nowhere else (the rest of the row still scrolls the page)", () => {
    expect(rule(".handle")).toMatch(/touch-action:\s*none;/);
    expect(css.match(/touch-action:\s*none/g)).toHaveLength(1);
  });

  it("the handle and the arrows are 44 px targets with the admin's focus ring", () => {
    expect(rule(".handle")).toMatch(/min-width:\s*44px;/);
    expect(rule(".handle")).toMatch(/min-height:\s*44px;/);
    expect(rule(".arrow")).toMatch(/width:\s*44px;/);
    expect(rule(".arrow")).toMatch(/height:\s*44px;/);
    expect(css).toMatch(/\.handle:focus-visible,?[^{]*\{[^}]*outline:\s*2px solid var\(--rose\);[^}]*outline-offset:\s*2px;/);
    expect(css).toMatch(/\.arrow:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--rose\);[^}]*outline-offset:\s*2px;/);
  });

  it("the arrows at the ends are drawn at 35 % and are not a pointer target", () => {
    expect(css).toMatch(/\.arrow\[aria-disabled="true"\]\s*\{[^}]*opacity:\s*0\.35;/);
  });

  it("the dragged row takes the row highlight and follows the finger; the others make room (no motion under reduced motion)", () => {
    expect(css).toMatch(/\.row\[data-dragging\]\s*\{[^}]*translateY\(var\(--drag-dy/);
    expect(css).toMatch(/\.row\[data-shift="up"\]\s*\{[^}]*translateY\(calc\(var\(--drag-step[^)]*\) \* -1\)\)/);
    expect(css).toMatch(/\.row\[data-shift="down"\]\s*\{[^}]*translateY\(var\(--drag-step/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*transition:\s*none/);
  });

  it("in a grid the dragged row goes both ways, and a row making room goes to its neighbour's place", () => {
    expect(rule(".grid > .row[data-dragging]")).toMatch(/translate\(var\(--drag-dx, 0px\), var\(--drag-dy, 0px\)\)/);
    expect(rule('.grid > .row[data-shift="up"]')).toMatch(/translate\(var\(--to-prev-x, 0px\), var\(--to-prev-y, 0px\)\)/);
    expect(rule('.grid > .row[data-shift="down"]')).toMatch(/translate\(var\(--to-next-x, 0px\), var\(--to-next-y, 0px\)\)/);
  });

  it("the announcement is for the screen reader only", () => {
    expect(rule(".live")).toMatch(/position:\s*absolute;/);
    expect(rule(".live")).toMatch(/clip:\s*rect\(0,\s*0,\s*0,\s*0\);/);
  });
});

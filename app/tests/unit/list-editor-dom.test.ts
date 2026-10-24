// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListEditor } from "@/components/admin/ListEditor";
import { UndoProvider } from "@/components/admin/UndoBar";
import type { I18n } from "@/i18n/field";

// ListEditor (admin UX pass piece 3a, Task 8; README B2 "List editors: drag + ↑/↓, removal with UndoBar, errors keyed by row id"; piece 3 texts
// S3-P3-d, S3-P3-m): a row has its handle „⋮⋮“ and ↑ / ↓ (DragList), × removes it at once with the UndoBar „Rida eemaldatud.“, and „Võta tagasi“
// puts it back at its place with its key (BEH B5: a client restore, then the part's autosave). A row's key is the editor's own (a JSON row has no
// id): kept for as long as the editor is on the page, through moves, typing and an undo.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS: I18n[] = [{ et: "Oskab mõõta" }, { et: "Oskab värvida" }, { et: "Oskab hooldada" }];

let container: HTMLDivElement;
let root: Root;
let current: I18n[] = [];
/** The changes of the rows the editor asked for through `onUpdate` (a move, a removal, an undo): each one is a save of the card. */
const updates = vi.fn();
let mounts = 0;
let restoreRect: () => void = () => {};

type Opts = { unpublished?: boolean; valueOnly?: boolean; error?: string };
/** The page around the editor: the card's list, changed by the editor's typing (`onChange`) and by its row changes (`onUpdate`, the card's update). */
function Harness({ initial, unpublished, valueOnly, error }: { initial: I18n[] } & Opts) {
  const [items, setItems] = useState(initial);
  useEffect(() => {
    current = items; // (not during the render: react-hooks/globals; act() flushes the effect)
  }, [items]);
  return createElement(ListEditor, {
    title: "Õpiväljundid",
    itemLabel: "Õpiväljund",
    items,
    name: "outcomes",
    error,
    unpublished,
    onChange: setItems,
    // (Praktika's lists have no update of their own: the editor works the change out from the list it last saw)
    onUpdate: valueOnly
      ? undefined
      : (fn: (list: I18n[]) => I18n[]) => {
          updates();
          setItems((list) => fn(list));
        },
  });
}
const render = async (initial: I18n[] = ITEMS, opts: Opts = {}) =>
  act(async () => root.render(createElement(UndoProvider, null, createElement(Harness, { key: ++mounts, initial, ...opts }))));
const $ = <T extends Element = HTMLElement>(selector: string) => container.querySelector<T>(selector);
const $$ = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
};
const button = (name: string) => $$("button").find((b) => b.getAttribute("aria-label") === name || text(b) === name) ?? null;
const type = async (el: Element | null, value: string) =>
  act(async () => {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
/** Each row's key (DragList's li, data-drag-row) and its Estonian text, in the order on screen. */
const rows = () => $$("[data-drag-row]").map((li) => [li.getAttribute("data-drag-row"), li.querySelector<HTMLInputElement>("[data-lang-field]")!.value]);
const fieldOf = (n: number) => $<HTMLElement>(`[data-row="${n}"] [data-lang-field]`);
const bar = () => document.querySelector<HTMLElement>("[data-undo-bar]");
const live = () => $("[data-drag-list] + [role=status]");

beforeEach(() => {
  updates.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restoreRect();
  restoreRect = () => {};
});

describe("ListEditor: drag and arrows (DragList)", () => {
  it("each row has its handle „Lohista rida {n}“ („lohistatav“), ↑ / ↓ „Liiguta rida {n} üles / alla“ (aria-disabled at the ends) and × „Eemalda rida {n}“", async () => {
    await render();
    expect($$("[data-drag-row]")).toHaveLength(3);
    const handle = $('[data-row="1"] [data-drag-tool="handle"]')!;
    expect(handle.getAttribute("aria-label")).toBe("Lohista rida 2");
    expect(handle.getAttribute("aria-roledescription")).toBe("lohistatav");
    expect($('[data-row="1"] [data-drag-tool="up"]')!.getAttribute("aria-label")).toBe("Liiguta rida 2 üles");
    expect($('[data-row="1"] [data-drag-tool="down"]')!.getAttribute("aria-label")).toBe("Liiguta rida 2 alla");
    expect($('[data-row="0"] [data-drag-tool="up"]')!.getAttribute("aria-disabled")).toBe("true");
    expect($('[data-row="2"] [data-drag-tool="down"]')!.getAttribute("aria-disabled")).toBe("true");
    expect(button("Eemalda rida 2")).not.toBeNull();
    // the row's field is still named by its number, as before
    expect(container.querySelector(`label[for="${fieldOf(1)!.id}"]`)!.textContent).toBe("Õpiväljund 2 (eesti keeles)");
  });

  it("↑ moves the row through the page's update, once; every row keeps its key; the focus stays on ↑ and the move is announced", async () => {
    await render();
    const before = rows();
    await click($('[data-row="1"] [data-drag-tool="up"]'));
    expect(updates).toHaveBeenCalledTimes(1);
    expect(current.map((x) => x.et)).toEqual(["Oskab värvida", "Oskab mõõta", "Oskab hooldada"]);
    expect(rows()).toEqual([before[1], before[0], before[2]]);
    expect(document.activeElement).toBe($('[data-row="0"] [data-drag-tool="up"]'));
    expect(text(live())).toBe("Rida 2 on nüüd 1. kohal.");
  });

  it("a finger on the handle of row 3 dragged to the top: one update, the new order, the keys with their rows", async () => {
    // no layout in happy-dom: a row is 100 px tall and sits at its place among its siblings
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (!this.hasAttribute("data-drag-row")) return original.call(this);
      const top = Array.prototype.indexOf.call(this.parentElement!.children, this) * 100;
      return { top, bottom: top + 100, left: 0, right: 300, width: 300, height: 100, x: 0, y: top, toJSON: () => ({}) };
    };
    restoreRect = () => void (HTMLElement.prototype.getBoundingClientRect = original);
    await render();
    const before = rows();
    const handle = $('[data-row="2"] [data-drag-tool="handle"]')!;
    const pointer = (type: string, clientY: number) =>
      act(async () => void handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", button: 0, isPrimary: true, clientY })));
    await pointer("pointerdown", 250);
    await pointer("pointermove", 40);
    await pointer("pointerup", 40);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(current.map((x) => x.et)).toEqual(["Oskab hooldada", "Oskab mõõta", "Oskab värvida"]);
    expect(rows()).toEqual([before[2], before[0], before[1]]);
  });

  it("typing in a row keeps its key, so its field keeps the focus", async () => {
    await render();
    const before = rows();
    fieldOf(1)!.focus();
    await type(fieldOf(1), "Oskab värvida ja segada");
    expect(rows()).toEqual([before[0], [before[1][0], "Oskab värvida ja segada"], before[2]]);
    expect(document.activeElement).toBe(fieldOf(1));
    expect(updates).toHaveBeenCalledTimes(0); // typing is the card's typed change (onChange), not a row change
  });
});

describe("ListEditor: removal with the UndoBar (S3-P3-d)", () => {
  it("removing outcome 2 shows „Rida eemaldatud.“; „Võta tagasi“ puts it back at index 1 with the same key", async () => {
    await render();
    const before = rows();
    await click(button("Eemalda rida 2"));
    expect(updates).toHaveBeenCalledTimes(1);
    expect(current.map((x) => x.et)).toEqual(["Oskab mõõta", "Oskab hooldada"]);
    expect(rows()).toEqual([before[0], before[2]]);
    expect(text(bar()!.querySelector("p"))).toBe("Rida eemaldatud.");
    // the focus goes on to the next row's field, as before
    expect(document.activeElement).toBe(fieldOf(1));
    await click(bar()!.querySelector("button"));
    expect(updates).toHaveBeenCalledTimes(2);
    expect(current).toEqual(ITEMS);
    expect(rows()).toEqual(before);
    expect(bar()).toBeNull();
  });

  it("the undo puts the row into the list as it is then: rows typed in or moved meanwhile stay as they are", async () => {
    await render();
    const before = rows();
    await click(button("Eemalda rida 1"));
    await type(fieldOf(1), "Oskab hooldada hästi");
    await click($('[data-row="1"] [data-drag-tool="up"]'));
    await click(bar()!.querySelector("button"));
    expect(current.map((x) => x.et)).toEqual(["Oskab mõõta", "Oskab hooldada hästi", "Oskab värvida"]);
    expect(rows().map(([key]) => key)).toEqual([before[0][0], before[2][0], before[1][0]]);
  });

  it("the restored row's field gets the focus (the bar's button is gone)", async () => {
    await render();
    await click(button("Eemalda rida 3"));
    const undo = bar()!.querySelector<HTMLElement>("button")!;
    undo.focus();
    await click(undo);
    expect(document.activeElement).toBe(fieldOf(2));
  });

  it("the last row removed: the focus on „Lisa rida“; the undo brings the list back", async () => {
    await render([{ et: "Ainus" }]);
    const [key] = rows()[0];
    await click(button("Eemalda rida 1"));
    expect(current).toEqual([]);
    expect(document.activeElement).toBe(button("+ Lisa rida"));
    await click(bar()!.querySelector("button"));
    expect(current).toEqual([{ et: "Ainus" }]);
    expect(rows()).toEqual([[key, "Ainus"]]);
  });

  it("a list with no update of its own (Praktika): the change and its undo go through onChange, from the list as it is then", async () => {
    await render(ITEMS, { valueOnly: true });
    const before = rows();
    await click(button("Eemalda rida 2"));
    expect(current.map((x) => x.et)).toEqual(["Oskab mõõta", "Oskab hooldada"]);
    await type(fieldOf(0), "Oskab mõõta täpselt");
    await click(bar()!.querySelector("button"));
    expect(current.map((x) => x.et)).toEqual(["Oskab mõõta täpselt", "Oskab värvida", "Oskab hooldada"]);
    expect(rows().map(([key]) => key)).toEqual(before.map(([key]) => key));
  });

  it("„Lisa rida“ adds a row with a new key, its field focused; the others keep theirs", async () => {
    await render();
    const before = rows();
    await click(button("+ Lisa rida"));
    expect(updates).toHaveBeenCalledTimes(1);
    const after = rows();
    expect(after.slice(0, 3)).toEqual(before);
    expect(new Set(after.map(([key]) => key)).size).toBe(4);
    expect(document.activeElement).toBe(fieldOf(3));
  });
});

describe("ListEditor: „· avaldamata“ (README §1.8)", () => {
  it("a published course's list that waits for „Avalda muudatused“: the tag after its title, the group described by it, the heading's name unchanged", async () => {
    await render(ITEMS, { unpublished: true });
    const group = $("[data-list-editor='outcomes']")!;
    const tag = group.querySelector<HTMLElement>("[data-unpublished-tag]")!;
    expect(text(tag)).toBe("· avaldamata");
    expect(group.getAttribute("aria-describedby")!.split(" ")).toContain(tag.id);
    expect(tag.closest("h3")).not.toBeNull();
    expect(tag.getAttribute("aria-hidden")).toBe("true"); // (the heading names the group: the tag is its description, not its name)
    await render(ITEMS);
    expect($("[data-unpublished-tag]")).toBeNull();
    expect($("[data-list-editor='outcomes']")!.getAttribute("aria-describedby")).toBeNull();
  });
});

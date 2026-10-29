// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
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

type Opts = { unpublished?: boolean; valueOnly?: boolean; error?: string; enterAdds?: boolean; addLabel?: string; rowNames?: boolean; multiline?: boolean };
/** The page around the editor: the card's list, changed by the editor's typing (`onChange`) and by its row changes (`onUpdate`, the card's update). */
function Harness({ initial, unpublished, valueOnly, error, enterAdds, addLabel, rowNames, multiline }: { initial: I18n[] } & Opts) {
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
    enterAdds,
    addLabel,
    rowNames,
    multiline,
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

describe("ListEditor: Enter on the last row adds a row (Praktika's points; ruling R-h, piece4-texts S4-33)", () => {
  /** Enter pressed in `el` (a keydown that bubbles, as the browser sends it); `composing`: the key ends an IME composition. */
  const enter = async (el: Element | null, init: KeyboardEventInit = {}) => {
    expect(el, "the field to press Enter in").not.toBeNull();
    let event: KeyboardEvent | null = null;
    await act(async () => {
      event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
      el!.dispatchEvent(event);
    });
    return event!;
  };

  it("`enterAdds`: Enter in the last row's field adds an empty row after it — one row change, a new key — and the cursor goes into it", async () => {
    await render(ITEMS, { enterAdds: true });
    const before = rows();
    fieldOf(2)!.focus();
    const event = await enter(fieldOf(2));
    expect(updates).toHaveBeenCalledTimes(1);
    expect(current).toEqual([...ITEMS, { et: "" }]);
    const after = rows();
    expect(after.slice(0, 3)).toEqual(before);
    expect(after[3][1]).toBe("");
    expect(new Set(after.map(([key]) => key)).size).toBe(4);
    expect(document.activeElement).toBe(fieldOf(3));
    expect(event.defaultPrevented).toBe(true);
    // the new row is the last one now: Enter in it adds the next
    await enter(fieldOf(3));
    expect(current).toHaveLength(5);
    expect(document.activeElement).toBe(fieldOf(4));
  });

  it("Enter in any other row, an Enter that ends an IME composition, and Shift+Enter add nothing", async () => {
    await render(ITEMS, { enterAdds: true });
    const before = rows();
    fieldOf(0)!.focus();
    expect((await enter(fieldOf(0))).defaultPrevented).toBe(false);
    await enter(fieldOf(1));
    await enter(fieldOf(2), { isComposing: true });
    await enter(fieldOf(2), { shiftKey: true });
    expect(updates).toHaveBeenCalledTimes(0);
    expect(rows()).toEqual(before);
    expect(document.activeElement).toBe(fieldOf(0));
  });

  it("a held Enter adds ONE row: the key's auto-repeats (in the new last row) add nothing and do nothing else (review M-3)", async () => {
    await render(ITEMS, { enterAdds: true });
    fieldOf(2)!.focus();
    await enter(fieldOf(2));
    expect(current).toHaveLength(4);
    expect(document.activeElement).toBe(fieldOf(3));
    // the repeats land in the field that has the cursor now: the new last row
    const repeats = [await enter(fieldOf(3), { repeat: true }), await enter(fieldOf(3), { repeat: true })];
    expect(repeats.map((e) => e.defaultPrevented)).toEqual([true, true]);
    expect(current).toHaveLength(4);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(fieldOf(3));
    // the key let go and pressed again: the next row
    await enter(fieldOf(3));
    expect(current).toHaveLength(5);
  });

  it("without `enterAdds` (the course's lists) Enter in the last row adds nothing", async () => {
    await render();
    const before = rows();
    await enter(fieldOf(2));
    expect(updates).toHaveBeenCalledTimes(0);
    expect(rows()).toEqual(before);
  });

  it("`addLabel` names the add button („+ Lisa punkt (või Enter viimasel real)“); without it, „+ Lisa rida“", async () => {
    await render(ITEMS, { addLabel: "Lisa punkt (või Enter viimasel real)" });
    expect(button("+ Lisa punkt (või Enter viimasel real)")).not.toBeNull();
    expect(button("+ Lisa rida")).toBeNull();
    await render();
    expect(button("+ Lisa rida")).not.toBeNull();
  });

  it("`rowNames`: each row's field is named `<name>.<index>` (data-i18n, the site editors' focus of „Jää siia“ and „Näita“); without it, none", async () => {
    await render(ITEMS, { rowNames: true });
    expect($$("[data-drag-row] [data-lang-field]").map((el) => el.getAttribute("data-i18n"))).toEqual(["outcomes.0", "outcomes.1", "outcomes.2"]);
    await render();
    expect($$("[data-drag-row] [data-lang-field]").map((el) => el.getAttribute("data-i18n"))).toEqual([null, null, null]);
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

describe("ListEditor: rendered on the server, then hydrated (review I-1)", () => {
  it("the rows' keys are the same on the server and in the browser; after hydration ↓ keeps the focus on the moved row", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const recoverable = vi.fn();
    const page = () => createElement(UndoProvider, null, createElement(Harness, { initial: ITEMS }));
    // (other lists rendered by the server before this one: its count of rows is not where a new browser's starts)
    renderToString(createElement(Harness, { initial: ITEMS }));
    const html = renderToString(page());
    const box = document.createElement("div");
    document.body.append(box);
    box.innerHTML = html;
    const keysOf = () => [...box.querySelectorAll<HTMLElement>("[data-drag-row]")].map((li) => li.getAttribute("data-drag-row"));
    const served = keysOf();
    const hydrated = await act(async () => hydrateRoot(box, page(), { onRecoverableError: recoverable }));
    try {
      expect(recoverable).not.toHaveBeenCalled();
      expect(logged.mock.calls.map((c) => String(c[0])).filter((m) => /hydrat|did(n't| not) match/i.test(m))).toEqual([]);
      expect(keysOf()).toEqual(served);
      // ↓ re-inserts the focused row: the focus comes back to its ↓, found by the row's key
      const down = box.querySelector<HTMLElement>('[data-row="0"] [data-drag-tool="down"]')!;
      down.focus();
      await act(async () => down.click());
      expect(current.map((x) => x.et)).toEqual(["Oskab värvida", "Oskab mõõta", "Oskab hooldada"]);
      expect(keysOf()).toEqual([served[1], served[0], served[2]]);
      expect(document.activeElement).toBe(box.querySelector('[data-row="1"] [data-drag-tool="down"]'));
    } finally {
      await act(async () => hydrated.unmount());
      box.remove();
      logged.mockRestore();
    }
  });
});

describe("ListEditor: the bar and the editor that offered it (review M-6)", () => {
  const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

  it("the editor goes (the page is left) and no other of its list takes its place: the bar goes with it", async () => {
    await render();
    await click(button("Eemalda rida 2"));
    expect(bar()).not.toBeNull();
    await act(async () => root.render(createElement(UndoProvider, null, createElement("p", null, "Mujal"))));
    await tick();
    expect(bar()).toBeNull();
  });

  it("the same list's editor takes its place at once (the course editor starting over): the bar stays", async () => {
    await render();
    await click(button("Eemalda rida 2"));
    await render(current); // (a new editor of the same list, in the same commit)
    await tick();
    expect(text(bar()!.querySelector("p"))).toBe("Rida eemaldatud.");
  });
});

describe("ListEditor: a row's field lines up with its handle, number and buttons (admin polish F1, F2)", () => {
  const TRANSLATED: I18n[] = [
    { et: "Oskab mõõta", ru: "Умеет измерять" },
    { et: "Oskab värvida", ru: "Умеет окрашивать" },
  ];
  /** What stands before a row's field in its box: the elements, by tag (a label for screen readers only takes no room). */
  const before = (n: number) => {
    const field = fieldOf(n)!;
    const kids = [...field.closest("[data-i18n-box]")!.children];
    return kids.slice(0, kids.indexOf(field));
  };

  it("with nothing to show over it, no empty head stands before a row's field: only its label for screen readers, which still names it", async () => {
    await render(TRANSLATED);
    for (const n of [0, 1]) {
      expect(before(n).map((el) => el.tagName)).toEqual(["LABEL"]);
      expect(before(n)[0].getAttribute("for")).toBe(fieldOf(n)!.id);
    }
    expect(container.querySelector(`label[for="${fieldOf(1)!.id}"]`)!.textContent).toBe("Õpiväljund 2 (eesti keeles)");
  });

  it("a row whose Russian text is missing keeps „tõlge tulekul“ over its field (the head has something to show then)", async () => {
    await render([{ et: "Oskab mõõta" }, ...TRANSLATED.slice(1)]);
    const head = before(0);
    expect(head).toHaveLength(1);
    expect(text(head[0].querySelector("[data-ru-pending]"))).toBe("tõlge tulekul");
    expect(head[0].querySelector(`label[for="${fieldOf(0)!.id}"]`)).not.toBeNull();
    expect(before(1).map((el) => el.tagName)).toEqual(["LABEL"]);
  });

  it("a multiline row's box grows with its text (GrowingText): its height is the text's, measured again as it is typed", async () => {
    // no layout in happy-dom: a text box's content is 46 px for a short text, 130 px for a long one
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        return this.value.length > 40 ? 130 : 46;
      },
    });
    try {
      await render(TRANSLATED, { multiline: true });
      const box = fieldOf(0) as HTMLTextAreaElement;
      expect(box.tagName).toBe("TEXTAREA");
      expect(box.style.height).toBe("48px");
      await type(box, "Oskab mõõta kulme, valida vormi ja värvi ning selgitada kliendile järelhooldust.");
      expect((fieldOf(0) as HTMLTextAreaElement).style.height).toBe("132px");
    } finally {
      delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });
});

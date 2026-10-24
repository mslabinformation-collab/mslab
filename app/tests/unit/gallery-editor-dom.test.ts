// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GalleryEditor } from "@/components/admin/GalleryEditor";
import { UndoProvider } from "@/components/admin/UndoBar";
import type { DraftImage } from "@/domain/course-editor";

// GalleryEditor (the course's „Galerii“ and the trainer's works; admin UX pass piece 3a, Task 8; README B2 "List editors (outcomes, protocol
// points, gallery, test questions): drag + ↑/↓, removal with UndoBar"; S3-P3-d „Pilt eemaldatud.“, S3-P3-m): a picture is moved with its handle
// „⋮⋮“ (pointer events, so a finger on an iPad drags it too: no HTML drag and drop) or ↑ / ↓, and removed at once with „Võta tagasi“ in the
// UndoBar, which puts it back at its place with its key and its description. Every change is one update function (the card's `update`: the
// list as it is when it lands).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/shrink-image", () => ({ shrinkImage: async (file: File) => file, ShrinkError: class ShrinkError extends Error {} }));

const IMAGES: DraftImage[] = [
  { key: "img/a.jpg", alt: { et: "Esimene", ru: "Первый" } },
  { key: "img/b.jpg", alt: { et: "Teine" } },
  { key: "img/c.jpg", alt: { et: "Kolmas" } },
];
const ROW = 120; // the height of a picture's row in the faked layout

let container: HTMLDivElement;
let root: Root;
let current: DraftImage[] = [];
/** The update functions the editor handed over: each one is one save of the card's part (an instant change, README §1.3). */
const updates = vi.fn();
let restoreRect: () => void;

function Harness({ initial }: { initial: DraftImage[] }) {
  const [images, setImages] = useState(initial);
  useEffect(() => {
    current = images; // (not during the render: react-hooks/globals; act() flushes the effect)
  }, [images]);
  return createElement(GalleryEditor, {
    images,
    onChange: (fn: (list: DraftImage[]) => DraftImage[]) => {
      updates();
      setImages((list) => fn(list));
    },
  });
}
const render = (initial: DraftImage[] = IMAGES) => act(async () => root.render(createElement(UndoProvider, null, createElement(Harness, { initial }))));
const $ = <T extends Element = HTMLElement>(selector: string) => container.querySelector<T>(selector);
const $$ = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
};
const order = () => $$("[data-gallery-item]").map((el) => el.getAttribute("data-gallery-item"));
const bar = () => document.querySelector<HTMLElement>("[data-undo-bar]");
const handleOf = (n: number) => $$("[data-gallery-item]")[n].querySelector<HTMLElement>('[data-drag-tool="handle"]')!;
const pointer = (el: Element, type: string, clientY: number) =>
  act(async () => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", button: 0, isPrimary: true, clientY })));

beforeEach(() => {
  updates.mockClear();
  // no layout in happy-dom: a row is ROW px tall and sits at its place among its siblings
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (!this.hasAttribute("data-drag-row")) return original.call(this);
    const top = Array.prototype.indexOf.call(this.parentElement!.children, this) * ROW;
    return { top, bottom: top + ROW, left: 0, right: 600, width: 600, height: ROW, x: 0, y: top, toJSON: () => ({}) };
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
});

describe("GalleryEditor: drag and arrows", () => {
  it("each picture has its handle „Lohista rida {n}“ and ↑ / ↓ (no HTML drag and drop: a finger on an iPad drags the handle)", async () => {
    await render();
    expect($$("[data-gallery-item]")).toHaveLength(3);
    expect(handleOf(2).getAttribute("aria-label")).toBe("Lohista rida 3");
    expect(handleOf(2).getAttribute("aria-roledescription")).toBe("lohistatav");
    const third = $$("[data-gallery-item]")[2];
    expect(third.querySelector('[data-drag-tool="up"]')!.getAttribute("aria-label")).toBe("Liiguta rida 3 üles");
    expect(third.querySelector('[data-drag-tool="down"]')!.getAttribute("aria-disabled")).toBe("true");
    expect(third.querySelector('[data-tool="remove"]')!.getAttribute("aria-label")).toBe("Eemalda pilt 3");
    expect(container.querySelector("[draggable='true']")).toBeNull();
    // the first picture is the main one
    expect(text($$("[data-gallery-item]")[0])).toContain("Põhipilt");
  });

  it("dragging picture 3 to the top saves the new order once; it is the main picture now", async () => {
    await render();
    await pointer(handleOf(2), "pointerdown", 2 * ROW + 20);
    await pointer(handleOf(2), "pointermove", 10);
    await pointer(handleOf(2), "pointerup", 10);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(current.map((x) => x.key)).toEqual(["img/c.jpg", "img/a.jpg", "img/b.jpg"]);
    expect(order()).toEqual(["img/c.jpg", "img/a.jpg", "img/b.jpg"]);
    expect(text($$("[data-gallery-item]")[0])).toContain("Põhipilt");
    expect(text($("[data-drag-list] + [role=status]"))).toBe("Rida 3 on nüüd 1. kohal.");
  });

  it("↑ moves a picture once, the focus staying on ↑", async () => {
    await render();
    await click($$("[data-gallery-item]")[1].querySelector('[data-drag-tool="up"]'));
    expect(updates).toHaveBeenCalledTimes(1);
    expect(order()).toEqual(["img/b.jpg", "img/a.jpg", "img/c.jpg"]);
    expect(document.activeElement).toBe($$("[data-gallery-item]")[0].querySelector('[data-drag-tool="up"]'));
  });
});

describe("GalleryEditor: removal with the UndoBar („Pilt eemaldatud.“)", () => {
  it("× takes the picture out at once; „Võta tagasi“ puts it back at its place with its key and its description", async () => {
    await render();
    await click($('[aria-label="Eemalda pilt 2"]'));
    expect(updates).toHaveBeenCalledTimes(1);
    expect(order()).toEqual(["img/a.jpg", "img/c.jpg"]);
    expect(text(bar()!.querySelector("p"))).toBe("Pilt eemaldatud.");
    // the next picture's × has the focus, as before
    expect(document.activeElement).toBe($('[aria-label="Eemalda pilt 2"]'));
    await click(bar()!.querySelector("button"));
    expect(updates).toHaveBeenCalledTimes(2);
    expect(current).toEqual(IMAGES);
    expect(order()).toEqual(["img/a.jpg", "img/b.jpg", "img/c.jpg"]);
    expect(bar()).toBeNull();
  });

  it("the undo goes into the list as it is then: a description typed meanwhile and a picture moved meanwhile stay as they are", async () => {
    await render();
    await click($('[aria-label="Eemalda pilt 1"]'));
    await click($$("[data-gallery-item]")[1].querySelector('[data-drag-tool="up"]'));
    await click(bar()!.querySelector("button"));
    expect(order()).toEqual(["img/a.jpg", "img/c.jpg", "img/b.jpg"]);
    expect(current[0]).toEqual(IMAGES[0]);
  });
});

// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GalleryEditor } from "@/components/admin/GalleryEditor";
import { UndoProvider } from "@/components/admin/UndoBar";
import type { DraftImage } from "@/domain/course-editor";
import { stubFetch } from "../fakes";

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

/** `twist`: each update lands on a list whose descriptions changed meanwhile (the form on screen after the cards started over, say). */
function Harness({ initial, twist, layout }: { initial: DraftImage[]; twist?: boolean; layout?: "list" | "grid" }) {
  const [images, setImages] = useState(initial);
  useEffect(() => {
    current = images; // (not during the render: react-hooks/globals; act() flushes the effect)
  }, [images]);
  return createElement(GalleryEditor, {
    images,
    layout,
    onChange: (fn: (list: DraftImage[]) => DraftImage[]) => {
      updates();
      setImages((list) => fn(twist ? list.map((x) => ({ ...x, alt: { et: `${x.alt.et}!` } })) : list));
    },
  });
}
const render = (initial: DraftImage[] = IMAGES, twist = false, layout?: "list" | "grid") =>
  act(async () => root.render(createElement(UndoProvider, null, createElement(Harness, { initial, twist, layout }))));
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
    // the arrows keep the pictures' own words (review M-1)
    expect(third.querySelector('[data-drag-tool="up"]')!.getAttribute("aria-label")).toBe("Liiguta pilt 3 ettepoole");
    expect($$("[data-gallery-item]")[0].querySelector('[data-drag-tool="down"]')!.getAttribute("aria-label")).toBe("Liiguta pilt 1 tahapoole");
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

describe("GalleryEditor: a picture is known by its key (review M-5)", () => {
  it("the removal lands on a list whose descriptions changed meanwhile: the picture is taken out all the same, by its key", async () => {
    await render(IMAGES, true);
    await click($('[aria-label="Eemalda pilt 2"]'));
    expect(current.map((x) => x.key)).toEqual(["img/a.jpg", "img/c.jpg"]);
  });
});

// R-g (piece 4a, Task 5): Koolitaja's gallery is the same editor drawn as a grid of tiles (the Part 4 C2 frame: 120 px tiles, each with a 32 px round ✕
// at its corner, then a „+ Lisa“ tile). The course's gallery keeps its rows (the cases above, unchanged).
describe("GalleryEditor layout „grid“ (Koolitaja, R-g)", () => {
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    });
  /** The faked layout of a grid of three columns: a tile 150 px wide and 120 px tall, row after row. */
  const gridRects = () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (!this.hasAttribute("data-drag-row")) return original.call(this);
      const i = Array.prototype.filter.call(this.parentElement!.children, (el: Element) => el.hasAttribute("data-drag-row")).indexOf(this);
      const left = (i % 3) * 150;
      const top = Math.floor(i / 3) * 120;
      return { top, bottom: top + 120, left, right: left + 150, width: 150, height: 120, x: left, y: top, toJSON: () => ({}) };
    };
  };
  const pointerAt = (el: Element, type: string, clientX: number, clientY: number) =>
    act(async () => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true, clientX, clientY })));

  it("each picture is a tile: the picture, its handle, ✕ „Eemalda pilt {n}“ and ↑ / ↓ in the gallery's words, its description under it; no „Põhipilt“; the last cell is „+ Lisa“", async () => {
    await render(IMAGES, false, "grid");
    expect(order()).toEqual(["img/a.jpg", "img/b.jpg", "img/c.jpg"]);
    const second = $$("[data-gallery-item]")[1];
    expect(second.querySelector("img")!.getAttribute("src")).toBe("/media/img/b.jpg");
    expect(second.querySelector('[data-drag-tool="handle"]')!.getAttribute("aria-label")).toBe("Lohista rida 2");
    expect(second.querySelector('[data-tool="remove"]')!.getAttribute("aria-label")).toBe("Eemalda pilt 2");
    expect(text(second.querySelector('[data-tool="remove"]'))).toBe("✕");
    expect(second.querySelector('[data-drag-tool="up"]')!.getAttribute("aria-label")).toBe("Liiguta pilt 2 ettepoole");
    expect(second.querySelector('[data-drag-tool="down"]')!.getAttribute("aria-label")).toBe("Liiguta pilt 2 tahapoole");
    // the picture's description (builder notes §5): the list's field and words, its name hidden and its placeholder
    const alt = second.querySelector<HTMLInputElement>("[data-i18n-box] input")!;
    expect(alt.value).toBe("Teine");
    expect(text(container.querySelector(`label[for="${alt.id}"]`))).toBe("Pildi kirjeldus (eesti keeles)");
    expect(alt.getAttribute("placeholder")).toBe("Pildi kirjeldus");
    expect(alt.getAttribute("data-i18n")).toBe("image-1");
    expect(text($("[data-gallery-editor]"))).not.toContain("Põhipilt");
    // the „+ Lisa“ tile is the list's last cell, no picture's row (a drag never lands on it) and no item a screen reader counts
    const cells = $$("[data-drag-list] > li");
    expect(cells.at(-1)!.querySelector("[data-gallery-add]")).not.toBeNull();
    expect(cells.at(-1)!.hasAttribute("data-drag-row")).toBe(false);
    expect(cells.at(-1)!.getAttribute("role")).toBe("presentation");
    expect($("[data-image-upload]")).toBeNull();
  });

  it("a tile dragged across its row to the third place is moved there once (the place nearest in both directions)", async () => {
    gridRects();
    await render(IMAGES, false, "grid");
    const handle = $$("[data-gallery-item]")[0].querySelector<HTMLElement>('[data-drag-tool="handle"]')!;
    await pointerAt(handle, "pointerdown", 20, 20);
    await pointerAt(handle, "pointermove", 320, 25);
    await pointerAt(handle, "pointerup", 320, 25);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(order()).toEqual(["img/b.jpg", "img/c.jpg", "img/a.jpg"]);
  });

  it("„+ Lisa“ uploads the pictures picked, each added at the end at once; the upload's words stand under the grid", async () => {
    const fetched = stubFetch((url) => (url === "/api/admin/upload" ? Response.json({ ok: true, key: "img/uus.jpg" }) : Response.json({}, { status: 404 })));
    try {
      await render(IMAGES, false, "grid");
      const input = $<HTMLInputElement>('[data-gallery-add] input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "uus.jpg", { type: "image/jpeg" })] });
      await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
      await settle();
      expect(order()).toEqual(["img/a.jpg", "img/b.jpg", "img/c.jpg", "img/uus.jpg"]);
      expect(current.at(-1)).toEqual({ key: "img/uus.jpg", alt: { et: "" } });
      const status = $("[data-upload-status]")!;
      expect(text(status)).toBe("Pilt lisatud.");
      // the words are under the grid, and the field's description points at them
      expect($("[data-drag-list]")!.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(input.getAttribute("aria-describedby")!.split(" ")).toContain(status.id);
    } finally {
      fetched.restore();
    }
  });

  it("the list layout (the course's) is unchanged: rows with descriptions, „Põhipilt“, the upload box „Lisa pilte“, no tile", async () => {
    await render();
    expect($$("[data-gallery-item] [data-i18n-box]")).toHaveLength(3);
    expect($("[data-gallery-add]")).toBeNull();
    expect(text($("[data-image-upload] label"))).toBe("Lisa pilte");
  });
});

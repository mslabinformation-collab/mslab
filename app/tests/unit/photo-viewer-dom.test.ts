// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PhotoViewer, SWIPE_PX } from "@/components/admin/PhotoViewer";

// The full-screen photo of Maria's assessment (spec §5.3): a modal dialog with the photo and where it is among the point's photos, the focus on
// its close button and back on the thumbnail after; the arrows, the buttons and a swipe move round; a second finger is the browser's pinch zoom,
// never a swipe; Esc closes.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PHOTOS = [11, 12, 13].map((id) => ({ id, round: 1, width: 1600, height: 1200 }));
let container: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;
const closed = vi.fn();
const $ = (selector: string) => container.querySelector(selector);

/** The viewer as the screen holds it: open from `start` until it asks to close. */
function Harness({ photos, start }: { photos: typeof PHOTOS; start: number }) {
  const [index, setIndex] = useState<number | null>(start);
  if (index === null) return null;
  return createElement(PhotoViewer, {
    photos,
    index,
    onIndex: setIndex,
    onClose: () => {
      closed();
      setIndex(null);
    },
    label: "Punkt 1: Ettevalmistus",
    returnTo: opener,
  });
}
const show = (photos: typeof PHOTOS, start: number) => act(async () => root.render(createElement(Harness, { photos, start })));
const key = (name: string) => act(async () => void $("[data-photo-viewer]")!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
const click = (selector: string) => act(async () => ($(selector) as HTMLElement).click());
const src = () => $("[data-photo-viewer] img")!.getAttribute("src");
const count = () => $("[data-viewer-count]")!.textContent;
/** Pointer events on the photo: [pointer id, x, "down" | "up"] in order. */
const swipe = (steps: [number, number, "down" | "up"][]) =>
  act(async () => {
    const frame = $("[data-viewer-frame]")!;
    for (const [id, x, kind] of steps) frame.dispatchEvent(new PointerEvent(`pointer${kind}`, { bubbles: true, pointerId: id, clientX: x }));
  });

beforeEach(() => {
  closed.mockReset();
  opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  opener.remove();
});

test("a modal dialog with the full photo and where it is, the focus on its close button; →, ← and the buttons go round; Esc closes, and the focus goes back to the thumbnail", async () => {
  await show(PHOTOS, 1);
  const dialog = $("[data-photo-viewer]") as HTMLDialogElement;
  expect([dialog.tagName, dialog.open, dialog.getAttribute("aria-label")]).toEqual(["DIALOG", true, "Punkt 1: Ettevalmistus"]);
  expect([src(), count()]).toEqual(["/api/admin/foto/12", "2 / 3"]);
  expect($("[data-photo-viewer] img")!.getAttribute("alt")).toBe("Punkt 1: Ettevalmistus, foto 2");
  expect(document.activeElement).toBe($("[data-viewer-close]"));
  expect(document.documentElement.style.overflow).toBe("hidden");
  await key("ArrowRight");
  expect([src(), count()]).toEqual(["/api/admin/foto/13", "3 / 3"]);
  await key("ArrowRight");
  expect(count()).toBe("1 / 3");
  await click("[data-viewer-prev]");
  expect(count()).toBe("3 / 3");
  await click("[data-viewer-next]");
  expect(count()).toBe("1 / 3");
  await key("Escape");
  expect(closed).toHaveBeenCalledTimes(1);
  expect($("[data-photo-viewer]")).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.documentElement.style.overflow).toBe("");
});

test("a swipe of 50 px or more goes to the next or the previous photo; a shorter one does not, nor one with a second finger down (the browser's pinch zoom)", async () => {
  await show(PHOTOS, 0);
  await swipe([[1, 300, "down"], [1, 300 - SWIPE_PX, "up"]]);
  expect(count()).toBe("2 / 3");
  await swipe([[1, 300, "down"], [1, 300 + SWIPE_PX, "up"]]);
  expect(count()).toBe("1 / 3");
  await swipe([[1, 300, "down"], [1, 270, "up"]]);
  expect(count()).toBe("1 / 3");
  await swipe([[1, 300, "down"], [2, 340, "down"], [1, 150, "up"], [2, 420, "up"]]);
  expect(count()).toBe("1 / 3");
  await swipe([[1, 300, "down"], [1, 200, "up"]]); // after the pinch, one finger swipes again
  expect(count()).toBe("2 / 3");
});

test("one photo: no previous or next, and the arrows and a swipe do nothing", async () => {
  await show(PHOTOS.slice(0, 1), 0);
  expect([$("[data-viewer-prev]"), $("[data-viewer-next]")]).toEqual([null, null]);
  await key("ArrowRight");
  await swipe([[1, 300, "down"], [1, 100, "up"]]);
  expect(count()).toBe("1 / 1");
});

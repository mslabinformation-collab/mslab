// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ReadyMark } from "@/components/admin/ReadyMark";

// html[data-admin-ready] (admin UX pass, Task 2): the e2e tests wait for it before typing into an editor. The shell is in the (panel)
// layout now and loading.tsx puts a Suspense boundary round the page, which React hydrates after the layout, so the mark waits for the
// page's own first element to be React's (it has the fiber React puts on a node it has hydrated). The page here is plain DOM: no fiber
// until the test gives it one.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const marked = () => document.documentElement.dataset.adminReady === "1";
const takeOver = (el: Element) => Object.assign(el, { ["__reactFiber$test"]: {} });
const tick = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

/** <main id="main"> with the shell's top line, then the given children (the page). */
function main(...children: Element[]) {
  const m = document.createElement("main");
  m.id = "main";
  const top = document.createElement("div");
  top.setAttribute("data-admin-top", "");
  m.append(top, ...children);
  document.body.append(m);
  return m;
}
const el = (tag: string, attrs: Record<string, string> = {}) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const mount = () => act(async () => root.render(createElement(ReadyMark)));

beforeEach(() => {
  vi.useFakeTimers();
  delete document.documentElement.dataset.adminReady;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("ReadyMark", () => {
  test("a page that React has already taken over: marked at once", async () => {
    main(takeOver(el("div")));
    await mount();
    expect(marked()).toBe(true);
  });

  test("a page that is still the server's HTML: not marked until React takes it over", async () => {
    const page = el("div");
    main(page);
    await mount();
    expect(marked()).toBe(false);
    await tick(500);
    expect(marked()).toBe(false);
    takeOver(page);
    await tick(40);
    expect(marked()).toBe(true);
  });

  test("the shell's own top line, scripts and the loading rows do not count as the page", async () => {
    const loading = takeOver(el("div", { "data-panel-loading": "" }));
    const script = takeOver(el("script"));
    const m = main(script, loading);
    // the top line is React's (the layout hydrated first), the page is not there yet
    takeOver(m.querySelector("[data-admin-top]")!);
    await mount();
    expect(marked()).toBe(false);
    const page = takeOver(el("section"));
    m.append(page);
    await tick(40);
    expect(marked()).toBe(true);
  });

  test("the undo bar's status region (the layout's, hydrated with the shell, in <main> after the page) does not count as the page either", async () => {
    // UndoProvider renders its region next to the page from the first paint: while the page's Suspense boundary is still the loading rows,
    // the region is the only React-made element in <main>, and it must not be taken for the page
    const loading = takeOver(el("div", { "data-panel-loading": "" }));
    const region = takeOver(el("div", { "data-undo-region": "", role: "status" }));
    const m = main(loading, region);
    takeOver(m.querySelector("[data-admin-top]")!);
    await mount();
    await tick(500);
    expect(marked()).toBe(false);
    // the page arrives (before the region in the document) and is taken over
    const page = takeOver(el("section"));
    loading.replaceWith(page);
    await tick(40);
    expect(marked()).toBe(true);
  });

  test("gives up after 10 s, so a page with nothing React-made in it cannot keep a test waiting for ever", async () => {
    main(el("div"));
    await mount();
    await tick(9_900);
    expect(marked()).toBe(false);
    await tick(200);
    expect(marked()).toBe(true);
  });

  test("stops looking when it is unmounted", async () => {
    main(el("div"));
    await mount();
    await act(async () => root.unmount());
    await tick(11_000);
    expect(marked()).toBe(false);
    root = createRoot(host); // for afterEach
  });
});

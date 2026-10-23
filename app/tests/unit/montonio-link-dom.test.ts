// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MontonioLink } from "@/components/admin/MontonioLink";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";

// „Montonios ↗“ (admin UX pass, piece 2, A6 Maksed; Dim 22.10): Montonio has no page for one order, so the link opens the Partner System (a new tab)
// and copies the order id at the same press; a polite status line „Montonio id kopeeritud.“ says so. If the clipboard is refused (or there is none),
// the link still opens and says nothing untrue; the id stays readable in the link's title.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PARTNER = "https://sandbox-partner.montonio.com";
const UUID = "9c1f6d1a-6a53-4c0e-8f1e-4f0b0f3a1b2c";

let container: HTMLDivElement;
let root: Root;

const NAME = "Kati Tamm";
const draw = () => act(async () => root.render(createElement(MontonioLink, { href: PARTNER, uuid: UUID, name: NAME })));
const link = () => container.querySelector("a")!;
const status = () => container.querySelector<HTMLElement>("[role=status]")!;
/** A primary-button click on the link, as the browser makes it; `defaultPrevented` tells whether anything stopped the link from opening. */
async function press(): Promise<boolean> {
  let stopped = false;
  // the last listener to see the click, after the component's own: here the browser would follow the link; happy-dom must not (it would fetch the page)
  const last = (e: Event) => {
    stopped = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener("click", last);
  await act(async () => void link().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
  document.removeEventListener("click", last);
  return stopped;
}
/** `navigator.clipboard.writeText` as `impl` answers it (the property is read-only in the browser's own object: defined anew here). */
const clipboard = (impl: ((text: string) => Promise<void>) | undefined) =>
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: impl ? { writeText: impl } : undefined });

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MontonioLink", () => {
  it("opens the Partner System in a new tab, safely, and keeps the order id readable in the title", async () => {
    clipboard(undefined);
    await draw();
    expect(link().textContent).toBe(`${adminEt.payments.montonio} ↗`);
    expect(link().textContent).toBe("Montonios ↗");
    expect(link().getAttribute("href")).toBe(PARTNER);
    expect(link().getAttribute("target")).toBe("_blank");
    expect(link().getAttribute("rel")).toBe("noopener");
    expect(link().getAttribute("title")).toBe(UUID);
    expect(link().hasAttribute("data-montonio-link")).toBe(true);
  });

  it("the arrow is decoration; the link's name is its visible words and the payer's, so fifty of them on a page tell one from another", async () => {
    clipboard(undefined);
    await draw();
    expect(link().querySelector("[aria-hidden=true]")!.textContent).toBe("↗");
    expect(link().getAttribute("aria-label")).toBe("Montonios ↗ — Kati Tamm");
    expect(link().getAttribute("aria-label")).toBe(fill(adminEt.payments.montonioFor, { name: NAME }));
    expect(link().getAttribute("aria-label")!.startsWith(link().textContent!)).toBe(true); // (the visible text is the start of the name)
  });

  it("one press copies the order id and the link still opens (the press is not stopped); „Montonio id kopeeritud.“ is said politely", async () => {
    const copied: string[] = [];
    clipboard(async (text) => void copied.push(text));
    await draw();
    // the status line is there before anything is said, so a screen reader hears what is put into it
    expect(status().getAttribute("aria-live")).toBe("polite");
    expect(status().textContent).toBe("");
    expect(await press()).toBe(false);
    expect(copied).toEqual([UUID]);
    expect(status().textContent).toBe("Montonio id kopeeritud.");
    expect(status().textContent).toBe(adminEt.payments.montonioCopied);
  });

  it("a middle-click (it opens the tab too) copies the order id as well; the right button does not", async () => {
    const copied: string[] = [];
    clipboard(async (text) => void copied.push(text));
    await draw();
    const aux = (button: number) => act(async () => void link().dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button })));
    await aux(2);
    expect(copied).toEqual([]);
    expect(status().textContent).toBe("");
    await aux(1);
    expect(copied).toEqual([UUID]);
    expect(status().textContent).toBe("Montonio id kopeeritud.");
  });

  it("the empty status line stays in the page (a region that appears already filled is announced unreliably): its stylesheet never hides it", () => {
    const css = readFileSync(join(process.cwd(), "src/components/admin/MontonioLink.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/display:\s*none/);
    expect(css).toMatch(/\.copied:empty\s*\{\s*margin:\s*0;?\s*\}/);
  });

  it("the line goes away by itself, and comes again with the next press", async () => {
    clipboard(async () => {});
    await draw();
    await press();
    expect(status().textContent).toBe("Montonio id kopeeritud.");
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(status().textContent).toBe("");
    await press();
    expect(status().textContent).toBe("Montonio id kopeeritud.");
  });

  it("a clipboard that refuses: the link still opens, nothing is said that did not happen, the id is still in the title", async () => {
    clipboard(() => Promise.reject(new Error("NotAllowedError")));
    await draw();
    expect(await press()).toBe(false);
    expect(status().textContent).toBe("");
    expect(link().getAttribute("title")).toBe(UUID);
  });

  it("a clipboard that throws at once, or an old browser with none: the same", async () => {
    clipboard(() => {
      throw new Error("SecurityError");
    });
    await draw();
    expect(await press()).toBe(false);
    expect(status().textContent).toBe("");
    clipboard(undefined);
    expect(await press()).toBe(false);
    expect(status().textContent).toBe("");
  });

  it("a press that comes after the copy answered late says it once, and nothing is left running when the row goes (no timer, no update after unmount)", async () => {
    let resolve!: () => void;
    clipboard(() => new Promise<void>((r) => (resolve = r)));
    await draw();
    await press();
    expect(status().textContent).toBe("");
    await act(async () => resolve());
    expect(status().textContent).toBe("Montonio id kopeeritud.");
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});

// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFootBar } from "@/components/admin/foot-bar";
import { PublishBar } from "@/components/admin/PublishBar";

// The UndoBar and a bottom bar on a phone (Task 8 review M-2): the UndoBar never covers the bottom bar's button (the phone's PublishBar with
// „Avalda“, a letter's send buttons; a site editor's sticky SaveBar until piece 4b). While such a bar stands at the foot of the screen (fixed or
// sticky to the bottom, which its stylesheet decides per width), it sets the page's --admin-foot to its height, and the UndoBar's region stands that
// much higher. No :has() (iOS 15.0–15.3 lacks it). happy-dom loads no stylesheet, so the bars' computed position is given here.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
/** How each bar stands, by its data hook: fixed or sticky to the bottom (its height), or in the page's flow. */
let placed: Record<string, { position: string; height: number }> = {};
const foot = () => document.documentElement.style.getPropertyValue("--admin-foot");

const publishBar = () => createElement(PublishBar, { changed: ["Hind"], previewHref: "/api/admin/eelvaade?tee=%2Fkoolitused", onDiscard: async () => {}, onPublish: async () => {} });
/** A bar of the test's own on useFootBar (foot-bar.ts), for the hook's sticky case (the site editors' sticky SaveBar went in piece 4b). */
function StickyBar() {
  return createElement("div", { ref: useFootBar(), "data-sticky-bar": "" });
}
const stickyBar = () => createElement(StickyBar);

beforeEach(() => {
  placed = {};
  const style = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
    const hook = Object.keys(placed).find((h) => el.hasAttribute(h));
    if (!hook) return style(el);
    return { ...style(el), position: placed[hook].position, bottom: "0px", getPropertyValue: (n: string) => style(el).getPropertyValue(n) } as CSSStyleDeclaration;
  });
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const hook = Object.keys(placed).find((h) => this.hasAttribute(h));
    if (!hook) return rect.call(this);
    const h = placed[hook].height;
    return { top: 812 - h, bottom: 812, left: 0, right: 375, width: 375, height: h, x: 0, y: 812 - h, toJSON: () => ({}) };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("--admin-foot");
});

describe("a bottom bar tells the UndoBar its height (--admin-foot)", () => {
  it("the phone's PublishBar, fixed at the foot: --admin-foot is its height while it is there, and goes with it", async () => {
    placed = { "data-publish-bar": { position: "fixed", height: 76.4 } };
    await act(async () => root.render(publishBar()));
    expect(foot()).toBe("77px");
    await act(async () => root.render(createElement(Fragment)));
    expect(foot()).toBe("");
  });

  it("a bar sticky at the foot: the same", async () => {
    placed = { "data-sticky-bar": { position: "sticky", height: 92 } };
    await act(async () => root.render(stickyBar()));
    expect(foot()).toBe("92px");
  });

  it("the desktop's PublishBar, in the page's flow under the H1: no foot", async () => {
    placed = { "data-publish-bar": { position: "static", height: 70 } };
    await act(async () => root.render(publishBar()));
    expect(foot()).toBe("");
  });

  it("two bars at the foot: the taller one counts, and the other's going leaves it", async () => {
    placed = { "data-publish-bar": { position: "fixed", height: 76 }, "data-sticky-bar": { position: "sticky", height: 92 } };
    await act(async () => root.render(createElement(Fragment, null, publishBar(), stickyBar())));
    expect(foot()).toBe("92px");
    await act(async () => root.render(createElement(Fragment, null, publishBar())));
    expect(foot()).toBe("76px");
  });

  it("the UndoBar's region stands --admin-foot above the screen's foot (the safe area when there is no bar), 16 px over it as before", () => {
    const css = readFileSync(join(process.cwd(), "src", "components", "admin", "UndoBar.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const region = css.match(/\.region\s*\{([^}]*)\}/)![1];
    expect(region).toMatch(/bottom:\s*calc\(16px \+ var\(--admin-foot, env\(safe-area-inset-bottom, 0px\)\)\);/);
    expect(css).not.toContain(":has(");
  });
});

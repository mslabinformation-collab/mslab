// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TabPills } from "@/components/admin/TabPills";

// TabPills (the A screens, Task 1; the prototype's „Maksed“ | „Arved“ and the Päringud tabs): a nav of pill links, each tab its own address; the
// current one has aria-current="page" (the shared pill style turns it dark). A count bubble follows the label when the tab has one.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
type Props = Parameters<typeof TabPills>[0];
const TABS: Props["tabs"] = [
  { href: "/admin/maksed", label: "Maksed", current: false },
  { href: "/admin/arved", label: "Arved", current: true },
];
const draw = (over: Partial<Props> = {}) => act(async () => root.render(createElement(TabPills, { label: "Maksed ja arved", tabs: TABS, ...over })));
const links = () => Array.from(container.querySelectorAll<HTMLAnchorElement>("nav a"));

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("TabPills", () => {
  it("is a nav named by its label, with one link per tab, each to its own address", async () => {
    await draw();
    const nav = container.querySelector("nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Maksed ja arved");
    expect(links().map((a) => [a.getAttribute("href"), a.textContent])).toEqual([
      ["/admin/maksed", "Maksed"],
      ["/admin/arved", "Arved"],
    ]);
  });

  it("the current tab has aria-current=page; the others have none", async () => {
    await draw();
    expect(links().map((a) => a.getAttribute("aria-current"))).toEqual([null, "page"]);
    await draw({ tabs: [{ ...TABS[0], current: true }, { ...TABS[1], current: false }] });
    expect(links().map((a) => a.getAttribute("aria-current"))).toEqual(["page", null]);
  });

  it("the tabs are the shared pills (the same look as the toolbar's)", async () => {
    await draw();
    for (const a of links()) expect(a.className).toMatch(/pill/);
  });

  it("counts render after the label when given, in the shared count bubble; none when not given", async () => {
    await draw({
      tabs: [
        { href: "/admin/paringud", label: "Kontakt", count: 4, current: true },
        { href: "/admin/paringud?vaade=ootelist", label: "Ootelist", count: 0, current: false },
        { href: "/admin/paringud?vaade=tehtud", label: "Tehtud", current: false },
      ],
    });
    expect(links().map((a) => a.textContent)).toEqual(["Kontakt4", "Ootelist0", "Tehtud"]);
    const bubbles = container.querySelectorAll("nav a > span");
    expect(Array.from(bubbles).map((s) => s.textContent)).toEqual(["4", "0"]);
    expect(bubbles[0].className).toMatch(/pillCount/);
  });

  it("is plain markup: it renders on the server, the current tab marked in the first HTML", () => {
    const html = renderToString(createElement(TabPills, { label: "Maksed ja arved", tabs: TABS }));
    expect(html).toContain('aria-label="Maksed ja arved"');
    expect(html).toMatch(/<a[^>]*href="\/admin\/arved"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/admin\/arved"/);
  });
});
